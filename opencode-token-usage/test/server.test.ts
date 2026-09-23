import { afterEach, expect, test } from "bun:test"
import plugin from "../server"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

type Credential = { type: "oauth"; access: string; expires: number; metadata?: Record<string, unknown> } | { type: "key"; key: string }

async function invoke(credential: Credential | undefined, connection = true) {
  let registered: ((input: unknown, context: { signal: AbortSignal }) => Promise<unknown>) | undefined
  const calls: string[] = []
  const ctx = {
    integration: { connection: {
      active: async (provider: string) => { calls.push(`active:${provider}`); return connection ? { id: "active" } : undefined },
      resolve: async () => { calls.push("resolve"); return credential },
    } },
    rpc: { register: async (_definition: unknown, methods: { openai: typeof registered }) => {
      registered = methods.openai
      return { dispose: async () => {} }
    } },
  }
  const cleanup = await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0])
  if (!registered) throw new Error("RPC not registered")
  const result = await registered({}, { signal: new AbortController().signal })
  if (typeof cleanup === "function") cleanup()
  return { result, calls }
}

test("server fetches quota using only the active V2 OpenAI OAuth credential", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    return Response.json({ rate_limit: { primary_window: {
      used_percent: 37, reset_after_seconds: 1800, limit_window_seconds: 18_000,
    } } })
  }) as typeof fetch
  const { result, calls } = await invoke({
    type: "oauth", access: "v2-secret", expires: Date.now() + 3_600_000,
    metadata: { accountId: "selected-account" },
  })
  expect(calls).toEqual(["active:openai", "resolve"])
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe("https://chatgpt.com/backend-api/wham/usage")
  expect(requests[0].init?.headers).toMatchObject({
    authorization: "Bearer v2-secret", "chatgpt-account-id": "selected-account",
  })
  expect(requests[0].init?.redirect).toBe("error")
  expect(result).toMatchObject({ windows: [{ percent: 37, label: "5h" }] })
  expect(JSON.stringify(result)).not.toContain("v2-secret")
})

test("server does not fetch with an absent, key-based, or expiring OpenAI connection", async () => {
  globalThis.fetch = (async () => { throw new Error("unexpected network request") }) as unknown as typeof fetch
  expect((await invoke(undefined, false)).result).toEqual({ windows: [] })
  expect((await invoke({ type: "key", key: "unused" })).result).toEqual({ windows: [] })
  expect((await invoke({ type: "oauth", access: "expired", expires: Date.now() })).result).toEqual({ windows: [] })
})
