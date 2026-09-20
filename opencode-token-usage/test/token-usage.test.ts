import { expect, test } from "bun:test"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import {
  codexCredentials,
  fmtDuration,
  formatTokens,
  jwtExpiry,
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
