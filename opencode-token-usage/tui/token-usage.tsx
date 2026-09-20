/** @jsxImportSource @opentui/solid */
/**
 * Token usage (TUI plugin)
 *
 * Adds a live per-session token usage section to the session sidebar, and
 * shows ChatGPT/Codex subscription quota only while the session model is an
 * OpenAI model.
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

type QuotaWindow = {
  percent: number
  resetsAt: number
  label?: "Daily" | "Weekly"
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

function parseWhamWindow(window: unknown, now: number): QuotaWindow | null {
  if (!window || typeof window !== "object") return null
  const value = window as {
    used_percent?: unknown
    reset_at?: unknown
    reset_after_seconds?: unknown
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
  return { percent: Math.min(100, Math.max(0, value.used_percent)), resetsAt }
}

function modelProvider(api: TuiPluginApi, sessionID: string): string | undefined {
  const local = (
    api as unknown as { model?: { current?: () => ModelRef | undefined } }
  ).model?.current?.()
  if (local?.providerID) return local.providerID
  const session = api.state.session.get(sessionID) as unknown as { model?: ModelRef } | undefined
  return session?.model?.providerID
}

async function openaiCredentials(api: TuiPluginApi): Promise<Credentials | null> {
  const now = Date.now()
  try {
    const raw = await readFile(join(homedir(), ".codex", "auth.json"), "utf8")
    const codex = codexCredentials(raw, now)
    if (codex) return codex
  } catch {
    // fall through to opencode auth
  }
  try {
    const raw = await readFile(join(api.state.path.state, "auth.json"), "utf8")
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

async function fetchOpenAIQuota(api: TuiPluginApi): Promise<QuotaWindow[] | null> {
  const credentials = await openaiCredentials(api)
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
      { label: "Daily" as const, window: parseWhamWindow(data.rate_limit?.primary_window, now) },
      { label: "Weekly" as const, window: parseWhamWindow(data.rate_limit?.secondary_window, now) },
    ].flatMap(({ label, window }) => (window ? [{ ...window, label }] : []))
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
  const isOpenAI = createMemo(() => modelProvider(props.api, props.sessionID) === "openai")
  const active = createMemo(() => (quota() ?? []).filter((window) => window.resetsAt > now()))

  const clock = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(clock))

  createEffect(() => {
    if (!isOpenAI()) {
      setQuota(null)
      return
    }
    let cancelled = false
    let handle: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const windows = await fetchOpenAIQuota(props.api)
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
        <Show when={isOpenAI() && active().length > 0}>
          <box flexDirection="column">
            <text fg={theme().textMuted}>OpenAI</text>
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
  fmtDuration,
  formatTokens,
  jwtExpiry,
  parseWhamWindow,
  resolveOptions,
  summarize,
}
export type { Credentials, Options, QuotaWindow, Resolved, Summary }
export default plugin
