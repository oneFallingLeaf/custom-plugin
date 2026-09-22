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
