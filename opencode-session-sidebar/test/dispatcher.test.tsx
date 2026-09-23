import { expect, test } from "bun:test"
import plugin from "../tui/index"

test("hybrid entry dispatches to V1 with its options and owns its lifecycle", async () => {
  const slots: Array<{ slots: Record<string, unknown> }> = []
  const layers: Array<{ bindings?: Array<{ key: string; cmd: string; desc?: string }> }> = []
  const unsubscribed: string[] = []
  const removed: string[] = []
  let dispose = () => {}
  const api = {
    app: { version: "1.18.29" },
    route: { current: { name: "home" } },
    ui: { dialog: { open: false } },
    renderer: {
      isDestroyed: false,
      keyInput: { on(name: string) { removed.push(`on:${name}`) }, off(name: string) { removed.push(`off:${name}`) } },
      on(name: string) { removed.push(`on:${name}`) },
      off(name: string) { removed.push(`off:${name}`) },
    },
    slots: { register(value: { slots: Record<string, unknown> }) { slots.push(value) } },
    keymap: { registerLayer(value: { bindings?: Array<{ key: string; cmd: string; desc?: string }> }) { layers.push(value) } },
    event: { on(name: string) { return () => unsubscribed.push(name) } },
    lifecycle: { onDispose(callback: () => void) { dispose = callback } },
  } as unknown as Parameters<typeof plugin.tui>[0]

  expect(plugin.id).toBe("session-sidebar")
  await plugin.tui(api, { openKey: "ctrl+g" }, {} as Parameters<typeof plugin.tui>[2])
  expect(slots).toHaveLength(1)
  expect(Object.keys(slots[0]!.slots).sort()).toEqual(["app", "home_prompt_right", "session_prompt_right"])
  expect(layers).toHaveLength(3)
  expect(layers[1]!.bindings).toEqual([{ key: "ctrl+g", cmd: "session.panel.toggle", desc: "Open sessions panel" }])
  dispose()
  expect(unsubscribed.sort()).toEqual(["session.created", "session.deleted", "session.status", "session.updated"])
  expect(removed).toEqual(["on:keypress", "on:focused_editor", "off:focused_editor", "off:keypress"])
})

test("hybrid entry dispatches to V2 and returns its cleanup", async () => {
  const claims: string[] = []
  const released: string[] = []
  const ctx = {
    app: { version: "2.0.12" },
    options: {},
    ui: { slot(input: { append: string }) { claims.push(input.append); return () => released.push(input.append) } },
  } as unknown as Parameters<typeof plugin.setup>[0]
  const cleanup = await plugin.setup(ctx)
  expect(claims).toEqual(["prompt.footer.status", "app"])
  cleanup?.()
  expect(released).toEqual(claims)
})

test("wrong or unknown host version is rejected before loading incompatible APIs", async () => {
  for (const version of ["2.0.12", "unknown", undefined]) {
    await expect(plugin.tui({ app: { version } } as Parameters<typeof plugin.tui>[0], {}, {} as Parameters<typeof plugin.tui>[2]))
      .rejects.toThrow("expected OpenCode V1")
  }
  for (const version of ["1.18.29", "unknown", undefined]) {
    await expect(plugin.setup({ app: { version } } as Parameters<typeof plugin.setup>[0]))
      .rejects.toThrow("expected OpenCode V2")
  }
})

test("hybrid entry and implementations have no eager cross-version runtime imports", async () => {
  const entry = await Bun.file(new URL("../tui/index.ts", import.meta.url)).text()
  const v1 = await Bun.file(new URL("../tui/v1.tsx", import.meta.url)).text()
  const v2 = await Bun.file(new URL("../tui/v2.tsx", import.meta.url)).text()
  expect(entry).not.toMatch(/^import\s+(?!type\b)/m)
  expect(entry).toContain('await import("./v1")')
  expect(entry).toContain('await import("./v2")')
  expect(v1).not.toContain('from "@opencode/plugin')
  expect(v2).not.toContain('from "@opencode-ai/')
})

test("package root and ./tui resolve to the same hybrid entrypoint for host discovery", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(manifest.exports["."]).toBe("./tui/index.ts")
  expect(manifest.exports["./tui"]).toBe(manifest.exports["."])
  expect(Object.keys(manifest.exports)).toEqual([".", "./tui", "./v1", "./v2"])
})
