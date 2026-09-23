/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { createSignal } from "solid-js"
import plugin from "../tui/sessions"

type Layer = {
  enabled?: () => boolean
  bindings?: Array<{ key: string; cmd: string }>
  commands?: Array<{ name: string; run: () => void }>
}

function session(id: string, updated: number) {
  return { id, title: `Session ${id}`, time: { updated } }
}

type ListResponse = { data?: ReturnType<typeof session>[]; error?: unknown }

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => { resolve = done })
  return { promise, resolve }
}

async function harness(size = { width: 80, height: 24 }, options?: { scope?: "project" | "all"; limit?: number }, client?: TuiPluginApi["client"]) {
  const setup = await createTestRenderer({ ...size, useThread: false })
  const layers: Layer[] = []
  const slots: Record<string, () => unknown> = {}
  const listeners = new Map<string, Set<() => void>>()
  const navigations: string[] = []
  const statuses = new Map<string, string>()
  const toasts: string[] = []
  const replies: Array<Promise<ListResponse>> = []
  const calls: Array<{ endpoint: "project" | "global"; query: { directory?: string; roots: boolean; limit: number; scope?: "project" } }> = []
  let list = [session("old", 1), session("active", 2)]
  let route = "active"
  const [routeName, setRouteName] = createSignal("session")
  let disposed: (() => void) | undefined
  let requests = 0
  let cachedCurrent: ReturnType<typeof session> | undefined
  const dialog = { open: false }
  const editor = { plainText: "", focused: true, blur() { this.focused = false }, focus() { this.focused = true } }
  const api = {
    renderer: setup.renderer,
    theme: { current: { backgroundPanel: "#111111", backgroundElement: "#333333", border: "#aaaaaa", accent: "#00aaff", text: "#ffffff", textMuted: "#888888", success: "#00ff00" } },
    route: {
      get current() { return { name: routeName(), params: { sessionID: route } } },
      navigate(_name: string, params: { sessionID: string }) { route = params.sessionID; navigations.push(route) },
    },
    ui: { dialog, toast: (value: { message: string }) => { toasts.push(value.message) } },
    state: { session: { get: (id: string) => list.find((item) => item.id === id) ?? (cachedCurrent?.id === id ? cachedCurrent : undefined), status: (id: string) => ({ type: statuses.get(id) ?? "idle" }) } },
    client: client ?? {
      session: { list(query: { roots: boolean; limit: number; scope?: "project" }) {
        calls.push({ endpoint: "project", query }); requests++; return replies.shift() ?? Promise.resolve({ data: list })
      } },
      experimental: { session: { list(query: { directory?: string; roots: boolean; limit: number }) {
        calls.push({ endpoint: "global", query }); requests++; return replies.shift() ?? Promise.resolve({ data: list })
      } } },
    },
    keymap: { registerLayer(layer: Layer) { layers.push(layer) } },
    slots: { register(config: { slots: typeof slots }) { Object.assign(slots, config.slots) } },
    event: { on(name: string, callback: () => void) {
      const callbacks = listeners.get(name) ?? new Set()
      callbacks.add(callback)
      listeners.set(name, callbacks)
      return () => callbacks.delete(callback)
    } },
    lifecycle: { onDispose(fn: () => void) { disposed = fn } },
  }
  await plugin.tui(api as unknown as TuiPluginApi, options, {} as never)
  const run = (name: string) => {
    const command = layers.flatMap((layer) => layer.commands ?? []).find((item) => item.name === `session.panel.${name}`)
    if (!command) throw new Error(`Missing command: ${name}`)
    command.run()
  }
  return {
    setup, slots, layers, editor, dialog, statuses, navigations, toasts, calls,
    get requests() { return requests },
    enqueue(reply: Promise<ListResponse>) { replies.push(reply) },
    setList(value: typeof list) { list = value },
    cacheCurrent(value: ReturnType<typeof session>) { cachedCurrent = value },
    setRoute(name: string) { setRouteName(name) },
    emit(name: string) { listeners.get(name)?.forEach((listener) => listener()) },
    listeners(name: string) { return listeners.get(name)?.size ?? 0 },
    run,
    dispose() { disposed?.(); setup.renderer.destroy() },
  }
}

test("button and keyboard toggle a left-side non-modal rail without hijacking prompt editing", async () => {
  const h = await harness()
  try {
    const openLayer = h.layers.find((layer) => layer.bindings?.some((binding) => binding.key === "left"))!
    const navigation = h.layers.find((layer) => layer.bindings?.some((binding) => binding.key === "down"))!
    // Model the host's currentFocusedEditor rather than a dialog: there must
    // be no modal dialog calls or dialog mount for this view.
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    expect(openLayer.enabled?.()).toBe(true)
    h.editor.plainText = "draft"
    expect(openLayer.enabled?.()).toBe(false)
    h.editor.plainText = ""
    h.run("toggle")
    expect(h.editor.focused).toBe(false)
    expect(navigation.enabled?.()).toBe(true)
    await Promise.resolve()
    await render(() => h.slots.app() as never, h.setup.renderer)
    await h.setup.renderOnce()
    const first = h.setup.captureCharFrame().split("\n")[0]
    expect(first.indexOf("Sessions")).toBeLessThan(12)
    expect(h.setup.captureCharFrame()).toContain("current")
    h.run("close")
    expect(h.editor.focused).toBe(true)
    expect(navigation.enabled?.()).toBe(false)
  } finally { h.dispose() }
})

test("closed rail ignores late errors and data, cancels queued refresh, and reopens with a fresh list", async () => {
  const h = await harness()
  try {
    const failing = deferred<ListResponse>()
    h.enqueue(failing.promise)
    h.run("toggle")
    expect(h.requests).toBe(1)
    h.run("close")
    failing.resolve({ error: new Error("late failure") })
    await failing.promise
    await Promise.resolve()
    expect(h.toasts).toEqual([])

    const stale = deferred<ListResponse>()
    h.enqueue(stale.promise)
    h.run("toggle")
    expect(h.requests).toBe(2)
    h.run("close")
    stale.resolve({ data: [session("stale-closed", 3)] })
    await stale.promise
    await Promise.resolve()

    const fresh = deferred<ListResponse>()
    h.enqueue(fresh.promise)
    h.run("toggle")
    expect(h.requests).toBe(3)
    await render(() => h.slots.app() as never, h.setup.renderer)
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).not.toContain("stale-closed")
    fresh.resolve({ data: [session("fresh-reopen", 4)] })
    await fresh.promise
    await Promise.resolve()
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("fresh-reopen")
    expect(h.setup.captureCharFrame()).not.toContain("stale-closed")

    h.emit("session.updated")
    h.run("close")
    await new Promise((resolve) => setTimeout(resolve, 130))
    expect(h.requests).toBe(3)
    expect(h.toasts).toEqual([])
  } finally { h.dispose() }
})

test("clicking the prompt-side button opens and closes the non-modal rail", async () => {
  const h = await harness()
  try {
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    await render(() => (
      <box width={80} height={24}>
        <box position="absolute" left={40} top={2}>{h.slots.home_prompt_right() as never}</box>
        {h.slots.app() as never}
      </box>
    ), h.setup.renderer)
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("[Sessions ▶]")
    await h.setup.mockMouse.click(43, 2)
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame().split("\n")[0]).toContain("Sessions")
    expect(h.editor.focused).toBe(false)
    await h.setup.mockMouse.click(43, 2)
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame().split("\n")[0]).not.toContain("Sessions")
    expect(h.editor.focused).toBe(true)
  } finally { h.dispose() }
})

test("session.status changes the rendered marker from running to retrying and Enter switches the selection", async () => {
  const h = await harness()
  try {
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    h.statuses.set("old", "busy")
    h.run("toggle")
    await Promise.resolve()
    await render(() => h.slots.app() as never, h.setup.renderer)
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("running")
    expect(h.listeners("session.status")).toBe(2)
    h.statuses.set("old", "retry")
    h.emit("session.status")
    await Promise.resolve()
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("retrying")
    expect(h.setup.captureCharFrame()).not.toContain("running ·")
    h.run("next")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("▸ Session old")
    h.run("select")
    expect(h.navigations).toEqual(["old"])
    expect(h.requests).toBe(1)
    h.run("toggle")
    h.emit("session.updated")
    await new Promise((resolve) => setTimeout(resolve, 130))
    expect(h.requests).toBe(3)
  } finally { h.dispose() }
})

test("focusing the prompt closes the rail without stealing focus or its draft", async () => {
  const h = await harness()
  try {
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    const navigation = h.layers.find((layer) => layer.bindings?.some((binding) => binding.key === "down"))!
    h.editor.plainText = "draft in progress"
    h.run("toggle")
    await render(() => h.slots.app() as never, h.setup.renderer)
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("Sessions")
    h.editor.focus()
    h.setup.renderer.emit("focused_editor", h.editor, null)
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).not.toContain("Sessions")
    expect(navigation.enabled?.()).toBe(false)
    expect(h.editor.focused).toBe(true)
    expect(h.editor.plainText).toBe("draft in progress")
  } finally { h.dispose() }
})

test("rail paints above the home prompt layer but below the dialog layer", async () => {
  for (const layer of [1000, 3000]) {
    const h = await harness()
    try {
      h.run("toggle")
      await Promise.resolve()
      await render(() => (
        <box width={80} height={24}>
          <box position="absolute" left={0} top={0} width={36} height={2} zIndex={layer} backgroundColor="#444444">
            <text>{layer === 1000 ? "HOME PROMPT" : "DIALOG"}</text>
          </box>
          {h.slots.app() as never}
        </box>
      ), h.setup.renderer)
      await h.setup.renderOnce()
      const first = h.setup.captureCharFrame().split("\n")[0]
      if (layer === 1000) {
        expect(first).toContain("Sessions")
        expect(first).not.toContain("HOME PROMPT")
      } else {
        expect(first).toContain("DIALOG")
        expect(first).not.toContain("Sessions")
      }
    } finally { h.dispose() }
  }
})

test("narrow 12x10 and 20x10 viewports keep the close control visible without wrapping rows", async () => {
  for (const width of [12, 20]) {
    const h = await harness({ width, height: 10 })
    try {
      Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
      h.run("toggle")
      await Promise.resolve()
      await render(() => h.slots.app() as never, h.setup.renderer)
      await h.setup.renderOnce()
      const screen = h.setup.captureCharFrame().split("\n")
      expect(screen[0]).toContain("×")
      expect(screen[0].indexOf("×")).toBeLessThan(width)
      expect(screen[0]).toContain(width === 12 ? " S " : "Sessions")
      expect(screen.join("\n")).toContain("Current")
      expect(screen.join("\n")).toContain(width === 12 ? "Sess" : "Session act")
      await h.setup.mockInput.typeText("active")
      await h.setup.renderOnce()
      const filtered = h.setup.captureCharFrame().split("\n")
      expect(filtered[0]).toContain("×")
      expect(filtered.join("\n")).toContain(width === 12 ? "Sess" : "Session act")
      h.run("close")
      expect(h.editor.focused).toBe(true)
    } finally { h.dispose() }
  }
})

test("typing filters fetched titles case-insensitively, retains grouping/status, and arrows navigate only matches", async () => {
  const h = await harness()
  try {
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    h.setList([
      { ...session("old", 1), title: "ALPHA old" },
      { ...session("active", 2), title: "Other active" },
      { ...session("new", 3), title: "Alpha NEW" },
    ])
    h.statuses.set("old", "busy")
    h.run("toggle")
    await Promise.resolve()
    await render(() => h.slots.app() as never, h.setup.renderer)
    h.setup.mockInput.typeText("aLpHa")
    await h.setup.renderOnce()
    const frame = h.setup.captureCharFrame()
    expect(frame).toContain("Search: aLpHa")
    expect(frame).toContain("ALPHA old")
    expect(frame).not.toContain("Other active")
    expect(frame).toContain("Running")
    expect(frame).toContain("running")
    expect(h.editor.plainText).toBe("")
    h.statuses.set("old", "retry")
    h.emit("session.status")
    await Promise.resolve()
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("retrying")
    expect(frame).toContain("▸ ALPHA old")
    h.run("previous")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("▸ Alpha NEW")
    h.run("next")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("▸ ALPHA old")
    h.run("next")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("▸ Alpha NEW")
    h.run("select")
    expect(h.navigations).toEqual(["new"])
  } finally { h.dispose() }
})

test("no matches disables Enter, editing and clearing reset selection, and a new opening resets the query", async () => {
  const h = await harness()
  try {
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    h.run("toggle")
    await Promise.resolve()
    await render(() => h.slots.app() as never, h.setup.renderer)
    await h.setup.mockInput.typeText("z")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("No matches")
    h.run("select")
    h.run("next")
    expect(h.navigations).toEqual([])
    h.run("backspace")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("▸ Session active")
    await h.setup.mockInput.typeText("old")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("▸ Session old")
    h.run("clear")
    await h.setup.mockInput.typeText("session old")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("Search: session old")
    expect(h.setup.captureCharFrame()).not.toContain("Session active")
    h.run("clear")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("Search: type to filter")
    expect(h.setup.captureCharFrame()).toContain("▸ Session old")
    h.run("close")
    h.run("toggle")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("Search: type to filter")
    expect(h.setup.captureCharFrame()).toContain("▸ Session active")
  } finally { h.dispose() }
})

test("search ignores modifiers, dialogs, prompt focus, and closed rail; refresh reconciles against filtered fetched list", async () => {
  const h = await harness()
  try {
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    const navigation = h.layers.find((layer) => layer.bindings?.some((binding) => binding.key === "down"))!
    expect(navigation.bindings?.map((binding) => binding.key)).toContain("backspace")
    expect(navigation.bindings?.map((binding) => binding.key)).toContain("ctrl+u")
    h.run("toggle")
    await Promise.resolve()
    await render(() => h.slots.app() as never, h.setup.renderer)
    h.setup.mockInput.pressKey("x", { ctrl: true })
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("Search: type to filter")
    h.setup.mockInput.pressKey("x", { meta: true })
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("Search: type to filter")
    h.dialog.open = true
    h.setup.mockInput.pressKey("x")
    expect(navigation.enabled?.()).toBe(false)
    h.dialog.open = false
    await h.setup.mockInput.typeText("old")
    h.setList([session("new", 3), session("active", 2)])
    h.emit("session.updated")
    await new Promise((resolve) => setTimeout(resolve, 130))
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("No matches")
    expect(h.setup.captureCharFrame()).not.toContain("Session old")
    h.run("select")
    expect(h.navigations).toEqual([])
    h.setList([session("old-new", 4), session("active", 2)])
    h.emit("session.updated")
    await new Promise((resolve) => setTimeout(resolve, 130))
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("▸ Session old-new")
    h.editor.focus()
    h.setup.renderer.emit("focused_editor", h.editor, null)
    h.setup.mockInput.pressKey("x")
    expect(h.editor.plainText).toBe("")
    h.run("toggle")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("Search: type to filter")
  } finally { h.dispose() }
})

test("cached current outside fetched roots cannot appear in search or be selected", async () => {
  const h = await harness()
  try {
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    h.cacheCurrent(session("active", 2))
    h.setList([session("old", 1)])
    h.run("toggle")
    await Promise.resolve()
    await render(() => h.slots.app() as never, h.setup.renderer)
    await h.setup.mockInput.typeText("active")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("No matches")
    expect(h.setup.captureCharFrame()).not.toContain("Session active")
    h.run("select")
    expect(h.navigations).toEqual([])
  } finally { h.dispose() }
})

test("project uses scoped list; all uses global session endpoint with roots and limit", async () => {
  for (const scope of ["project", "all"] as const) {
    const h = await harness(undefined, { scope, limit: 7 })
    try {
      h.setList([session("other-project", 3), session("active", 2)])
      h.run("toggle")
      await Promise.resolve()
      await render(() => h.slots.app() as never, h.setup.renderer)
      await h.setup.renderOnce()
      expect(h.calls).toEqual([scope === "all"
        ? { endpoint: "global", query: { directory: "", roots: true, limit: 7 } }
        : { endpoint: "project", query: { roots: true, limit: 7, scope: "project" } }])
      expect(h.setup.captureCharFrame()).toContain("Session other-project")
    } finally { h.dispose() }
  }
})

test("positive fractional limit clamps to one on both listing endpoints", async () => {
  for (const scope of ["project", "all"] as const) {
    const h = await harness(undefined, { scope, limit: 0.25 })
    try {
      h.run("toggle")
      expect(h.calls).toEqual([scope === "all"
        ? { endpoint: "global", query: { directory: "", roots: true, limit: 1 } }
        : { endpoint: "project", query: { roots: true, limit: 1, scope: "project" } }])
    } finally { h.dispose() }
  }
})

test("real SDK with a default directory sends global list without directory filter and keeps project scope", async () => {
  for (const scope of ["project", "all"] as const) {
    const requests: Request[] = []
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      directory: "/another/project",
      fetch: Object.assign(async (request: RequestInfo | URL) => {
        requests.push(request as Request)
        return new Response("[]", { headers: { "content-type": "application/json" } })
      }, { preconnect: globalThis.fetch.preconnect }),
    })
    const h = await harness(undefined, { scope, limit: 9 }, client)
    try {
      h.run("toggle")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(requests).toHaveLength(1)
      const url = new URL(requests[0]!.url)
      expect(url.pathname).toBe(scope === "all" ? "/experimental/session" : "/session")
      expect(url.searchParams.get("roots")).toBe("true")
      expect(url.searchParams.get("limit")).toBe("9")
      expect(url.searchParams.get("directory")).toBe(scope === "all" ? "" : "/another/project")
      expect(url.searchParams.get("scope")).toBe(scope === "project" ? "project" : null)
      expect(requests[0]!.headers.has("x-opencode-directory")).toBe(false)
    } finally { h.dispose() }
  }
})

test("leaving home/session closes hidden rail, cancels pending response and resets search on return", async () => {
  const h = await harness()
  try {
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    const navigation = h.layers.find((layer) => layer.bindings?.some((binding) => binding.key === "down"))!
    const pending = deferred<ListResponse>()
    h.enqueue(pending.promise)
    h.run("toggle")
    await render(() => h.slots.app() as never, h.setup.renderer)
    await h.setup.mockInput.typeText("old")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("Search: old")
    h.setRoute("settings")
    await h.setup.renderOnce()
    expect(navigation.enabled?.()).toBe(false)
    expect(h.editor.focused).toBe(false) // do not focus an editor in the other route
    pending.resolve({ data: [session("stale", 5)] })
    await pending.promise
    await Promise.resolve()
    h.setRoute("session")
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).not.toContain("Sessions")
    h.run("toggle")
    await Promise.resolve()
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("Search: type to filter")
    expect(h.setup.captureCharFrame()).not.toContain("Session stale")
  } finally { h.dispose() }
})

test("host keymap-consumed printable shortcuts take precedence over rail text input", async () => {
  const h = await harness()
  try {
    Object.defineProperty(h.setup.renderer, "currentFocusedEditor", { configurable: true, get: () => h.editor.focused ? h.editor : null })
    h.run("toggle")
    await Promise.resolve()
    await render(() => h.slots.app() as never, h.setup.renderer)
    // OpenTUI's keymap host installs its listener with prependListener and
    // prevents default/stops propagation for a matched binding.
    const hostBinding = (key: import("@opentui/core").KeyEvent) => {
      if (key.name !== "/") return
      key.preventDefault()
      key.stopPropagation()
    }
    h.setup.renderer.keyInput.prependListener("keypress", hostBinding)
    try {
      h.setup.mockInput.pressKey("/")
      await h.setup.renderOnce()
      expect(h.setup.captureCharFrame()).toContain("Search: type to filter")
      await h.setup.mockInput.typeText("old")
      await h.setup.renderOnce()
      expect(h.setup.captureCharFrame()).toContain("Search: old")
      h.setup.mockInput.pressKey("u", { ctrl: true })
      await h.setup.renderOnce()
      expect(h.setup.captureCharFrame()).toContain("Search: old")
      expect(h.editor.plainText).toBe("")
    } finally { h.setup.renderer.keyInput.off("keypress", hostBinding) }
  } finally { h.dispose() }
})
