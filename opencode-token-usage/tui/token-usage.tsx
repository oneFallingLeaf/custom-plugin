/** @jsxImportSource @opentui/solid */
/**
 * Token usage (TUI plugin)
 *
 * Adds a live per-session token usage section to the session sidebar, and
 * shows subscription quota for the current provider: ChatGPT/Codex while the
 * session model is an OpenAI model, OpenCode Go while it is an opencode-go
 * model.
 *
 * Register from `~/.config/opencode/tui.json`:
 *
 *   {
 *     "plugin": [
 *       ["./plugins/tui/token-usage.tsx", { "order": 110, "showCost": true }]
 *     ]
 *   }
 *
 * Options:
 *   enabled        disable without removing from tui.json (default true)
 *   order          sidebar slot order; built-in Context block is 100 (default 110)
 *   startCollapsed start with the section collapsed (default false)
 *   showCost       show cumulative session cost (default false)
 *   showCache      show cache read/write tokens (default true)
 *   showReasoning  show reasoning tokens when present (default true)
 */
import type { Message } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Buffer } from "node:buffer"

const DEFAULT_ORDER = 110
const POLL_MS = 120_000
const FETCH_TIMEOUT_MS = 10_000
const EXPIRY_MARGIN_MS = 60_000
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

type Options = {
  enabled?: boolean
  order?: number
  startCollapsed?: boolean
  showCost?: boolean
  showCache?: boolean
  showReasoning?: boolean
}

type Resolved = {
  order: number
  startCollapsed: boolean
  showCost: boolean
  showCache: boolean
  showReasoning: boolean
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

type QuotaLabel = "5h" | "Daily" | "Weekly" | "Monthly"

type QuotaWindow = {
  percent: number
  resetsAt: number
  label?: QuotaLabel
}

type Credentials = {
  accessToken: string
  accountId?: string
}

type ModelRef = { providerID?: string; modelID?: string }

function resolveOptions(input: Options | undefined): Resolved {
  return {
    order:
      typeof input?.order === "number" && Number.isFinite(input.order) && input.order > 0
        ? Math.floor(input.order)
        : DEFAULT_ORDER,
    startCollapsed: input?.startCollapsed === true,
    showCost: input?.showCost === true,
    showCache: input?.showCache !== false,
    showReasoning: input?.showReasoning !== false,
  }
}

function summarize(messages: ReadonlyArray<Message>): Summary {
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
    if (message.role !== "assistant") continue
    summary.requests += 1
    summary.cost += message.cost ?? 0
    summary.input += message.tokens.input
    summary.output += message.tokens.output
    summary.reasoning += message.tokens.reasoning
    summary.cacheRead += message.tokens.cache.read
    summary.cacheWrite += message.tokens.cache.write
  }
  return summary
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value < 1_000) return String(Math.floor(value))
  const unit = value >= 1_000_000 ? "M" : "K"
  const divisor = value >= 1_000_000 ? 1_000_000 : 1_000
  return (value / divisor).toFixed(1).replace(/\.0$/, "") + unit
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
    return typeof claims.exp === "number" ? claims.exp : 0
  } catch {
    return 0
  }
}

function codexCredentials(raw: string, now: number): Credentials | null {
  try {
    const parsed = JSON.parse(raw) as {
      auth_mode?: unknown
      tokens?: { access_token?: unknown; account_id?: unknown }
    }
    if (parsed.auth_mode !== "chatgpt") return null
    const accessToken = parsed.tokens?.access_token
    if (typeof accessToken !== "string" || !accessToken) return null
    const exp = jwtExpiry(accessToken)
    if (exp > 0 && exp * 1000 <= now + EXPIRY_MARGIN_MS) return null
    const accountId =
      typeof parsed.tokens?.account_id === "string" ? parsed.tokens.account_id : undefined
    return { accessToken, ...(accountId ? { accountId } : {}) }
  } catch {
    return null
  }
}

function quotaLabelForSeconds(seconds: unknown): QuotaLabel | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined
  if (seconds <= 6 * 60 * 60) return "5h"
  if (seconds <= 2 * 24 * 60 * 60) return "Daily"
  if (seconds <= 8 * 24 * 60 * 60) return "Weekly"
  return "Monthly"
}

function parseWhamWindow(window: unknown, now: number): QuotaWindow | null {
  if (!window || typeof window !== "object") return null
  const value = window as {
    used_percent?: unknown
    reset_at?: unknown
    reset_after_seconds?: unknown
    limit_window_seconds?: unknown
  }
  if (typeof value.used_percent !== "number" || !Number.isFinite(value.used_percent)) return null
  const resetsAt =
    typeof value.reset_at === "number" && Number.isFinite(value.reset_at)
      ? value.reset_at * 1000
      : typeof value.reset_after_seconds === "number" &&
          Number.isFinite(value.reset_after_seconds)
        ? now + value.reset_after_seconds * 1000
        : undefined
  if (resetsAt === undefined) return null
  const label = quotaLabelForSeconds(value.limit_window_seconds)
  return {
    percent: Math.min(100, Math.max(0, value.used_percent)),
    resetsAt,
    ...(label ? { label } : {}),
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
    const key = auth["opencode-go"]?.key
    if (typeof key === "string" && key) return key
  } catch {
    // fall through to the environment
  }
  return typeof env === "string" && env ? env : null
}

function sessionModel(api: TuiPluginApi, sessionID: string): ModelRef | undefined {
  return (api.state.session.get(sessionID) as unknown as { model?: ModelRef } | undefined)?.model
}

function promptModel(api: TuiPluginApi): ModelRef | undefined {
  return (api as unknown as { model?: { current?: () => ModelRef | undefined } }).model?.current?.()
}

function modelProvider(api: TuiPluginApi, sessionID: string): QuotaProvider | null {
  for (const candidate of [sessionModel(api, sessionID), promptModel(api)]) {
    if (candidate?.providerID === "openai") return "openai"
    if (candidate?.providerID === "opencode-go") return "opencode-go"
  }
  return null
}

async function openaiCredentials(): Promise<Credentials | null> {
  const now = Date.now()
  try {
    const raw = await readFile(join(homedir(), ".codex", "auth.json"), "utf8")
    const codex = codexCredentials(raw, now)
    if (codex) return codex
  } catch {
    // fall through to opencode auth
  }
  try {
    const raw = await readFile(join(dataDir(), "auth.json"), "utf8")
    const auth = JSON.parse(raw) as Record<
      string,
      { type?: string; access?: string; expires?: number; accountId?: string }
    >
    const entry = auth["openai"]
    if (entry?.access && !(entry.expires && now >= entry.expires)) {
      return { accessToken: entry.access, ...(entry.accountId ? { accountId: entry.accountId } : {}) }
    }
  } catch {
    // no usable credentials
  }
  return null
}

async function fetchOpenAIQuota(): Promise<QuotaWindow[] | null> {
  const credentials = await openaiCredentials()
  if (!credentials) return null
  const headers: Record<string, string> = {
    authorization: `Bearer ${credentials.accessToken}`,
    "user-agent": "codex-cli",
  }
  if (credentials.accountId) headers["chatgpt-account-id"] = credentials.accountId
  try {
    const response = await fetch(OPENAI_USAGE_URL, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const data = (await response.json()) as {
      rate_limit?: { primary_window?: unknown; secondary_window?: unknown }
    }
    const now = Date.now()
    const windows = [
      { fallback: "Daily" as const, window: parseWhamWindow(data.rate_limit?.primary_window, now) },
      { fallback: "Weekly" as const, window: parseWhamWindow(data.rate_limit?.secondary_window, now) },
    ].flatMap(({ fallback, window }) =>
      window ? [{ ...window, label: window.label ?? fallback }] : [],
    )
    return windows.length > 0 ? windows : null
  } catch {
    return null
  }
}

async function fetchGoQuota(): Promise<QuotaWindow[] | null> {
  let key: string | null = null
  try {
    const raw = await readFile(join(dataDir(), "auth.json"), "utf8")
    key = goApiKey(raw, process.env.OPENCODE_API_KEY)
  } catch {
    key = goApiKey("", process.env.OPENCODE_API_KEY)
  }
  if (!key) return null
  try {
    const response = await fetch(OPENCODE_GO_USAGE_URL, {
      headers: {
        authorization: `Bearer ${key}`,
        "user-agent": "opencode-token-usage",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const windows = parseGoUsage(await response.json())
    return windows.length > 0 ? windows : null
  } catch {
    return null
  }
}

function quotaColor(theme: TuiPluginApi["theme"]["current"], percent: number) {
  if (percent > 85) return theme.error
  if (percent >= 50) return theme.warning
  return theme.success
}

function View(props: { api: TuiPluginApi; sessionID: string; options: Resolved }) {
  const theme = () => props.api.theme.current
  const [open, setOpen] = createSignal(!props.options.startCollapsed)
  const [now, setNow] = createSignal(Date.now())
  const [quota, setQuota] = createSignal<QuotaWindow[] | null>(null)

  const messages = createMemo(() => props.api.state.session.messages(props.sessionID))
  const summary = createMemo(() => summarize(messages()))
  const quotaProvider = createMemo<QuotaProvider | null>(() => {
    now()
    return modelProvider(props.api, props.sessionID)
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
    if (!provider) {
      setQuota(null)
      return
    }
    let cancelled = false
    let handle: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const windows = provider === "opencode-go" ? await fetchGoQuota() : await fetchOpenAIQuota()
      if (cancelled) return
      setQuota(windows)
      handle = setTimeout(poll, windows ? POLL_MS : POLL_MS * 3)
    }
    void poll()
    onCleanup(() => {
      cancelled = true
      if (handle) clearTimeout(handle)
    })
  })

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((value) => !value)}>
        <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        <text fg={theme().text}>
          <b>Usage</b>
        </text>
        <text fg={theme().textMuted}>{summary().requests + " reqs"}</text>
      </box>
      <Show when={open()}>
        <text fg={theme().textMuted}>
          {"In " + formatTokens(summary().input) + " · Out " + formatTokens(summary().output)}
        </text>
        <Show when={props.options.showCache && summary().cacheRead + summary().cacheWrite > 0}>
          <text fg={theme().textMuted}>
            {"Cache " +
              formatTokens(summary().cacheRead) +
              "↓ " +
              formatTokens(summary().cacheWrite) +
              "↑"}
          </text>
        </Show>
        <Show when={props.options.showReasoning && summary().reasoning > 0}>
          <text fg={theme().textMuted}>{"Think " + formatTokens(summary().reasoning)}</text>
        </Show>
        <Show when={props.options.showCost && summary().cost > 0}>
          <text fg={theme().textMuted}>{money.format(summary().cost)}</text>
        </Show>
        <Show when={active().length > 0}>
          <box flexDirection="column">
            <text fg={theme().textMuted}>{quotaTitle()}</text>
            <For each={active()}>
              {(window, index) => {
                const percent = () => Math.round(window.percent)
                const filled = () => Math.round((percent() / 100) * 6)
                return (
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().textMuted}>
                      {window.label ?? (index() === 0 ? "Daily" : "Weekly")}
                    </text>
                    <text fg={quotaColor(theme(), percent())}>{"▓".repeat(filled())}</text>
                    <text fg={theme().textMuted}>{"░".repeat(6 - filled())}</text>
                    <text fg={theme().text}>{percent() + "%"}</text>
                    <text fg={theme().textMuted}>
                      {"· " + fmtDuration(window.resetsAt - now())}
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const resolved = resolveOptions(options as Options | undefined)
  if ((options as Options | undefined)?.enabled === false) return

  api.slots.register({
    order: resolved.order,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} sessionID={props.session_id} options={resolved} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "token-usage",
  tui,
}

export {
  codexCredentials,
  dataDir,
  fmtDuration,
  formatTokens,
  goApiKey,
  jwtExpiry,
  parseGoUsage,
  parseWhamWindow,
  resolveOptions,
  summarize,
}
export type { Credentials, Options, QuotaLabel, QuotaWindow, Resolved, Summary }
export default plugin
