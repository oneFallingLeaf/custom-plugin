import { Plugin } from "@opencode/plugin"
import { Buffer } from "node:buffer"
import { parseWhamUsage } from "../quota"
import { TokenUsageQuota } from "../rpc"

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const FETCH_TIMEOUT_MS = 10_000
const EXPIRY_MARGIN_MS = 60_000

function accountID(token: string, metadata: Record<string, unknown> | undefined): string | undefined {
  const fromMetadata = metadata?.accountId ?? metadata?.account_id
  if (typeof fromMetadata === "string" && fromMetadata.length > 0) return fromMetadata
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown }
    }
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id
    return typeof id === "string" && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

export const plugin = Plugin.define({
  id: "token-usage-quota",
  async setup(ctx) {
    const registration = await ctx.rpc.register(TokenUsageQuota, {
      openai: async (_input, { signal }) => {
        // Resolve on the connected server at request time so switches and refreshes
        // use the active account. Never send the credential over plugin RPC.
        const connection = await ctx.integration.connection.active("openai")
        if (!connection || signal.aborted) return { windows: [] }
        const credential = await ctx.integration.connection.resolve(connection)
        if (credential?.type !== "oauth" || credential.expires <= Date.now() + EXPIRY_MARGIN_MS || signal.aborted) {
          return { windows: [] }
        }
        const headers: Record<string, string> = {
          authorization: `Bearer ${credential.access}`,
          "user-agent": "codex-cli",
        }
        const id = accountID(credential.access, credential.metadata)
        if (id) headers["chatgpt-account-id"] = id
        try {
          const response = await fetch(OPENAI_USAGE_URL, {
            headers,
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
          })
          if (!response.ok) return { windows: [] }
          return { windows: parseWhamUsage(await response.json(), Date.now()) }
        } catch {
          return { windows: [] }
        }
      },
    })
    return () => { void registration.dispose() }
  },
})

export default plugin
