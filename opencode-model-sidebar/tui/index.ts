import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"

function hostMajor(version: string | undefined): number {
  const major = /^v?(\d+)(?:\.|$)/.exec(version ?? "")?.[1]
  if (major !== "1" && major !== "2") {
    throw new Error(`model-sidebar: unsupported OpenCode version ${JSON.stringify(version)}`)
  }
  return Number(major)
}

// The host loads this module in both generations; importing either implementation
// before knowing the host version would load the other generation's plugin API.
export default {
  id: "model-sidebar",
  async tui(...[api, options, meta]: Parameters<TuiPlugin>) {
    if (hostMajor((api as typeof api & { app?: { version?: string } }).app?.version) !== 1) {
      throw new Error("model-sidebar: tui() requires OpenCode V1")
    }
    const { default: v1 } = await import("./model-sidebar")
    return v1.tui(api, options, meta)
  },
  async setup(context: Context) {
    if (hostMajor(context.app.version) !== 2) {
      throw new Error("model-sidebar: setup() requires OpenCode V2")
    }
    const { default: v2 } = await import("./model-sidebar-v2")
    return v2.setup(context)
  },
}
