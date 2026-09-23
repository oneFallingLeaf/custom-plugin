/** Version-specific entrypoint. Do not import either runtime before the host calls its API. */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"

function requireVersion(version: unknown, major: 1 | 2): void {
  if (typeof version !== "string" || !new RegExp(`^${major}\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.+-]+)?$`).test(version)) {
    throw new Error(`token-usage: ${major === 1 ? "tui" : "setup"} requires OpenCode V${major} (received ${String(version)})`)
  }
}

export default {
  id: "token-usage",
  tui: (async (api, options, meta) => {
    requireVersion(api.app?.version, 1)
    const { default: plugin } = await import("./token-usage-v1")
    return plugin.tui(api, options, meta)
  }) satisfies TuiPlugin,
  async setup(ctx: Context) {
    requireVersion(ctx.app?.version, 2)
    const { default: plugin } = await import("./token-usage-v2")
    return plugin.setup(ctx)
  },
}
