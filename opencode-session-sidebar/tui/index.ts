// Keep the two incompatible TUI runtimes out of this entrypoint's import graph.
// OpenCode V1 calls tui(api, options); OpenCode V2 calls setup(ctx).
function requireMajor(version: unknown, major: 1 | 2): void {
  if (typeof version === "string" && new RegExp(`^${major}(?:[.-]|$)`).test(version)) return
  throw new Error(`opencode-session-sidebar: expected OpenCode V${major}, received ${String(version)}`)
}

export default {
  id: "session-sidebar",
  async tui(api: import("@opencode-ai/plugin/tui").TuiPluginApi, options: import("@opencode-ai/plugin").PluginOptions | undefined, meta: import("@opencode-ai/plugin/tui").TuiPluginMeta) {
    requireMajor(api.app.version, 1)
    const { default: plugin } = await import("./v1")
    return plugin.tui(api, options, meta)
  },
  async setup(ctx: import("@opencode/plugin/tui/context").Context) {
    requireMajor(ctx.app.version, 2)
    const { default: plugin } = await import("./v2")
    return plugin.setup(ctx)
  },
}
