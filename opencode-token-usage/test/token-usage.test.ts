import { expect, test } from "bun:test"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { homedir } from "node:os"
import { join } from "node:path"
import {
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
} from "../tui/token-usage"

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

function user(): Message {
  return { role: "user" } as unknown as Message
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`
}

test("resolveOptions applies defaults", () => {
  expect(resolveOptions(undefined)).toEqual({
    order: 110,
    startCollapsed: false,
    showCost: false,
    showCache: true,
    showReasoning: true,
    showQuota: true,
  })
})

test("resolveOptions honors overrides and rejects bad values", () => {
  expect(
    resolveOptions({
      order: 300,
      startCollapsed: true,
      showCost: true,
      showCache: false,
      showReasoning: false,
    }),
  ).toEqual({
    order: 300,
    startCollapsed: true,
    showCost: true,
    showCache: false,
    showReasoning: false,
    showQuota: true,
  })
  expect(resolveOptions({ order: 0 }).order).toBe(110)
  expect(resolveOptions({ order: -5 }).order).toBe(110)
  expect(resolveOptions({ order: Number.POSITIVE_INFINITY }).order).toBe(110)
})

test("summarize returns zeros for no messages", () => {
  expect(summarize([])).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
    cost: 0,
  })
})

test("summarize sums assistant tokens and counts requests", () => {
  const summary = summarize([
    assistant({ input: 100, output: 20, reasoning: 5, cacheRead: 8, cacheWrite: 2, cost: 0.01 }),
  ])
  expect(summary).toEqual({
    input: 100,
    output: 20,
    reasoning: 5,
    cacheRead: 8,
    cacheWrite: 2,
    requests: 1,
    cost: 0.01,
  })
})

test("summarize ignores user messages and accumulates across turns", () => {
  const summary = summarize([
    user(),
    assistant({ input: 100, output: 10, cost: 0.01 }),
    user(),
    assistant({ input: 200, output: 30, cost: 0.02 }),
  ])
  expect(summary.input).toBe(300)
  expect(summary.output).toBe(40)
  expect(summary.requests).toBe(2)
  expect(summary.cost).toBeCloseTo(0.03)
})

test("formatTokens abbreviates thousands and millions", () => {
  expect(formatTokens(0)).toBe("0")
  expect(formatTokens(999)).toBe("999")
  expect(formatTokens(1000)).toBe("1K")
  expect(formatTokens(1500)).toBe("1.5K")
  expect(formatTokens(12400)).toBe("12.4K")
  expect(formatTokens(1_000_000)).toBe("1M")
  expect(formatTokens(1_200_000)).toBe("1.2M")
  expect(formatTokens(12_500_000)).toBe("12.5M")
})

test("fmtDuration formats hours, minutes and days", () => {
  expect(fmtDuration(0)).toBe("0h 0m")
  expect(fmtDuration(90_000)).toBe("0h 2m")
  expect(fmtDuration(3_600_000)).toBe("1h 0m")
  expect(fmtDuration(11_040_000)).toBe("3h 4m")
  expect(fmtDuration(126_000_000)).toBe("1d 11h")
})

test("dataDir follows OpenCode's XDG data directory", () => {
  const previous = process.env.XDG_DATA_HOME
  try {
    process.env.XDG_DATA_HOME = "/tmp/xdg-data"
    expect(dataDir()).toBe(join("/tmp/xdg-data", "opencode"))
    process.env.XDG_DATA_HOME = ""
    expect(dataDir()).toBe(join(homedir(), ".local", "share", "opencode"))
    delete process.env.XDG_DATA_HOME
    expect(dataDir()).toBe(join(homedir(), ".local", "share", "opencode"))
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
  }
})

test("jwtExpiry reads exp and tolerates junk", () => {
  expect(jwtExpiry(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000)
  expect(jwtExpiry("not-a-jwt")).toBe(0)
  expect(jwtExpiry(jwt({}))).toBe(0)
})

test("codexCredentials returns a fresh ChatGPT token", () => {
  const raw = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt({ exp: 4_000_000_000 }),
      account_id: "acct_123",
    },
  })
  expect(codexCredentials(raw, 1_000)).toEqual({
    accessToken: jwt({ exp: 4_000_000_000 }),
    accountId: "acct_123",
  })
})

test("codexCredentials rejects expired and non-oauth auth", () => {
  const expired = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: jwt({ exp: 1_000 }), account_id: "acct_123" },
  })
  expect(codexCredentials(expired, 2_000_000)).toBeNull()

  const apiKey = JSON.stringify({
    auth_mode: "apikey",
    tokens: { access_token: jwt({ exp: 4_000_000_000 }), account_id: "acct_stale" },
    OPENAI_API_KEY: "sk-x",
  })
  expect(codexCredentials(apiKey, 1_000)).toBeNull()
  expect(codexCredentials("not json", 1_000)).toBeNull()
})

test("parseWhamWindow reads reset_at seconds", () => {
  expect(parseWhamWindow({ used_percent: 42, reset_at: 1_700_000_000 }, 1_000)).toEqual({
    percent: 42,
    resetsAt: 1_700_000_000_000,
  })
})

test("parseWhamWindow reads reset_after_seconds relative to now", () => {
  expect(parseWhamWindow({ used_percent: 10, reset_after_seconds: 3_600 }, 1_000)).toEqual({
    percent: 10,
    resetsAt: 1_000 + 3_600_000,
  })
})

test("parseWhamWindow clamps percent and rejects incomplete windows", () => {
  expect(parseWhamWindow({ used_percent: 120, reset_at: 1 }, 0)?.percent).toBe(100)
  expect(parseWhamWindow({ used_percent: -5, reset_at: 1 }, 0)?.percent).toBe(0)
  expect(parseWhamWindow({ reset_at: 1 }, 0)).toBeNull()
  expect(parseWhamWindow({ used_percent: 10 }, 0)).toBeNull()
  expect(parseWhamWindow(null, 0)).toBeNull()
})

test("parseWhamWindow labels windows from limit_window_seconds", () => {
  expect(
    parseWhamWindow({ used_percent: 42, reset_at: 1_700_000_000, limit_window_seconds: 18_000 }, 0)
      ?.label,
  ).toBe("5h")
  expect(
    parseWhamWindow({ used_percent: 42, reset_at: 1_700_000_000, limit_window_seconds: 86_400 }, 0)
      ?.label,
  ).toBe("Daily")
  expect(
    parseWhamWindow({ used_percent: 42, reset_at: 1_700_000_000, limit_window_seconds: 604_800 }, 0)
      ?.label,
  ).toBe("Weekly")
  expect(
    parseWhamWindow({ used_percent: 42, reset_at: 1_700_000_000, limit_window_seconds: 2_592_000 }, 0)
      ?.label,
  ).toBe("Monthly")
  expect(parseWhamWindow({ used_percent: 42, reset_at: 1_700_000_000 }, 0)?.label).toBeUndefined()
})

test("goApiKey reads the opencode-go auth entry", () => {
  const raw = JSON.stringify({
    "opencode-go": { type: "api", key: "sk-go" },
    opencode: { type: "api", key: "sk-zen" },
  })
  expect(goApiKey(raw)).toBe("sk-go")
})

test("goApiKey falls back to OPENCODE_API_KEY and rejects missing keys", () => {
  expect(goApiKey("not json", "sk-env")).toBe("sk-env")
  expect(goApiKey(JSON.stringify({ opencode: { key: "sk-zen" } }), undefined)).toBeNull()
  expect(goApiKey(JSON.stringify({ "opencode-go": { type: "api" } }), "")).toBeNull()
  expect(goApiKey(JSON.stringify({ "opencode-go": { key: "" } }), undefined)).toBeNull()
})

test("parseGoUsage maps rolling, weekly and monthly windows", () => {
  const payload = {
    usage: {
      rolling: { status: "ok", percent: 31, resetsAt: "2026-09-22T05:24:25.981Z" },
      weekly: { status: "ok", percent: 13, resetsAt: "2026-09-28T00:00:00.000Z" },
      monthly: { status: "rate-limited", percent: 54, resetsAt: "2026-10-12T20:59:47.000Z" },
    },
  }
  expect(parseGoUsage(payload)).toEqual([
    { percent: 31, resetsAt: Date.parse("2026-09-22T05:24:25.981Z"), label: "5h" },
    { percent: 13, resetsAt: Date.parse("2026-09-28T00:00:00.000Z"), label: "Weekly" },
    { percent: 54, resetsAt: Date.parse("2026-10-12T20:59:47.000Z"), label: "Monthly" },
  ])
})

test("parseGoUsage clamps percent and skips invalid windows", () => {
  expect(
    parseGoUsage({ usage: { rolling: { percent: 120, resetsAt: "2026-09-22T05:24:25.981Z" } } })[0]
      ?.percent,
  ).toBe(100)
  expect(
    parseGoUsage({ usage: { weekly: { percent: -5, resetsAt: "2026-09-28T00:00:00.000Z" } } })[0]
      ?.percent,
  ).toBe(0)
  expect(parseGoUsage({ usage: { monthly: { resetsAt: "2026-10-12T20:59:47.000Z" } } })).toEqual([])
  expect(parseGoUsage({ usage: { rolling: { percent: 10, resetsAt: "garbage" } } })).toEqual([])
  expect(parseGoUsage({ usage: { rolling: null, weekly: "nope" } })).toEqual([])
  expect(parseGoUsage({})).toEqual([])
  expect(parseGoUsage(null)).toEqual([])
})

function rawMessage(value: unknown): Message {
  return value as Message
}

// Q4: showQuota defaults to true; only explicit false disables it.
test("resolveOptions defaults showQuota to true and honors explicit false", () => {
  expect(resolveOptions(undefined).showQuota).toBe(true)
  expect(resolveOptions({}).showQuota).toBe(true)
  expect(resolveOptions({ showQuota: true }).showQuota).toBe(true)
  expect(resolveOptions({ showQuota: false }).showQuota).toBe(false)
})

// U3: slot orders below one fall back to 110; valid orders are floored.
test("resolveOptions floors valid slot orders and rejects orders below one", () => {
  expect(resolveOptions({ order: 1 }).order).toBe(1)
  expect(resolveOptions({ order: 1.9 }).order).toBe(1)
  expect(resolveOptions({ order: 2.5 }).order).toBe(2)
  expect(resolveOptions({ order: 300 }).order).toBe(300)
  expect(resolveOptions({ order: 0.999 }).order).toBe(110)
  expect(resolveOptions({ order: 0 }).order).toBe(110)
})

// U1: incomplete assistant messages are still counted as requests.
test("summarize tolerates incomplete assistant messages and counts them", () => {
  const summary = summarize([
    rawMessage({ role: "assistant" }),
    rawMessage({ role: "assistant", tokens: undefined, cost: undefined }),
    rawMessage({ role: "assistant", tokens: null }),
    rawMessage({ role: "assistant", tokens: {} }),
  ])
  expect(summary).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 4,
    cost: 0,
  })
})

// U1: invalid fields contribute zero without erasing valid fields on the same message.
test("summarize ignores invalid fields without discarding valid ones", () => {
  const summary = summarize([
    rawMessage({
      role: "assistant",
      cost: 0.5,
      tokens: {
        input: 100,
        output: "200",
        reasoning: -5,
        cache: { read: Number.NaN, write: Number.POSITIVE_INFINITY },
      },
    }),
  ])
  expect(summary).toEqual({
    input: 100,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 1,
    cost: 0.5,
  })
})

// U1: exact finite totals across a mixture of valid, incomplete and invalid messages.
test("summarize returns exact finite totals across mixed messages", () => {
  const summary = summarize([
    user(),
    rawMessage({
      role: "assistant",
      cost: 1.25,
      tokens: { input: 1000, output: 250, reasoning: 40, cache: { read: 10, write: 5 } },
    }),
    rawMessage({
      role: "assistant",
      cost: -3,
      tokens: {
        input: -1,
        output: 250,
        reasoning: Number.NaN,
        cache: { read: null, write: "x" },
      },
    }),
    rawMessage({ role: "assistant" }),
  ])
  expect(summary).toEqual({
    input: 1000,
    output: 500,
    reasoning: 40,
    cacheRead: 10,
    cacheWrite: 5,
    requests: 3,
    cost: 1.25,
  })
})

// U2: invalid values collapse to "0"; sub-thousand values truncate.
test("formatTokens returns 0 for invalid values and truncates below one thousand", () => {
  expect(formatTokens(Number.NaN)).toBe("0")
  expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0")
  expect(formatTokens(-1)).toBe("0")
  expect(formatTokens(999.9)).toBe("999")
  expect(formatTokens(1.9)).toBe("1")
})

// U2: billions use a compact B suffix.
test("formatTokens supports billions", () => {
  expect(formatTokens(1_000_000_000)).toBe("1B")
  expect(formatTokens(1_200_000_000)).toBe("1.2B")
  expect(formatTokens(12_500_000_000)).toBe("12.5B")
})

// U2: rounded unit boundaries promote to the next unit instead of rendering 1000K/1000M.
test("formatTokens promotes rounded K and M boundaries", () => {
  expect(formatTokens(999_949)).toBe("999.9K")
  expect(formatTokens(999_950)).toBe("1M")
  expect(formatTokens(999_999)).toBe("1M")
  expect(formatTokens(999_950_000)).toBe("1B")
  expect(formatTokens(999_999_999)).toBe("1B")
})

// U3: nonfinite reset arithmetic, including overflow from finite inputs, is rejected.
test("parseWhamWindow rejects nonfinite reset arithmetic", () => {
  expect(parseWhamWindow({ used_percent: 10, reset_at: Number.MAX_VALUE }, 0)).toBeNull()
  expect(parseWhamWindow({ used_percent: 10, reset_after_seconds: Number.MAX_VALUE }, 0)).toBeNull()
  expect(parseWhamWindow({ used_percent: 10, reset_at: Number.POSITIVE_INFINITY }, 0)).toBeNull()
  expect(parseWhamWindow({ used_percent: 10, reset_at: Number.NaN }, 0)).toBeNull()
  expect(parseWhamWindow({ used_percent: 10, reset_at: 1.7e12 }, 0)?.resetsAt).toBe(1.7e15)
})

// C1: Codex parser rejects malformed and whitespace-bearing tokens.
test("codexCredentials rejects whitespace, empty and non-string tokens", () => {
  expect(
    codexCredentials(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a b" } }), 0),
  ).toBeNull()
  expect(
    codexCredentials(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "" } }), 0),
  ).toBeNull()
  expect(
    codexCredentials(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: 123 } }), 0),
  ).toBeNull()
  expect(codexCredentials(JSON.stringify({ auth_mode: "chatgpt" }), 0)).toBeNull()
  expect(codexCredentials(JSON.stringify({ auth_mode: "chatgpt", tokens: null }), 0)).toBeNull()
})

// C1: valid opaque tokens survive; invalid optional account IDs are omitted.
test("codexCredentials accepts opaque tokens and omits invalid account ids", () => {
  expect(
    codexCredentials(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "opaque-token", account_id: "bad id" },
      }),
      1_000,
    ),
  ).toEqual({ accessToken: "opaque-token" })
})

// C1/C2: Codex JWT expiry margin is exclusive at now + 60s.
test("codexCredentials enforces the JWT expiration margin", () => {
  const now = 1_000_000
  const atMargin = jwt({ exp: (now + 60_000) / 1000 })
  expect(
    codexCredentials(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: atMargin } }), now),
  ).toBeNull()
  const pastMargin = jwt({ exp: (now + 60_001) / 1000 })
  expect(
    codexCredentials(
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: pastMargin } }),
      now,
    ),
  ).toEqual({ accessToken: pastMargin })
})

// C1: OpenCode parser accepts oauth and legacy entries with exact values.
test("opencodeCredentials accepts oauth and legacy entries with exact values", () => {
  const now = 1_000_000
  const oauth = JSON.stringify({
    openai: { type: "oauth", access: "opaque-access", expires: now + 3_600_000, accountId: "acct_1" },
  })
  expect(opencodeCredentials(oauth, now)).toEqual({ accessToken: "opaque-access", accountId: "acct_1" })
  expect(opencodeCredentials(JSON.stringify({ openai: { access: "legacy-access" } }), now)).toEqual({
    accessToken: "legacy-access",
  })
})

// C1/C2: malformed entries, wrong auth type and malformed expiry all reject.
test("opencodeCredentials rejects wrong types, whitespace tokens and malformed expires", () => {
  const now = 1_000_000
  const reject = (entry: unknown) =>
    expect(opencodeCredentials(JSON.stringify({ openai: entry }), now)).toBeNull()
  reject({ type: "apikey", access: "token" })
  reject({ type: 7, access: "token" })
  reject({ type: "oauth", access: "has space" })
  reject({ type: "oauth", access: "" })
  reject({ type: "oauth", access: 42 })
  reject({ type: "oauth", access: "token", expires: "later" })
  reject({ type: "oauth", access: "token", expires: Number.NaN })
  reject({ type: "oauth", access: "token", expires: Number.POSITIVE_INFINITY })
  reject({ type: "oauth", access: "token", expires: 0 })
  reject({ type: "oauth", access: "token", expires: -1 })
  reject({ type: "oauth", access: "token", expires: now })
  reject({ type: "oauth" })
  expect(opencodeCredentials(JSON.stringify({}), now)).toBeNull()
  expect(opencodeCredentials(JSON.stringify({ openai: null }), now)).toBeNull()
  expect(opencodeCredentials("not-json", now)).toBeNull()
})

// C2: OpenCode `expires` margin and JWT fallback.
test("opencodeCredentials enforces the expiry margin and JWT fallback", () => {
  const now = 2_000_000
  expect(
    opencodeCredentials(
      JSON.stringify({ openai: { type: "oauth", access: "token", expires: now + 60_000 } }),
      now,
    ),
  ).toBeNull()
  expect(
    opencodeCredentials(
      JSON.stringify({ openai: { type: "oauth", access: "token", expires: now + 60_001 } }),
      now,
    ),
  ).toEqual({ accessToken: "token" })

  const nearJwt = jwt({ exp: (now + 60_000) / 1000 })
  expect(opencodeCredentials(JSON.stringify({ openai: { access: nearJwt } }), now)).toBeNull()
  const freshJwt = jwt({ exp: (now + 60_001) / 1000 })
  expect(opencodeCredentials(JSON.stringify({ openai: { access: freshJwt } }), now)).toEqual({
    accessToken: freshJwt,
  })

  // A valid `expires` must not mask a JWT that is itself too close to expiry.
  expect(
    opencodeCredentials(
      JSON.stringify({ openai: { type: "oauth", access: nearJwt, expires: now + 3_600_000 } }),
      now,
    ),
  ).toBeNull()
})

// C1: invalid optional OpenCode account IDs are omitted.
test("opencodeCredentials omits invalid optional account ids", () => {
  expect(
    opencodeCredentials(JSON.stringify({ openai: { access: "token", accountId: "bad id" } }), 0),
  ).toEqual({ accessToken: "token" })
})

// C2: jwtExpiry treats missing/invalid/nonfinite claims as zero.
test("jwtExpiry returns zero for missing or nonfinite exp claims", () => {
  expect(jwtExpiry(jwt({ exp: Number.POSITIVE_INFINITY }))).toBe(0)
  expect(jwtExpiry(jwt({ exp: Number.NaN }))).toBe(0)
  expect(jwtExpiry(jwt({ exp: "1700000000" }))).toBe(0)
  expect(jwtExpiry("only-one-part")).toBe(0)
  expect(jwtExpiry("")).toBe(0)
  expect(jwtExpiry("a.!!!.c")).toBe(0)
})

// C3: Go key prefers a valid file key and only falls back to a valid env value.
test("goApiKey prefers a valid file key and rejects whitespace keys", () => {
  expect(goApiKey(JSON.stringify({ "opencode-go": { key: "file-key" } }), "env-key")).toBe("file-key")
  expect(goApiKey(JSON.stringify({ "opencode-go": { key: "bad key" } }), "env-key")).toBe("env-key")
  expect(goApiKey(JSON.stringify({ "opencode-go": { key: 7 } }), "env-key")).toBe("env-key")
  expect(goApiKey(JSON.stringify({ "opencode-go": { key: "file-key" } }), "bad env")).toBe("file-key")
  expect(goApiKey("not json", "bad env")).toBeNull()
  expect(goApiKey("not json", undefined)).toBeNull()
})
