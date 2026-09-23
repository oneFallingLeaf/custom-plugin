/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import hybrid from "../tui/token-usage"
import { resolveOptions } from "../tui/token-usage-v1"

const originalFetch = globalThis.fetch
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function frameWith(setup: TestRendererSetup, text: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(5)
  }
  throw new Error(`missing ${text}: ${setup.captureCharFrame()}`)
}

async function mountV1(input: { provider?: string; promptProvider?: string; quota?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "token-usage-v1-"))
  const beforeHome = process.env.CODEX_HOME
  const beforeData = process.env.XDG_DATA_HOME
  const beforeKey = process.env.OPENCODE_API_KEY
  process.env.CODEX_HOME = home
  process.env.XDG_DATA_HOME = home
  if (input.provider === "opencode-go") process.env.OPENCODE_API_KEY = "synthetic-go-key"
  else delete process.env.OPENCODE_API_KEY
  cleanups.push(() => {
    if (beforeHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = beforeHome
    if (beforeData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = beforeData
    if (beforeKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = beforeKey
  })
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "synthetic-v1-token", account_id: "synthetic-account" },
  }))
  const setup = await createTestRenderer({ width: 60, height: 30, useThread: false })
  cleanups.push(() => { if (!setup.renderer.isDestroyed) setup.renderer.destroy() })
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    if (input.provider === "opencode-go") return Response.json({ usage: { rolling: {
      percent: 31, resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
    } } })
    return Response.json({ rate_limit: { primary_window: {
      used_percent: 48, reset_after_seconds: 3600, limit_window_seconds: 86400,
    } } })
  }) as typeof fetch
  let order: number | undefined
  let slot: ((ctx: unknown, props: { session_id: string }) => unknown) | undefined
  const api = {
    app: { version: "1.18.29" },
    theme: { current: { text: "#ffffff", textMuted: "#808080", success: "#00ff00", warning: "#ffff00", error: "#ff0000" } },
    state: { session: {
      get: () => input.provider ? { model: { providerID: input.provider } } : undefined,
      messages: () => [{ role: "assistant", tokens: { input: 1200, output: 300, reasoning: 5, cache: { read: 20, write: 10 } }, cost: 0.25 }],
    } },
    model: { current: () => input.promptProvider ? { providerID: input.promptProvider } : undefined },
    slots: { register: (config: { order: number; slots: { sidebar_content: typeof slot } }) => {
      order = config.order
      slot = config.slots.sidebar_content
      return "v1-slot"
    } },
    renderer: setup.renderer,
  }
  await hybrid.tui(api as unknown as TuiPluginApi, { order: 240.9, showCost: true, showQuota: input.quota !== false }, {} as never)
  if (!slot) throw new Error("V1 sidebar slot was not registered")
  await render(() => slot!({}, { session_id: "ses_v1" }) as never, setup.renderer)
  return { setup, order, requests }
}

test("hybrid V1 tui preserves slot order, session totals, and ChatGPT quota", async () => {
  const h = await mountV1({ provider: "openai" })
  const frame = await frameWith(h.setup, "48%")
  expect(h.order).toBe(240)
  expect(frame).toContain("1 reqs")
  expect(frame).toContain("In 1.2K · Out 300")
  expect(frame).toContain("$0.25")
  expect(frame).toContain("OpenAI")
  expect(frame).toContain("Daily")
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]?.url).toBe("https://chatgpt.com/backend-api/wham/usage")
  expect((h.requests[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer synthetic-v1-token")
  expect(frame).not.toContain("Account may differ from V2")
})

test("hybrid V1 tui renders OpenCode Go quota with the V1 API key fallback", async () => {
  const h = await mountV1({ provider: "opencode-go" })
  const frame = await frameWith(h.setup, "31%")
  expect(frame).toContain("OpenCode Go")
  expect(frame).toContain("5h")
  expect(frame).toContain("In 1.2K · Out 300")
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/usage")
  expect((h.requests[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer synthetic-go-key")
})

test("V1 unsupported session model cannot inherit prompt quota", async () => {
  const h = await mountV1({ provider: "anthropic", promptProvider: "openai" })
  const frame = await frameWith(h.setup, "In 1.2K · Out 300")
  expect(h.order).toBe(240)
  expect(frame).toContain("1 reqs")
  expect(frame).not.toContain("OpenAI")
  expect(h.requests).toEqual([])
  expect(resolveOptions({ order: 0.5 }).order).toBe(110)
})

test("V1 missing session model falls back to prompt provider for quota", async () => {
  const h = await mountV1({ promptProvider: "openai" })
  const frame = await frameWith(h.setup, "48%")
  expect(frame).toContain("OpenAI")
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]?.url).toBe("https://chatgpt.com/backend-api/wham/usage")
})

test("V1 showQuota opt-out keeps usage without credential requests", async () => {
  const h = await mountV1({ provider: "openai", quota: false })
  const frame = await frameWith(h.setup, "In 1.2K · Out 300")
  expect(frame).toContain("1 reqs")
  expect(frame).not.toContain("Daily")
  expect(h.requests).toEqual([])
})
