/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSignal } from "solid-js"
import plugin, { type Options } from "../tui/token-usage-v2"
import hybrid from "../tui/token-usage"

const SESSION = "ses_test"
const originalFetch = globalThis.fetch

const POLL_SUCCESS_MS = 120_000
const POLL_FAILURE_MS = 360_000
const FETCH_TIMEOUT_MS = 10_000
const OPENAI_URL = "https://chatgpt.com/backend-api/wham/usage"
const OPENCODE_GO_URL = "https://opencode.ai/zen/go/v1/usage"

const scheduledDelays: number[] = []
const timeoutDurations: number[] = []
const timeoutControllers: AbortController[] = []

let restoreGlobals: (() => void) | undefined

beforeEach(() => {
  scheduledDelays.length = 0
  timeoutDurations.length = 0
  timeoutControllers.length = 0

  const realSetTimeout = globalThis.setTimeout
  const realAbortTimeout = AbortSignal.timeout
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof timeout === "number") scheduledDelays.push(timeout)
    return (realSetTimeout as unknown as (...a: unknown[]) => unknown)(handler, timeout, ...args)
  }) as typeof setTimeout
  ;(AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    timeoutDurations.push(ms)
    const controller = new AbortController()
    timeoutControllers.push(controller)
    return controller.signal
  }
  restoreGlobals = () => {
    globalThis.setTimeout = realSetTimeout
    ;(AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = realAbortTimeout
  }
})

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  globalThis.fetch = originalFetch
  restoreGlobals?.()
  restoreGlobals = undefined
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

function assistant(usage: Usage): SessionMessageInfo {
  return {
    type: "assistant",
    cost: usage.cost ?? 0,
    tokens: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      reasoning: usage.reasoning ?? 0,
      cache: { read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 },
    },
  } as SessionMessageAssistant
}

type Slot = (props: { sessionID: string }) => unknown

type CapturedRequest = { url: string; init: RequestInit | undefined }

type FetchResult = Response | Promise<Response> | Record<string, unknown>
type FetchHandler = (url: string, init: RequestInit | undefined) => FetchResult

type Harness = {
  setup: TestRendererSetup
  requests: CapturedRequest[]
  fetchCalls: string[]
  integrationCalls: string[]
  rpcCalls: number
  registered: boolean
  slotActive: () => boolean
  unload: () => void
  setProvider: (provider: string | undefined) => void
  setMessages: (messages: SessionMessageInfo[]) => void
  dispose: () => void
}

type MountOptions = {
  messages?: SessionMessageInfo[]
  provider?: string
  selectedModel?: { providerID: string; id: string }
  auth?: Record<string, unknown>
  authRaw?: string
  codexAuth?: Record<string, unknown> | string
  openCodeApiKey?: string
  options?: Options
  fetch?: FetchHandler
  v2Connections?: Record<string, Array<{ type: "credential"; id: string; label: string; method: "oauth" | "key" }>>
  integrationError?: boolean
  rpcQuota?: { windows: Array<{ percent: number; resetsAt: number; label: string }> }
  rpcError?: boolean
  width?: number
  height?: number
  hybrid?: boolean
}

async function mount(h: MountOptions = {}): Promise<Harness> {
  const setup = await createTestRenderer({
    width: h.width ?? 60,
    height: h.height ?? 30,
    useThread: false,
  })
  cleanups.push(() => {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
  })

  // Isolate Codex credentials in a temporary CODEX_HOME so the real
  // ~/.codex/auth.json is never read by these tests.
  const codexHome = await mkdtemp(join(tmpdir(), "token-usage-codex-"))
  cleanups.push(() => rm(codexHome, { recursive: true, force: true }))
  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome
  cleanups.push(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
  })
  if (h.codexAuth !== undefined) {
    const raw = typeof h.codexAuth === "string" ? h.codexAuth : JSON.stringify(h.codexAuth)
    await writeFile(join(codexHome, "auth.json"), raw)
  }

  // Isolate OpenCode credentials in a temporary XDG data home.
  const dataHome = await mkdtemp(join(tmpdir(), "token-usage-test-"))
  cleanups.push(() => rm(dataHome, { recursive: true, force: true }))
  const previousXdgData = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = dataHome
  cleanups.push(() => {
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgData
  })
  if (h.auth !== undefined || h.authRaw !== undefined) {
    await mkdir(join(dataHome, "opencode"), { recursive: true })
    const raw = h.authRaw ?? JSON.stringify(h.auth)
    await writeFile(join(dataHome, "opencode", "auth.json"), raw)
  }

  // Isolate OPENCODE_API_KEY so real user secrets are never consulted.
  const previousApiKey = process.env.OPENCODE_API_KEY
  if (h.openCodeApiKey === undefined) delete process.env.OPENCODE_API_KEY
  else process.env.OPENCODE_API_KEY = h.openCodeApiKey
  cleanups.push(() => {
    if (previousApiKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousApiKey
  })

  const requests: CapturedRequest[] = []
  // Keep a live URL list that stays current for callers that destructure it
  // before the first request is issued.
  const fetchCalls: string[] = []
  const integrationCalls: string[] = []
  let rpcCalls = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    fetchCalls.push(url)
    if (!h.fetch) throw new Error(`unexpected fetch: ${url}`)
    const result = await h.fetch(url, init)
    return result instanceof Response ? result : Response.json(result)
  }) as typeof fetch

  const [provider, setProvider] = createSignal<string | undefined>(h.provider)
  const [messages, setMessages] = createSignal(h.messages ?? [])
  let slot: Slot | undefined
  let unregister = () => {}
  const api = {
    app: { version: "2.0.15" },
    client: {
      rpc: () => ({ openai: async () => {
        rpcCalls++
        if (h.rpcError || !h.rpcQuota) throw new Error("quota RPC unavailable")
        return h.rpcQuota
      } }),
      integration: {
        get: async ({ integrationID }: { integrationID: string }) => {
          integrationCalls.push(integrationID)
          if (h.integrationError) throw new Error("integration unavailable")
          return { data: { connections: h.v2Connections?.[integrationID] ?? [] } }
        },
      },
    },
    theme: {
      text: {
        base: "#ffffff",
        muted: "#808080",
        feedback: {
          success: { base: "#00ff00" },
          warning: { base: "#ffcc00" },
          error: { base: "#ff0000" },
        },
      },
    },
    options: h.options ?? {},
    data: {
      session: {
        message: { list: () => h.selectedModel
          ? [{ type: "model-switched", model: h.selectedModel }, ...messages()]
          : messages() },
        get: () => {
          const value = provider()
          return value ? { model: { providerID: value, id: "test-model" } } : undefined
        },
      },
    },
    renderer: setup.renderer,
    ui: {
      slot: (config: { append: string; render: Slot }) => {
        if (config.append !== "sidebar.content") throw new Error("wrong slot")
        slot = config.render
        unregister = () => { slot = undefined }
        return unregister
      },
    },
  }

  const cleanup = await (h.hybrid ? hybrid : plugin).setup(api as unknown as Context)
  cleanups.push(() => { if (typeof cleanup === "function") cleanup() })
  const registered = slot !== undefined
  if (slot) {
    const registeredSlot = slot
    await render(() => registeredSlot({ sessionID: SESSION }) as never, setup.renderer)
    await setup.renderOnce()
  }
  return {
    setup,
    requests,
    fetchCalls,
    integrationCalls,
    get rpcCalls() { return rpcCalls },
    registered,
    slotActive: () => slot !== undefined,
    unload: () => { if (typeof cleanup === "function") cleanup() },
    setProvider: (value) => setProvider(value),
    setMessages: (value: SessionMessageInfo[]) => setMessages(value),
    dispose: () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
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

async function waitUntil(
  setup: TestRendererSetup,
  predicate: () => boolean,
  tries = 400,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
    await setup.renderOnce()
  }
  throw new Error("timed out waiting for condition")
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function openaiQuota(percent = 48): Record<string, unknown> {
  const now = Date.now()
  return {
    rate_limit: {
      primary_window: {
        used_percent: percent,
        reset_at: Math.floor((now + 3_600_000) / 1000),
        limit_window_seconds: 86_400,
      },
      secondary_window: {
        used_percent: 12,
        reset_after_seconds: 7_200,
        limit_window_seconds: 604_800,
      },
    },
  }
}

function goQuota(percent = 10): Record<string, unknown> {
  const now = Date.now()
  return {
    usage: {
      rolling: { percent, resetsAt: new Date(now + 3_600_000).toISOString() },
      weekly: { percent: 25, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
      monthly: { percent: 40, resetsAt: new Date(now + 20 * 86_400_000).toISOString() },
    },
  }
}

function pollDelays(): number[] {
  return scheduledDelays.filter((delay) => delay === POLL_SUCCESS_MS || delay === POLL_FAILURE_MS)
}

function authHeaders(request: CapturedRequest): Record<string, string> {
  return request.init?.headers as Record<string, string>
}

test("V2-only OpenAI sign-in shows unavailable without requesting a legacy quota", async () => {
  const h = await mount({
    provider: "openai",
    messages: [assistant({ input: 42 })],
    v2Connections: { openai: [{ type: "credential", id: "synthetic-id", label: "synthetic-account", method: "oauth" }] },
  })
  const screen = await waitForFrameText(h.setup, "Quota unavailable for V2 sign-in")
  expect(screen).toContain("In 42 · Out 0")
  expect(screen).not.toContain("synthetic-account")
  expect(screen).not.toContain("synthetic-id")
  expect(h.integrationCalls).toEqual(["openai"])
  expect(h.requests).toHaveLength(0)
})

test("active OpenAI V2 connection displays server quota without sending a local token", async () => {
  const h = await mount({
    provider: "openai",
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "stale-legacy-token" } },
    v2Connections: { openai: [{ type: "credential", id: "v2", label: "new account", method: "oauth" }] },
    rpcQuota: { windows: [{ percent: 48, resetsAt: Date.now() + 3_600_000, label: "5h" }] },
  })
  const screen = await waitForFrameText(h.setup, "OpenAI · active account")
  expect(screen).toContain("48%")
  expect(screen).not.toContain("Account may differ")
  expect(h.rpcCalls).toBe(1)
  expect(h.requests).toHaveLength(0)
})

test("hybrid V2 setup renders cached totals and refuses a connected account's legacy token", async () => {
  const h = await mount({
    hybrid: true,
    provider: "openai",
    messages: [assistant({ input: 1200, output: 200 })],
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "synthetic-legacy-token" } },
    v2Connections: { openai: [{ type: "credential", id: "v2", label: "new account", method: "oauth" }] },
  })
  const screen = await waitForFrameText(h.setup, "Quota unavailable for V2 sign-in")
  expect(screen).toContain("In 1.2K · Out 200")
  expect(screen).toContain("1 reqs")
  expect(h.integrationCalls).toEqual(["openai"])
  expect(h.requests).toEqual([])
})

test("V2 Go connection blocks a stale legacy key and never sends it", async () => {
  const h = await mount({
    provider: "opencode-go",
    auth: { "opencode-go": { key: "stale-legacy-secret" } },
    v2Connections: { "opencode-go": [{ type: "credential", id: "other", label: "synthetic-new-account", method: "key" }] },
  })
  const screen = await waitForFrameText(h.setup, "Quota unavailable for V2 sign-in")
  expect(screen).not.toContain("stale-legacy-secret")
  expect(screen).not.toContain("synthetic-new-account")
  expect(h.requests).toHaveLength(0)
  expect(h.integrationCalls).toEqual(["opencode-go"])
})

test("legacy quota labels its source and warns that the V2 account may differ", async () => {
  const h = await mount({
    provider: "openai",
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "legacy-secret" } },
    fetch: () => openaiQuota(),
  })
  const screen = await waitForFrameText(h.setup, "Account may differ from V2")
  expect(screen).toContain("OpenAI · legacy quota")
  expect(screen).toContain("48%")
  expect(screen).not.toContain("legacy-secret")
  expect(h.requests).toHaveLength(1)
})

test("failure to inspect V2 connections fails closed without using legacy credentials", async () => {
  const h = await mount({
    provider: "openai",
    integrationError: true,
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "legacy-secret" } },
  })
  expect(await waitForFrameText(h.setup, "Quota unavailable for V2 sign-in")).not.toContain("legacy-secret")
  expect(h.requests).toHaveLength(0)
})

test("registers a V2 sidebar.content slot and unregisters on unload", async () => {
  const { registered, slotActive, unload } = await mount()
  expect(registered).toBe(true)
  expect(slotActive()).toBe(true)
  unload()
  expect(slotActive()).toBe(false)
})

test("cached V2 assistant messages update session totals without remounting", async () => {
  const h = await mount({ messages: [assistant({ input: 100, output: 20 })] })
  expect(frame(h.setup)).toContain("In 100 · Out 20")
  h.setMessages([assistant({ input: 100, output: 20 }), assistant({ input: 50, output: 30 })])
  await h.setup.renderOnce()
  expect(frame(h.setup)).toContain("2 reqs")
  expect(frame(h.setup)).toContain("In 150 · Out 50")
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

test("uses the session model when a model-switched message names a different provider", async () => {
  const now = Date.now()
  const { setup, fetchCalls } = await mount({
    provider: "opencode-go",
    selectedModel: { providerID: "openai", id: "gpt-5" },
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

// ---------------------------------------------------------------------------
// Q1: provider selection precedence
// ---------------------------------------------------------------------------

test("a supported session provider takes precedence over a different model-switched provider", async () => {
  const h = await mount({
    provider: "openai",
    selectedModel: { providerID: "opencode-go", id: "go-model" },
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: () => openaiQuota(),
  })
  const screen = await waitForFrameText(h.setup, "OpenAI")
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]!.url).toBe(OPENAI_URL)
  expect(authHeaders(h.requests[0]!).authorization).toBe("Bearer codex-token")
  expect(screen).toContain("48%")
  expect(screen).not.toContain("OpenCode Go")
})

test("an unsupported session provider never inherits a supported model-switched provider's quota", async () => {
  const h = await mount({
    provider: "anthropic",
    selectedModel: { providerID: "openai", id: "gpt-5" },
    messages: [assistant({ input: 50 })],
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    // no fetch handler: any quota request fails the assertion below
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  await h.setup.renderOnce()
  const screen = frame(h.setup)
  expect(screen).toContain("In 50")
  expect(screen).not.toContain("OpenAI")
  expect(h.requests).toHaveLength(0)
})

test("a missing session provider falls back to its model-switched message", async () => {
  const h = await mount({
    selectedModel: { providerID: "openai", id: "gpt-5" },
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: () => openaiQuota(),
  })
  await waitForFrameText(h.setup, "OpenAI")
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]!.url).toBe(OPENAI_URL)
})

// ---------------------------------------------------------------------------
// Q2: stale quota and provider switching
// ---------------------------------------------------------------------------

test("clears previous quota immediately when switching supported providers", async () => {
  const goPending = deferred<Response>()
  const h = await mount({
    provider: "openai",
    auth: { "opencode-go": { key: "sk-go" } },
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: (url) => (url === OPENAI_URL ? openaiQuota() : goPending.promise),
  })
  await waitForFrameText(h.setup, "48%")

  h.setProvider("opencode-go")
  await waitUntil(h.setup, () => h.requests.length === 2)
  await h.setup.renderOnce()
  const cleared = frame(h.setup)
  expect(cleared).toContain("Usage")
  expect(cleared).not.toContain("48%")
  expect(cleared).not.toContain("OpenAI")

  goPending.resolve(Response.json(goQuota(20)))
  const after = await waitForFrameText(h.setup, "OpenCode Go")
  expect(after).toContain("20%")
  expect(after).not.toContain("48%")
})

test("a late response from the previous provider cannot replace the current quota", async () => {
  const openaiPending = deferred<Response>()
  const goPending = deferred<Response>()
  const h = await mount({
    provider: "openai",
    auth: { "opencode-go": { key: "sk-go" } },
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: (url) => (url === OPENAI_URL ? openaiPending.promise : goPending.promise),
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  const openaiSignal = h.requests[0]!.init?.signal as AbortSignal

  h.setProvider("opencode-go")
  await waitUntil(h.setup, () => h.requests.length === 2)
  expect(openaiSignal.aborted).toBe(true)

  goPending.resolve(Response.json(goQuota(20)))
  await waitForFrameText(h.setup, "20%")

  openaiPending.resolve(Response.json(openaiQuota(99)))
  await new Promise((resolve) => setTimeout(resolve, 25))
  await h.setup.renderOnce()
  const screen = frame(h.setup)
  expect(screen).toContain("OpenCode Go")
  expect(screen).toContain("20%")
  expect(screen).not.toContain("99%")
  expect(screen).not.toContain("OpenAI")
})

// ---------------------------------------------------------------------------
// Q3: cancellation, unmount and polling schedule
// ---------------------------------------------------------------------------

test("switching providers aborts the in-flight request and prevents later polling", async () => {
  const openaiPending = deferred<Response>()
  const h = await mount({
    provider: "openai",
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: () => openaiPending.promise,
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  const signal = h.requests[0]!.init?.signal as AbortSignal

  h.setProvider("anthropic")
  await h.setup.renderOnce()
  expect(signal.aborted).toBe(true)
  const pollsBefore = pollDelays().length

  openaiPending.resolve(Response.json(openaiQuota(48)))
  await new Promise((resolve) => setTimeout(resolve, 25))
  await h.setup.renderOnce()
  expect(pollDelays().length).toBe(pollsBefore)
  expect(frame(h.setup)).not.toContain("OpenAI")
})

test("unmounting aborts the in-flight request and prevents later updates", async () => {
  const openaiPending = deferred<Response>()
  const h = await mount({
    provider: "openai",
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: () => openaiPending.promise,
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  const signal = h.requests[0]!.init?.signal as AbortSignal

  h.dispose()
  expect(signal.aborted).toBe(true)
  const pollsBefore = pollDelays().length

  openaiPending.resolve(Response.json(openaiQuota(48)))
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(pollDelays().length).toBe(pollsBefore)
})

test("successful quota polling schedules the next poll at 120 seconds", async () => {
  const h = await mount({
    provider: "openai",
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: () => openaiQuota(),
  })
  await waitUntil(h.setup, () => scheduledDelays.includes(POLL_SUCCESS_MS))
  expect(scheduledDelays).toContain(POLL_SUCCESS_MS)
  expect(scheduledDelays).not.toContain(POLL_FAILURE_MS)
})

test("failed quota polling schedules the next poll at 360 seconds", async () => {
  const h = await mount({
    provider: "openai",
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: () => new Response("nope", { status: 500 }),
  })
  await waitUntil(h.setup, () => scheduledDelays.includes(POLL_FAILURE_MS))
  expect(scheduledDelays).toContain(POLL_FAILURE_MS)
  expect(scheduledDelays).not.toContain(POLL_SUCCESS_MS)
})

// ---------------------------------------------------------------------------
// Q4: quota opt-out
// ---------------------------------------------------------------------------

test("showQuota false preserves token details and makes no quota request", async () => {
  const h = await mount({
    provider: "openai",
    messages: [assistant({ input: 100 })],
    auth: { openai: { type: "oauth", access: "xdg-token", expires: Date.now() + 3_600_000 } },
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    options: { showQuota: false },
    // no fetch handler: valid credentials exist, but no request may be issued
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  await h.setup.renderOnce()
  const screen = frame(h.setup)
  expect(screen).toContain("Usage")
  expect(screen).toContain("In 100")
  expect(screen).not.toContain("OpenAI")
  expect(screen).not.toContain("OpenCode Go")
  expect(h.requests).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// C3: credential source precedence (isolated file system)
// ---------------------------------------------------------------------------

test("a CODEX_HOME credential takes precedence over OpenCode auth", async () => {
  const h = await mount({
    provider: "openai",
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token", account_id: "acct-codex" } },
    auth: { openai: { type: "oauth", access: "xdg-token" } },
    fetch: () => openaiQuota(),
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  const headers = authHeaders(h.requests[0]!)
  expect(headers.authorization).toBe("Bearer codex-token")
  expect(headers["chatgpt-account-id"]).toBe("acct-codex")
})

test("falls back to isolated OpenCode auth when Codex auth is absent", async () => {
  const h = await mount({
    provider: "openai",
    auth: { openai: { type: "oauth", access: "xdg-token" } },
    fetch: () => openaiQuota(),
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  const headers = authHeaders(h.requests[0]!)
  expect(headers.authorization).toBe("Bearer xdg-token")
  expect(headers["chatgpt-account-id"]).toBeUndefined()
})

test("falls back to isolated OpenCode auth when Codex auth is unusable", async () => {
  const h = await mount({
    provider: "openai",
    codexAuth: {
      auth_mode: "apikey",
      tokens: { access_token: "codex-token" },
      OPENAI_API_KEY: "sk-x",
    },
    auth: { openai: { access: "xdg-token" } },
    fetch: () => openaiQuota(),
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  expect(authHeaders(h.requests[0]!).authorization).toBe("Bearer xdg-token")
})

test("falls back to OPENCODE_API_KEY for Go when no file key exists", async () => {
  const h = await mount({
    provider: "opencode-go",
    openCodeApiKey: "env-go-key",
    fetch: () => goQuota(),
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  expect(h.requests[0]!.url).toBe(OPENCODE_GO_URL)
  expect(authHeaders(h.requests[0]!).authorization).toBe("Bearer env-go-key")
})

test("a valid file Go key takes precedence over OPENCODE_API_KEY", async () => {
  const h = await mount({
    provider: "opencode-go",
    auth: { "opencode-go": { key: "sk-file" } },
    openCodeApiKey: "env-go-key",
    fetch: () => goQuota(),
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  expect(authHeaders(h.requests[0]!).authorization).toBe("Bearer sk-file")
})

test("an invalid environment Go key produces no request", async () => {
  const h = await mount({
    provider: "opencode-go",
    openCodeApiKey: "bad key",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  await h.setup.renderOnce()
  expect(h.requests).toHaveLength(0)
  expect(frame(h.setup)).not.toContain("OpenCode Go")
})

// ---------------------------------------------------------------------------
// C4: request shape and graceful failures
// ---------------------------------------------------------------------------

test("OpenAI requests use the expected endpoint, headers, redirect policy and timeout signal", async () => {
  const h = await mount({
    provider: "openai",
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token", account_id: "acct_1" } },
    fetch: () => openaiQuota(),
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  const request = h.requests[0]!
  expect(request.url).toBe(OPENAI_URL)
  expect(request.init?.redirect).toBe("error")
  const headers = authHeaders(request)
  expect(headers.authorization).toBe("Bearer codex-token")
  expect(headers["user-agent"]).toBe("codex-cli")
  expect(headers["chatgpt-account-id"]).toBe("acct_1")
  expect(request.init?.signal).toBeInstanceOf(AbortSignal)
  expect(timeoutDurations).toContain(FETCH_TIMEOUT_MS)

  const signal = request.init!.signal as AbortSignal
  expect(signal.aborted).toBe(false)
  timeoutControllers[timeoutControllers.length - 1]!.abort()
  expect(signal.aborted).toBe(true)
})

test("OpenCode Go requests use the expected endpoint, headers, redirect policy and timeout signal", async () => {
  const h = await mount({
    provider: "opencode-go",
    auth: { "opencode-go": { key: "sk-file" } },
    fetch: () => goQuota(),
  })
  await waitUntil(h.setup, () => h.requests.length === 1)
  const request = h.requests[0]!
  expect(request.url).toBe(OPENCODE_GO_URL)
  expect(request.init?.redirect).toBe("error")
  const headers = authHeaders(request)
  expect(headers.authorization).toBe("Bearer sk-file")
  expect(headers["user-agent"]).toBe("opencode-token-usage")
  expect(headers["chatgpt-account-id"]).toBeUndefined()
  expect(request.init?.signal).toBeInstanceOf(AbortSignal)
  expect(timeoutDurations).toContain(FETCH_TIMEOUT_MS)

  const signal = request.init!.signal as AbortSignal
  expect(signal.aborted).toBe(false)
  timeoutControllers[timeoutControllers.length - 1]!.abort()
  expect(signal.aborted).toBe(true)
})

test("HTTP errors hide quota while token totals keep rendering", async () => {
  const h = await mount({
    provider: "openai",
    messages: [assistant({ input: 123 })],
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: () => new Response("nope", { status: 500 }),
  })
  await waitUntil(h.setup, () => scheduledDelays.includes(POLL_FAILURE_MS))
  const screen = frame(h.setup)
  expect(h.requests).toHaveLength(1)
  expect(screen).toContain("In 123")
  expect(screen).not.toContain("OpenAI")
})

test("invalid JSON responses hide quota while token totals keep rendering", async () => {
  const h = await mount({
    provider: "opencode-go",
    messages: [assistant({ input: 77 })],
    auth: { "opencode-go": { key: "sk-file" } },
    fetch: () =>
      new Response("{ not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  })
  await waitUntil(h.setup, () => scheduledDelays.includes(POLL_FAILURE_MS))
  const screen = frame(h.setup)
  expect(h.requests).toHaveLength(1)
  expect(screen).toContain("In 77")
  expect(screen).not.toContain("OpenCode Go")
})

test("transport failures hide quota while token totals keep rendering", async () => {
  const h = await mount({
    provider: "openai",
    messages: [assistant({ input: 55 })],
    codexAuth: { auth_mode: "chatgpt", tokens: { access_token: "codex-token" } },
    fetch: () => {
      throw new Error("network down")
    },
  })
  await waitUntil(h.setup, () => scheduledDelays.includes(POLL_FAILURE_MS))
  const screen = frame(h.setup)
  expect(h.requests).toHaveLength(1)
  expect(screen).toContain("In 55")
  expect(screen).not.toContain("OpenAI")
})
