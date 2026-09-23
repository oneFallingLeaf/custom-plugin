/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapLayer, SlotPath } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { createSignal } from "solid-js"
import plugin from "../tui/v2"

function session(id: string, updated: number, projectID = "project", parentID?: string): SessionInfo {
  return { id, projectID, parentID, title: `Session ${id}`, time: { created: updated, updated }, location: { directory: "/project" }, cost: 0, tokens: {} } as SessionInfo
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function harness(settings: Record<string, unknown> = {}, size = { width: 80, height: 24 }) {
  const screen = await createTestRenderer({ ...size, useThread: false })
  const slots = new Map<SlotPath, (input: any) => any>()
  const layers: Array<() => KeymapLayer> = []
  const listeners = new Map<string, Set<(event: any) => void>>()
  const requests: unknown[] = []
  const replies: Array<Promise<{ data: SessionInfo[] }>> = []
  const navigations: string[] = []
  const toasts: string[] = []
  const [route, setRoute] = createSignal<{ type: "session"; sessionID: string } | { type: "home" }>({ type: "session", sessionID: "active" })
  let list = [session("old", 1), session("active", 2)]
  let editorFocused = true
  let stops: (() => void) | void
  const editor = { plainText: "", blur: () => { editorFocused = false }, focus: () => { editorFocused = true } }
  Object.defineProperty(screen.renderer, "currentFocusedEditor", { configurable: true, get: () => editorFocused ? editor : null })
  const ctx = {
    options: settings,
    renderer: screen.renderer,
    theme: { background: { raised: { base: "#111111", high: "#333333" } }, border: { base: "#aaaaaa" }, text: { base: "#ffffff", muted: "#888888", action: { primary: { base: "#00aaff" } }, feedback: { success: { base: "#00ff00" } } } },
    client: { session: { list(input: unknown) { requests.push(input); return replies.shift() ?? Promise.resolve({ data: list }) } } },
    data: { session: { get: (id: string) => id === "active" ? session("active", 2) : list.find((s) => s.id === id), status: () => "idle" },
      on(name: string, callback: (event: any) => void) {
        const group = listeners.get(name) ?? new Set()
        group.add(callback); listeners.set(name, group)
        return () => group.delete(callback)
      } },
    ui: {
      slot(claim: { append: SlotPath; render: (input: any) => any }) { slots.set(claim.append, claim.render); return () => slots.delete(claim.append) },
      router: { current: route, navigate: (target: { sessionID: string }) => navigations.push(target.sessionID) },
      toast: { show: (toast: { message: string }) => toasts.push(toast.message) },
    },
    keymap: { layer(input: () => KeymapLayer) { layers.push(input) } },
  } as unknown as Context
  stops = await plugin.setup(ctx)
  async function mount() {
    await render(() => <PluginContextProvider value={ctx}>
      <box width={size.width} height={size.height}>
        {slots.get("app")?.({})}
      </box>
    </PluginContextProvider>, screen.renderer)
    await screen.renderOnce()
  }
  function run(id: string) {
    const found = layers.flatMap((layer) => layer().commands ?? []).find((cmd) => cmd.id === `session-sidebar.sessions.${id}`)
    if (!found) throw new Error(`Missing command ${id}`)
    void found.run()
  }
  return {
    screen, slots, layers, listeners, requests, navigations, toasts, ctx, editor,
    mount, run, setRoute, setList(value: SessionInfo[]) { list = value },
    enqueue(promise: Promise<{ data: SessionInfo[] }>) { replies.push(promise) },
    emit(name: string, data: unknown = {}) { listeners.get(name)?.forEach((listener) => listener({ data })) },
    get open() { return !editorFocused }, get focused() { return editorFocused },
    dispose() { stops?.(); screen.renderer.destroy() },
  }
}

test("default registers left overlay, footer and palette/slash command without a global open key", async () => {
  const h = await harness()
  try {
    expect(plugin.id).toBe("session-sidebar")
    expect([...h.slots.keys()].sort()).toEqual(["app", "prompt.footer.status"])
    await h.mount()
    expect(h.layers).toHaveLength(1) // palette/slash toggle; overlay controls mount on open
    expect(h.layers.flatMap((layer) => layer().commands ?? []).some((cmd) => cmd.bind === "left")).toBe(false)
    const toggle = h.layers.flatMap((layer) => layer().commands ?? []).find((cmd) => cmd.id === "session-sidebar.sessions.toggle")
    expect(toggle?.palette).toBe(true)
    expect(toggle?.slash).toEqual({ name: "sessions-panel" })
    h.run("toggle")
    expect(h.open).toBe(true)
    expect(h.requests).toEqual([{ limit: 50, parentID: null, project: "project" }])
    await Promise.resolve()
    await h.screen.renderOnce()
    expect(h.screen.captureCharFrame()).toContain("Session active")
    expect(h.screen.captureCharFrame()).toContain("current")
    expect(h.screen.captureCharFrame().split("\n")[0]).toMatch(/^\s{0,2}Sessions/)
  } finally { h.dispose() }
})

test("explicit left open key is active only for an empty session prompt without a panel", async () => {
  const h = await harness({ openKey: "left" })
  try {
    await h.mount()
    const openLayer = h.layers.find((layer) => layer().commands?.some((cmd) => cmd.bind === "left"))!
    expect((openLayer().enabled as () => boolean)()).toBe(true)
    h.editor.plainText = "draft"
    expect((openLayer().enabled as () => boolean)()).toBe(false)
    h.editor.plainText = ""
    h.run("toggle")
    expect((openLayer().enabled as () => boolean)()).toBe(false)
    h.run("toggle")
    h.setRoute({ type: "home" })
    expect((openLayer().enabled as () => boolean)()).toBe(false)
  } finally { h.dispose() }
})

test("search filters titles, excludes subagents, navigates only matching sessions", async () => {
  const h = await harness()
  try {
    h.setList([session("old", 1), session("active", 2), session("old-child", 3, "project", "old")])
    await h.mount()
    h.run("toggle")
    await Promise.resolve()
    await h.screen.mockInput.typeText("OLD")
    await h.screen.renderOnce()
    const frame = h.screen.captureCharFrame()
    expect(frame).toContain("Search: OLD")
    expect(frame).toContain("Session old")
    expect(frame).not.toContain("Session active")
    expect(frame).not.toContain("Session old-child")
    h.run("select")
    expect(h.navigations).toEqual(["old"])
    expect(h.open).toBe(false)
  } finally { h.dispose() }
})

test("no matches makes Enter inert; backspace restores a selectable row", async () => {
  const h = await harness()
  try {
    await h.mount()
    h.run("toggle")
    await Promise.resolve()
    await h.screen.mockInput.typeText("z")
    await h.screen.renderOnce()
    expect(h.screen.captureCharFrame()).toContain("No matches")
    h.run("select")
    expect(h.navigations).toEqual([])
    h.run("backspace")
    await h.screen.renderOnce()
    expect(h.screen.captureCharFrame()).toContain("▸ Session active")
  } finally { h.dispose() }
})

test("status events update running/retrying markers and list events debounce", async () => {
  const h = await harness({ scope: "all", limit: 0.25 })
  try {
    await h.mount()
    h.run("toggle")
    expect(h.requests).toEqual([{ limit: 1, parentID: null }])
    h.emit("session.status", { sessionID: "old", status: { type: "busy" } })
    await h.screen.renderOnce()
    expect(h.screen.captureCharFrame()).toContain("running")
    h.emit("session.status", { sessionID: "old", status: { type: "retry" } })
    await h.screen.renderOnce()
    expect(h.screen.captureCharFrame()).toContain("retrying")
    h.emit("session.renamed")
    h.emit("session.created")
    await new Promise((resolve) => setTimeout(resolve, 130))
    expect(h.requests).toHaveLength(2)
  } finally { h.dispose() }
})

test("disabled plugin registers nothing; home route cannot open session panel", async () => {
  const h = await harness({ enabled: false })
  try { expect(h.slots.size).toBe(0); expect(h.layers).toHaveLength(0) } finally { h.dispose() }
  const home = await harness()
  try {
    home.setRoute({ type: "home" })
    await home.mount()
    home.run("toggle")
    expect(home.open).toBe(false)
    expect(home.requests).toHaveLength(0)
  } finally { home.dispose() }
})

test("unmount unsubscribes listeners and ignores late list results", async () => {
  const h = await harness()
  const pending = deferred<{ data: SessionInfo[] }>()
  h.enqueue(pending.promise)
  try {
    await h.mount()
    h.run("toggle")
    expect(h.listeners.get("session.status")?.size).toBe(1)
    h.dispose()
    pending.resolve({ data: [session("late", 5)] })
    await pending.promise
    await Promise.resolve()
    expect(h.toasts).toEqual([])
  } finally { /* renderer already destroyed */ }
})

test("custom keys, draft override and disabled status apply to V2 layers", async () => {
  const h = await harness({ openKey: "ctrl+g", closeKey: "ctrl+j", requireEmptyPrompt: false, showStatus: false })
  try {
    await h.mount()
    h.run("toggle")
    const open = h.layers.find((layer) => layer().commands?.some((cmd) => cmd.bind === "ctrl+g"))!
    h.editor.plainText = "keep this draft"
    expect((open().enabled as () => boolean)()).toBe(false)
    const close = h.layers.flatMap((layer) => layer().commands ?? []).find((cmd) => cmd.id === "session-sidebar.sessions.close")
    expect(close?.bind).toBe("ctrl+j")
    h.emit("session.status", { sessionID: "old", status: { type: "busy" } })
    await h.screen.renderOnce()
    expect(h.screen.captureCharFrame()).not.toContain("running")
    expect(h.editor.plainText).toBe("keep this draft")
  } finally { h.dispose() }
})

test("late failures and pending debounced refreshes are discarded when panel unmounts", async () => {
  const h = await harness()
  const late = deferred<{ data: SessionInfo[] }>()
  h.enqueue(late.promise)
  await h.mount()
  h.run("toggle")
  expect(h.requests).toHaveLength(1)
  h.emit("session.renamed")
  h.dispose()
  late.resolve({ data: [session("stale", 5)] })
  await late.promise
  await new Promise((resolve) => setTimeout(resolve, 130))
  expect(h.requests).toHaveLength(1)
  expect(h.toasts).toEqual([])
})

test("host-consumed keys and modifier shortcuts never enter the search", async () => {
  const h = await harness()
  try {
    await h.mount()
    h.run("toggle")
    const host = (event: import("@opentui/core").KeyEvent) => {
      if (event.name !== "/") return
      event.preventDefault()
      event.stopPropagation()
    }
    h.screen.renderer.keyInput.prependListener("keypress", host)
    try {
      h.screen.mockInput.pressKey("/")
      h.screen.mockInput.pressKey("x", { ctrl: true })
      h.screen.mockInput.pressKey("x", { meta: true })
      await h.screen.renderOnce()
      expect(h.screen.captureCharFrame()).toContain("Search: type to filter")
      await h.screen.mockInput.typeText("old")
      await h.screen.renderOnce()
      expect(h.screen.captureCharFrame()).toContain("Search: old")
    } finally { h.screen.renderer.keyInput.off("keypress", host) }
  } finally { h.dispose() }
})

test("refresh reconciles selection against filtered results and no matches cannot navigate", async () => {
  const h = await harness()
  try {
    await h.mount()
    h.run("toggle")
    await h.screen.mockInput.typeText("old")
    h.setList([session("new", 3), session("active", 2)])
    h.emit("session.renamed")
    await new Promise((resolve) => setTimeout(resolve, 130))
    await h.screen.renderOnce()
    expect(h.screen.captureCharFrame()).toContain("No matches")
    h.run("next")
    h.run("select")
    expect(h.navigations).toEqual([])
    h.setList([session("old-new", 4), session("active", 2)])
    h.emit("session.renamed")
    await new Promise((resolve) => setTimeout(resolve, 130))
    await h.screen.renderOnce()
    expect(h.screen.captureCharFrame()).toContain("▸ Session old-new")
  } finally { h.dispose() }
})

test("narrow left overlay keeps close control and selected session visible", async () => {
  for (const width of [12, 20]) {
    const h = await harness({}, { width, height: 10 })
    try {
      await h.mount()
      h.run("toggle")
      await h.screen.renderOnce()
      const frame = h.screen.captureCharFrame().split("\n")
      expect(frame[0]).toContain("×")
      expect(frame[0]!.indexOf("×")).toBeLessThan(width)
      expect(frame.join("\n")).toContain("Current")
      expect(frame.join("\n")).toContain(width === 12 ? "Sess" : "Session act")
    } finally { h.dispose() }
  }
})
