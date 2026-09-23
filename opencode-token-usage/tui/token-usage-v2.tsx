/** @jsxImportSource @opentui/solid */
/**
 * Token usage (OpenCode V2 CLI plugin)
 *
 * Adds a live per-session token usage section to the session sidebar, and
 * shows subscription quota for the current provider: ChatGPT/Codex while the
 * session model is an OpenAI model, OpenCode Go while it is an opencode-go
 * model.
 *
 * Register from `~/.config/opencode/cli.json`:
 *
 *   {
 *     "plugins": [
 *       { "package": "./plugins/token-usage", "options": { "showCost": true } }
 *     ]
 *   }
 *
 * Options:
 *   enabled        disable without removing from cli.json (default true)
 *   startCollapsed start with the section collapsed (default false)
 *   showCost       show cumulative session cost (default false)
 *   showCache      show cache read/write tokens (default true)
 *   showReasoning  show reasoning tokens when present (default true)
 *   showQuota      fetch and display subscription quota (default true)
 *                 OpenAI V2 quota requires the companion server plugin.
 */
import type { SessionMessageInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Buffer } from "node:buffer"
import { parseWhamUsage, parseWhamWindow } from "../quota"
import type { QuotaLabel, QuotaWindow } from "../quota"
import { TokenUsageQuota } from "../rpc"

const POLL_MS = 120_000
const FETCH_TIMEOUT_MS = 10_000
const EXPIRY_MARGIN_MS = 60_000
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

type Options = {
  enabled?: boolean
  startCollapsed?: boolean
  showCost?: boolean
  showCache?: boolean
  showReasoning?: boolean
  showQuota?: boolean
}

type Resolved = {
  startCollapsed: boolean
  showCost: boolean
  showCache: boolean
  showReasoning: boolean
  showQuota: boolean
}

type Summary = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  requests: number
  cost: number
}

type QuotaProvider = "openai" | "opencode-go"

type Credentials = {
  accessToken: string
  accountId?: string
}

function resolveOptions(input: Options | undefined): Resolved {
  return {
    startCollapsed: input?.startCollapsed === true,
    showCost: input?.showCost === true,
    showCache: input?.showCache !== false,
    showReasoning: input?.showReasoning !== false,
    showQuota: input?.showQuota !== false,
  }
}

function nonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function summarize(messages: ReadonlyArray<SessionMessageInfo>): Summary {
  const summary: Summary = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
    cost: 0,
  }
  for (const message of messages) {
    if (message.type !== "assistant") continue
    summary.requests += 1
    summary.cost += nonnegative(message.cost)
    summary.input += nonnegative(message.tokens?.input)
    summary.output += nonnegative(message.tokens?.output)
    summary.reasoning += nonnegative(message.tokens?.reasoning)
    summary.cacheRead += nonnegative(message.tokens?.cache?.read)
    summary.cacheWrite += nonnegative(message.tokens?.cache?.write)
  }
  return summary
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value < 1_000) return String(Math.floor(value))
  const units = ["K", "M", "B"]
  let scaled = value / 1_000
  let unit = 0
  while (Math.round(scaled * 10) / 10 >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000
    unit += 1
  }
  return scaled.toFixed(1).replace(/\.0$/, "") + units[unit]
}

function fmtDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  return `${hours}h ${minutes}m`
}

function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share"), "opencode")
}

function jwtExpiry(token: string): number {
  const payload = token.split(".")[1]
  if (!payload) return 0
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown
    }
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : 0
  } catch {
    return 0
  }
}

function credentialString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value) ? value : undefined
}

function codexCredentials(raw: string, now: number): Credentials | null {
  try {
    const parsed = JSON.parse(raw) as {
      auth_mode?: unknown
      tokens?: { access_token?: unknown; account_id?: unknown }
    }
    if (parsed.auth_mode !== "chatgpt") return null
    const accessToken = credentialString(parsed.tokens?.access_token)
    if (!accessToken) return null
    const exp = jwtExpiry(accessToken)
    if (exp > 0 && exp * 1000 <= now + EXPIRY_MARGIN_MS) return null
    const accountId = credentialString(parsed.tokens?.account_id)
    return { accessToken, ...(accountId ? { accountId } : {}) }
  } catch {
    return null
  }
}

function opencodeCredentials(raw: string, now: number): Credentials | null {
  try {
    const auth = JSON.parse(raw) as Record<
      string,
      { type?: unknown; access?: unknown; expires?: unknown; accountId?: unknown }
    >
    const entry = auth.openai
    if (!entry || (entry.type !== undefined && entry.type !== "oauth")) return null
    const accessToken = credentialString(entry.access)
    if (!accessToken) return null
    if (
      entry.expires !== undefined &&
      (typeof entry.expires !== "number" ||
        !Number.isFinite(entry.expires) ||
        entry.expires <= now + EXPIRY_MARGIN_MS)
    ) return null
    const exp = jwtExpiry(accessToken)
    if (exp > 0 && exp * 1000 <= now + EXPIRY_MARGIN_MS) return null
    const accountId = credentialString(entry.accountId)
    return { accessToken, ...(accountId ? { accountId } : {}) }
  } catch {
    return null
  }
}

function parseGoWindow(window: unknown, label: QuotaLabel): QuotaWindow | null {
  if (!window || typeof window !== "object") return null
  const value = window as { percent?: unknown; resetsAt?: unknown }
  if (typeof value.percent !== "number" || !Number.isFinite(value.percent)) return null
  const resetsAt = typeof value.resetsAt === "string" ? Date.parse(value.resetsAt) : Number.NaN
  if (!Number.isFinite(resetsAt)) return null
  return { percent: Math.min(100, Math.max(0, value.percent)), resetsAt, label }
}

function parseGoUsage(payload: unknown): QuotaWindow[] {
  if (!payload || typeof payload !== "object") return []
  const usage = (payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== "object") return []
  const value = usage as { rolling?: unknown; weekly?: unknown; monthly?: unknown }
  return [
    parseGoWindow(value.rolling, "5h"),
    parseGoWindow(value.weekly, "Weekly"),
    parseGoWindow(value.monthly, "Monthly"),
  ].flatMap((window) => (window ? [window] : []))
}

function goApiKey(raw: string, env?: string | undefined): string | null {
  try {
    const auth = JSON.parse(raw) as Record<string, { key?: unknown }>
    const key = credentialString(auth["opencode-go"]?.key)
    if (key) return key
  } catch {
    // fall through to the environment
  }
  return credentialString(env) ?? null
}

function modelProvider(api: Context, sessionID: string): QuotaProvider | null {
  const provider = api.data.session.get(sessionID)?.model?.providerID
    ?? api.data.session.message.list(sessionID).findLast((message) => message.type === "model-switched")?.model.providerID
  return provider === "openai" || provider === "opencode-go" ? provider : null
}

// A V2 connection must use server-side RPC; local legacy tokens may belong to another account.
async function connectionState(api: Context, provider: QuotaProvider): Promise<"connected" | "legacy" | "unknown"> {
  try {
    const integration = await api.client.integration.get({ integrationID: provider, location: api.location })
    return integration.data.connections.length === 0 ? "legacy" : "connected"
  } catch {
    return "unknown"
  }
}

async function openaiCredentials(): Promise<Credentials | null> {
  const now = Date.now()
  try {
    const raw = await readFile(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"), "utf8")
    const codex = codexCredentials(raw, now)
    if (codex) return codex
  } catch {
    // fall through to opencode auth
  }
  try {
    const raw = await readFile(join(dataDir(), "auth.json"), "utf8")
    return opencodeCredentials(raw, now)
  } catch {
    // no usable credentials
  }
  return null
}

async function fetchOpenAIQuota(signal: AbortSignal): Promise<QuotaWindow[] | null> {
  const credentials = await openaiCredentials()
  if (!credentials || signal.aborted) return null
  const headers: Record<string, string> = {
    authorization: `Bearer ${credentials.accessToken}`,
    "user-agent": "codex-cli",
  }
  if (credentials.accountId) headers["chatgpt-account-id"] = credentials.accountId
  try {
    const response = await fetch(OPENAI_USAGE_URL, {
      headers,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    })
    if (!response.ok) return null
    const windows = parseWhamUsage(await response.json(), Date.now())
    return windows.length > 0 ? windows : null
  } catch {
    return null
  }
}

async function fetchGoQuota(signal: AbortSignal): Promise<QuotaWindow[] | null> {
  let key: string | null = null
  try {
    const raw = await readFile(join(dataDir(), "auth.json"), "utf8")
    key = goApiKey(raw, process.env.OPENCODE_API_KEY)
  } catch {
    key = goApiKey("", process.env.OPENCODE_API_KEY)
  }
  if (!key || signal.aborted) return null
  try {
    const response = await fetch(OPENCODE_GO_USAGE_URL, {
      headers: {
        authorization: `Bearer ${key}`,
        "user-agent": "opencode-token-usage",
      },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    })
    if (!response.ok) return null
    const windows = parseGoUsage(await response.json())
    return windows.length > 0 ? windows : null
  } catch {
    return null
  }
}

function quotaColor(theme: Context["theme"], percent: number) {
  if (percent > 85) return theme.text.feedback.error.base
  if (percent >= 50) return theme.text.feedback.warning.base
  return theme.text.feedback.success.base
}

function View(props: { api: Context; sessionID: string; options: Resolved }) {
  const theme = () => props.api.theme
  const [open, setOpen] = createSignal(!props.options.startCollapsed)
  const [now, setNow] = createSignal(Date.now())
  const [quota, setQuota] = createSignal<QuotaWindow[] | null>(null)
  const [v2Quota, setV2Quota] = createSignal(false)
  const [v2Unavailable, setV2Unavailable] = createSignal(false)

  const messages = createMemo(() => props.api.data.session.message.list(props.sessionID))
  const summary = createMemo(() => summarize(messages()))
  const quotaProvider = createMemo<QuotaProvider | null>(() => {
    now()
    return props.options.showQuota ? modelProvider(props.api, props.sessionID) : null
  })
  const quotaTitle = createMemo(() =>
    quotaProvider() === "opencode-go" ? "OpenCode Go" : "OpenAI",
  )
  const active = createMemo(() =>
    quotaProvider() ? (quota() ?? []).filter((window) => window.resetsAt > now()) : [],
  )

  const clock = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(clock))

  createEffect(() => {
    const provider = quotaProvider()
    setQuota(null)
    setV2Quota(false)
    setV2Unavailable(false)
    if (!provider) return
    const controller = new AbortController()
    let cancelled = false
    let handle: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const connection = await connectionState(props.api, provider)
      if (cancelled) return
      if (connection === "connected" && provider === "openai") {
        let windows: QuotaWindow[] = []
        try {
          const result = await props.api.client.rpc(TokenUsageQuota).openai({}, {
            location: props.api.location,
            signal: controller.signal,
          })
          const candidate = (result as { windows?: unknown }).windows
          if (Array.isArray(candidate)) {
            windows = candidate.filter((value): value is QuotaWindow =>
              value !== null && typeof value === "object" &&
              typeof value.percent === "number" && Number.isFinite(value.percent) &&
              typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt) &&
              typeof value.label === "string",
            )
          }
        } catch {
          // The server plugin may not be installed or the request may fail.
        }
        if (cancelled) return
        setQuota(windows.length > 0 ? windows : null)
        setV2Quota(windows.length > 0)
        setV2Unavailable(windows.length === 0)
        handle = setTimeout(poll, windows.length > 0 ? POLL_MS : POLL_MS * 3)
        return
      }
      if (connection !== "legacy") {
        setQuota(null)
        setV2Quota(false)
        setV2Unavailable(true)
        handle = setTimeout(poll, POLL_MS * 3)
        return
      }
      setV2Unavailable(false)
      setV2Quota(false)
      const windows = provider === "opencode-go"
        ? await fetchGoQuota(controller.signal)
        : await fetchOpenAIQuota(controller.signal)
      if (cancelled) return
      setQuota(windows)
      handle = setTimeout(poll, windows ? POLL_MS : POLL_MS * 3)
    }
    void poll()
    onCleanup(() => {
      cancelled = true
      controller.abort()
      if (handle) clearTimeout(handle)
    })
  })

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((value) => !value)}>
         <text fg={theme().text.base}>{open() ? "▼" : "▶"}</text>
         <text fg={theme().text.base}>
          <b>Usage</b>
        </text>
         <text fg={theme().text.muted}>{summary().requests + " reqs"}</text>
      </box>
      <Show when={open()}>
         <text fg={theme().text.muted}>
          {"In " + formatTokens(summary().input) + " · Out " + formatTokens(summary().output)}
        </text>
        <Show when={props.options.showCache && summary().cacheRead + summary().cacheWrite > 0}>
           <text fg={theme().text.muted}>
            {"Cache " +
              formatTokens(summary().cacheRead) +
              "↓ " +
              formatTokens(summary().cacheWrite) +
              "↑"}
          </text>
        </Show>
        <Show when={props.options.showReasoning && summary().reasoning > 0}>
           <text fg={theme().text.muted}>{"Think " + formatTokens(summary().reasoning)}</text>
        </Show>
        <Show when={props.options.showCost && summary().cost > 0}>
           <text fg={theme().text.muted}>{money.format(summary().cost)}</text>
        </Show>
        <Show when={active().length > 0}>
          <box flexDirection="column">
             <text fg={theme().text.muted}>{quotaTitle() + (v2Quota() ? " · active account" : " · legacy quota")}</text>
             <Show when={!v2Quota()}>
               <text fg={theme().text.muted}>Account may differ from V2</text>
             </Show>
            <For each={active()}>
              {(window, index) => {
                const percent = () => Math.round(window.percent)
                const filled = () => Math.round((percent() / 100) * 6)
                return (
                  <box flexDirection="row" gap={1}>
                     <text fg={theme().text.muted}>
                      {window.label ?? (index() === 0 ? "Daily" : "Weekly")}
                    </text>
                    <text fg={quotaColor(theme(), percent())}>{"▓".repeat(filled())}</text>
                     <text fg={theme().text.muted}>{"░".repeat(6 - filled())}</text>
                     <text fg={theme().text.base}>{percent() + "%"}</text>
                     <text fg={theme().text.muted}>
                      {"· " + fmtDuration(window.resetsAt - now())}
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
        <Show when={quotaProvider() && v2Unavailable()}>
          <text fg={theme().text.muted}>Quota unavailable for V2 sign-in</text>
        </Show>
      </Show>
    </box>
  )
}

const plugin = Plugin.define({
  id: "token-usage",
  setup(api) {
    const options = api.options as Options
    if (options.enabled === false) return
    const resolved = resolveOptions(options)
    return api.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <View api={api} sessionID={sessionID} options={resolved} />,
    })
  },
})

export {
  codexCredentials,
  dataDir,
  fmtDuration,
  formatTokens,
  goApiKey,
  jwtExpiry,
  opencodeCredentials,
  parseGoUsage,
  parseWhamWindow,
  resolveOptions,
  summarize,
}
export type { Credentials, Options, QuotaLabel, QuotaWindow, Resolved, Summary }
export default plugin
