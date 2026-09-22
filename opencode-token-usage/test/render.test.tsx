/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { type Options } from "../tui/token-usage"

const SESSION = "ses_test"
const originalFetch = globalThis.fetch

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type Usage = {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
}

function assistant(usage: Usage): Message {
  return {
    role: "assistant",
    cost: usage.cost ?? 0,
    tokens: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      reasoning: usage.reasoning ?? 0,
      cache: { read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 },
    },
  } as unknown as AssistantMessage
}

type Slot = (ctx: unknown, props: { session_id: string }) => unknown

type Harness = {
  setup: TestRendererSetup
  fetchCalls: string[]
  registered: boolean
  setProvider: (provider: string | undefined) => void
}

type MountOptions = {
  messages?: Message[]
  provider?: string
  promptModel?: { providerID: string; modelID: string }
  auth?: Record<string, unknown>
  options?: Options
  fetch?: (url: string) => unknown
}

async function mount(h: MountOptions = {}): Promise<Harness> {
  const setup = await createTestRenderer({ width: 60, height: 30, useThread: false })
  cleanups.push(() => {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
  })

  const dataHome = await mkdtemp(join(tmpdir(), "token-usage-test-"))
  cleanups.push(() => rm(dataHome, { recursive: true, force: true }))
  const previousXdgData = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = dataHome
  cleanups.push(() => {
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgData
  })
  if (h.auth) {
    await mkdir(join(dataHome, "opencode"), { recursive: true })
    await writeFile(join(dataHome, "opencode", "auth.json"), JSON.stringify(h.auth))
  }

  const fetchCalls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    fetchCalls.push(url)
    if (!h.fetch) throw new Error(`unexpected fetch: ${url}`)
    return Response.json(h.fetch(url))
  }) as typeof fetch

  let provider = h.provider
  let slot: Slot | undefined
  const api = {
    theme: {
      current: {
        text: "#ffffff",
        textMuted: "#808080",
        success: "#00ff00",
        warning: "#ffcc00",
        error: "#ff0000",
      },
    },
    model: { current: () => h.promptModel },
    state: {
      session: {
        messages: () => h.messages ?? [],
        get: () => (provider ? { model: { providerID: provider, modelID: "test-model" } } : undefined),
      },
      path: { state: join(dataHome, "state") },
    },
    renderer: setup.renderer,
    slots: {
      register: (config: { slots: { sidebar_content: Slot } }) => {
        slot = config.slots.sidebar_content
      },
    },
    lifecycle: { onDispose: () => {} },
  }

  await plugin.tui(api as unknown as TuiPluginApi, h.options as never, {} as never)
  if (slot) {
    const registered = slot
    await render(() => registered({}, { session_id: SESSION }) as never, setup.renderer)
    await setup.renderOnce()
  }
  return {
    setup,
    fetchCalls,
    registered: slot !== undefined,
    setProvider: (value) => {
      provider = value
    },
  }
}

function frame(setup: TestRendererSetup): string {
  return setup.captureCharFrame()
}

function lineY(setup: TestRendererSetup, text: string): number {
  return setup.captureSpans().lines.findIndex((line) =>
    line.spans.map((span) => span.text).join("").includes(text),
  )
}

async function waitForFrameText(setup: TestRendererSetup, text: string, tries = 200): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const current = frame(setup)
    if (current.includes(text)) return current
    await new Promise((resolve) => setTimeout(resolve, 5))
    await setup.renderOnce()
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)} in:\n${frame(setup)}`)
}

test("registers a sidebar_content slot", async () => {
  const { registered } = await mount()
  expect(registered).toBe(true)
})

test("renders the Usage header even with no messages", async () => {
  const { setup } = await mount()
  const screen = frame(setup)
  expect(screen).toContain("Usage")
  expect(screen).toContain("0 reqs")
  expect(screen).toContain("In 0 · Out 0")
})

test("renders session totals, cache and reasoning from assistant messages", async () => {
  const { setup } = await mount({
    messages: [
      assistant({ input: 1_000_000, output: 150_000, cacheRead: 900_000, cacheWrite: 60_000, reasoning: 45_000 }),
      assistant({ input: 200_000, output: 30_000 }),
    ],
  })
  const screen = frame(setup)
  expect(screen).toContain("Usage")
  expect(screen).toContain("2 reqs")
  expect(screen).toContain("In 1.2M")
  expect(screen).toContain("Out 180K")
  expect(screen).toContain("Cache 900K↓ 60K↑")
  expect(screen).toContain("Think 45K")
  expect(screen).not.toContain("$")
})

test("startCollapsed hides totals until the header is clicked", async () => {
  const { setup } = await mount({
    options: { startCollapsed: true },
    messages: [assistant({ input: 5 })],
  })
  expect(frame(setup)).toContain("Usage")
  expect(frame(setup)).not.toContain("In ")

  const y = lineY(setup, "Usage")
  expect(y).toBeGreaterThanOrEqual(0)
  await setup.mockMouse.click(2, y)
  await setup.renderOnce()
  expect(frame(setup)).toContain("In 5")
})

test("showCost displays the session cost", async () => {
  const { setup } = await mount({
    options: { showCost: true },
    messages: [assistant({ input: 10, cost: 3.42 })],
  })
  expect(frame(setup)).toContain("$3.42")
})

test("showCache and showReasoning can be turned off", async () => {
  const { setup } = await mount({
    options: { showCache: false, showReasoning: false },
    messages: [assistant({ input: 10, cacheRead: 5, cacheWrite: 5, reasoning: 7 })],
  })
  const screen = frame(setup)
  expect(screen).not.toContain("Cache")
  expect(screen).not.toContain("Think")
})

test("shows ChatGPT quota for openai sessions", async () => {
  const now = Date.now()
  const { setup, fetchCalls } = await mount({
    provider: "openai",
    auth: { openai: { type: "oauth", access: "token", expires: now + 3_600_000 } },
    fetch: () => ({
      rate_limit: {
        primary_window: {
          used_percent: 48,
          reset_at: Math.floor(now / 1000) + 3_600,
          limit_window_seconds: 86_400,
        },
        secondary_window: {
          used_percent: 12,
          reset_after_seconds: 7_200,
          limit_window_seconds: 604_800,
        },
      },
    }),
  })
  const screen = await waitForFrameText(setup, "OpenAI")
  expect(fetchCalls).toHaveLength(1)
  expect(fetchCalls[0]).toContain("chatgpt.com")
  expect(screen).toContain("Daily")
  expect(screen).toContain("48%")
  expect(screen).toContain("Weekly")
  expect(screen).toContain("12%")
})

test("shows OpenCode Go quota for opencode-go sessions", async () => {
  const now = Date.now()
  const { setup, fetchCalls } = await mount({
    provider: "opencode-go",
    auth: { "opencode-go": { key: "sk-test" } },
    fetch: () => ({
      usage: {
        rolling: { percent: 10, resetsAt: new Date(now + 3_600_000).toISOString() },
        weekly: { percent: 25, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
        monthly: { percent: 40, resetsAt: new Date(now + 20 * 86_400_000).toISOString() },
      },
    }),
  })
  const screen = await waitForFrameText(setup, "OpenCode Go")
  expect(fetchCalls).toHaveLength(1)
  expect(fetchCalls[0]).toContain("opencode.ai")
  expect(screen).toContain("5h")
  expect(screen).toContain("Weekly")
  expect(screen).toContain("Monthly")
  expect(screen).toContain("10%")
  expect(screen).toContain("25%")
  expect(screen).toContain("40%")
})

test("uses the session model when the prompt model is a different provider", async () => {
  const now = Date.now()
  const { setup, fetchCalls } = await mount({
    provider: "opencode-go",
    promptModel: { providerID: "openai", modelID: "gpt-5" },
    auth: { "opencode-go": { key: "sk-test" } },
    fetch: () => ({
      usage: {
        rolling: { percent: 10, resetsAt: new Date(now + 3_600_000).toISOString() },
        weekly: { percent: 25, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
        monthly: { percent: 40, resetsAt: new Date(now + 20 * 86_400_000).toISOString() },
      },
    }),
  })
  const screen = await waitForFrameText(setup, "OpenCode Go")
  expect(fetchCalls).toHaveLength(1)
  expect(fetchCalls[0]).toContain("opencode.ai")
  expect(screen).not.toContain("OpenAI")
  expect(screen).toContain("10%")
})

test("picks up a session provider that appears after mount", async () => {
  const now = Date.now()
  const h = await mount({
    auth: { "opencode-go": { key: "sk-test" } },
    fetch: () => ({
      usage: {
        rolling: { percent: 10, resetsAt: new Date(now + 3_600_000).toISOString() },
        weekly: { percent: 25, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
        monthly: { percent: 40, resetsAt: new Date(now + 20 * 86_400_000).toISOString() },
      },
    }),
  })
  expect(frame(h.setup)).not.toContain("OpenCode Go")
  h.setProvider("opencode-go")
  const screen = await waitForFrameText(h.setup, "OpenCode Go", 600)
  expect(screen).toContain("10%")
})

test("stays quota-free for providers without a subscription endpoint", async () => {
  const { setup, fetchCalls } = await mount({
    provider: "anthropic",
    messages: [assistant({ input: 100 })],
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  await setup.renderOnce()
  const screen = frame(setup)
  expect(screen).toContain("Usage")
  expect(screen).not.toContain("OpenAI")
  expect(screen).not.toContain("OpenCode Go")
  expect(fetchCalls).toHaveLength(0)
})

test("hides quota windows whose reset time has passed", async () => {
  const now = Date.now()
  const { setup } = await mount({
    provider: "openai",
    auth: { openai: { access: "token", expires: now + 3_600_000 } },
    fetch: () => ({
      rate_limit: {
        primary_window: {
          used_percent: 99,
          reset_at: Math.floor((now - 60_000) / 1000),
          limit_window_seconds: 86_400,
        },
        secondary_window: {
          used_percent: 12,
          reset_at: Math.floor((now + 3_600_000) / 1000),
          limit_window_seconds: 604_800,
        },
      },
    }),
  })
  const screen = await waitForFrameText(setup, "Weekly")
  expect(screen).toContain("12%")
  expect(screen).not.toContain("99%")
  expect(screen).not.toContain("Daily")
})

test("enabled: false does not register the sidebar slot", async () => {
  const { registered } = await mount({ options: { enabled: false } })
  expect(registered).toBe(false)
})
