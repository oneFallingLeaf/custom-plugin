/** @jsxImportSource @opentui/solid */
/**
 * A collapsible, non-modal sessions rail on the left of the TUI. The host's
 * `app` slot is an overlay, not a layout wrapper: it cannot reserve width in
 * the home/session routes. The rail therefore covers the left edge while open.
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"

type Options = {
  enabled?: boolean
  openKey?: string
  closeKey?: string
  requireEmptyPrompt?: boolean
  scope?: "project" | "all"
  limit?: number
  showStatus?: boolean
}

type Resolved = {
  openKey: string
  closeKey: string
  requireEmptyPrompt: boolean
  scope: "project" | "all"
  limit: number
  showStatus: boolean
}

type Editor = { plainText?: string; blur: () => void; focus: () => void; isDestroyed?: boolean }
type Item = { session: Session; category: string; status?: "running" | "retrying" }

const command = {
  toggle: "session.panel.toggle",
  close: "session.panel.close",
  next: "session.panel.next",
  previous: "session.panel.previous",
  select: "session.panel.select",
  backspace: "session.panel.backspace",
  clear: "session.panel.clear",
}

function pick(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback
}

function resolve(input: Options | undefined): Resolved {
  return {
    openKey: pick(input?.openKey, "left"),
    closeKey: pick(input?.closeKey, "right"),
    requireEmptyPrompt: input?.requireEmptyPrompt !== false,
    scope: input?.scope === "all" ? "all" : "project",
    limit: typeof input?.limit === "number" && Number.isFinite(input.limit) && input.limit > 0 ? Math.max(1, Math.floor(input.limit)) : 50,
    showStatus: input?.showStatus !== false,
  }
}

function currentID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return
  const params = route.params as { sessionID?: unknown } | undefined
  return typeof params?.sessionID === "string" ? params.sessionID : undefined
}

function dayLabel(updated: number): string {
  const date = new Date(updated)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toDateString()
}

function relativeTime(updated: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - updated) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function Rail(props: {
  api: TuiPluginApi
  items: () => Item[]
  query: () => string
  hasSessions: () => boolean
  selected: () => string | undefined
  select: (id: string) => void
  switchTo: (id: string) => void
  close: () => void
}) {
  const dimensions = useTerminalDimensions()
  const theme = () => props.api.theme.current
  const [statusVersion, setStatusVersion] = createSignal(0)
  const unsubscribe = props.api.event.on("session.status", () => setStatusVersion((value) => value + 1))
  onCleanup(unsubscribe)
  const items = () => {
    statusVersion()
    return props.items()
  }
  const width = () => Math.min(36, Math.max(4, dimensions().width - 2))
  const compact = () => width() < 12
  // Each entry uses three terminal lines (category, title, status).
  const rows = () => Math.max(1, Math.floor((dimensions().height - 7) / 3))
  const window = () => {
    const list = items()
    const index = Math.max(0, list.findIndex((item) => item.session.id === props.selected()))
    const start = Math.min(Math.max(0, index - Math.floor(rows() / 2)), Math.max(0, list.length - rows()))
    return { items: list.slice(start, start + rows()), start, more: list.length - start - rows() }
  }

  return (
    <box
      position="absolute"
      top={0}
      bottom={0}
      left={0}
      width={width()}
      zIndex={1500}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme().backgroundPanel}
      border={["right"]}
      borderColor={theme().border}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme().text} wrapMode="none">{compact() ? "S" : "Sessions"}</text>
        <text fg={theme().textMuted} onMouseUp={props.close}>×</text>
      </box>
      <Show when={width() >= 20} fallback={null}>
        <text fg={theme().textMuted} flexShrink={0} wrapMode="none">↑↓ · Enter · Esc</text>
      </Show>
      <text fg={theme().accent} flexShrink={0} wrapMode="none">{compact() ? "/" : "Search: "}{props.query() || (compact() ? "" : "type to filter")}</text>
      <text fg={theme().textMuted} flexShrink={0}>{window().start > 0 ? `↑ ${window().start} more` : " "}</text>
      <For each={window().items}>
        {(item) => {
          const active = () => item.session.id === props.selected()
          const current = () => item.session.id === currentID(props.api)
          return (
            <box
              flexDirection="column"
              flexShrink={0}
              backgroundColor={active() ? theme().backgroundElement : theme().backgroundPanel}
              onMouseDown={() => props.select(item.session.id)}
              onMouseUp={() => props.switchTo(item.session.id)}
            >
              <text fg={theme().textMuted} wrapMode="none">{item.category}</text>
              <text fg={active() ? theme().accent : theme().text} wrapMode="none">
                {active() ? "▸ " : "  "}{item.session.title}
              </text>
              <text fg={item.status ? theme().success : theme().textMuted} wrapMode="none">
                {current() ? "current · " : ""}{item.status ?? ""}{item.status ? " · " : ""}{relativeTime(item.session.time.updated)}
              </text>
            </box>
          )
        }}
      </For>
      <text fg={theme().textMuted} flexShrink={0}>{window().more > 0 ? `↓ ${window().more} more` : " "}</text>
      <text fg={theme().textMuted} wrapMode="none">{items().length === 0 ? props.query() && props.hasSessions() ? "No matches" : "No sessions" : " "}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const input = resolve(options as Options | undefined)
  if ((options as Options | undefined)?.enabled === false) return

  const [open, setOpen] = createSignal(false)
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [selected, setSelected] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [revision, setRevision] = createSignal(0)
  let editor: Editor | undefined
  let request = 0
  let disposed = false
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  const validRoute = () => api.route.current.name === "home" || api.route.current.name === "session"
  const items = (): Item[] => {
    revision() // Session statuses and route state change independently of the list response.
    const id = currentID(api)
    const list = [...sessions()].sort((a, b) => b.time.updated - a.time.updated)
    const seen = new Set<string>()
    const result: Item[] = []
    const status = (session: Session): Item["status"] => {
      if (!input.showStatus) return
      const value = api.state.session.status(session.id)?.type
      return value === "retry" ? "retrying" : value === "busy" ? "running" : undefined
    }
    const add = (session: Session, category: string) => {
      if (session.parentID || seen.has(session.id)) return
      seen.add(session.id)
      result.push({ session, category, status: status(session) })
    }
    if (id) {
      const current = list.find((session) => session.id === id)
      if (current) add(current, "Current")
    }
    for (const session of list) if (status(session)) add(session, "Running")
    for (const session of list) add(session, dayLabel(session.time.updated))
    const needle = query().toLocaleLowerCase()
    return needle ? result.filter((item) => item.session.title.toLocaleLowerCase().includes(needle)) : result
  }

  const reconcileSelection = () => {
    const list = items()
    if (!list.some((item) => item.session.id === selected())) setSelected(list[0]?.session.id)
  }
  const editQuery = (value: string) => {
    setQuery(value)
    reconcileSelection()
  }

  const refresh = async () => {
    const generation = ++request
    try {
      // The SDK rewrites its configured directory header into GET queries.
      // An explicit empty directory prevents that injection; the global
      // handler treats an empty directory as no directory filter.
      const response = await (input.scope === "all"
        ? api.client.experimental.session.list({ directory: "", roots: true, limit: input.limit })
        : api.client.session.list({ roots: true, limit: input.limit, scope: "project" }))
      if (disposed || !open() || generation !== request) return
      if (response.error) throw response.error
      setSessions(response.data ?? [])
      setRevision((value) => value + 1)
      reconcileSelection()
    } catch {
      if (!disposed && open() && generation === request) api.ui.toast({ variant: "error", message: "Unable to load sessions" })
    }
  }

  const scheduleRefresh = () => {
    if (!open() || disposed) return
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, 100)
  }

  const restore = () => {
    const value = editor
    editor = undefined
    if (value && !value.isDestroyed && !api.renderer.isDestroyed && !api.ui.dialog.open) value.focus()
  }

  const close = (refocus = true) => {
    // A response started by this opening must not update a later opening (or
    // surface an error after the rail is gone). A pending debounce is likewise
    // owned by this opening, not by the plugin's lifetime.
    request++
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = undefined
    setOpen(false)
    if (refocus) restore()
    else editor = undefined
  }

  const toggle = () => {
    if (open()) return close()
    if (!validRoute() || api.ui.dialog.open) return
    editor = api.renderer.currentFocusedEditor as Editor | null ?? undefined
    editor?.blur()
    setQuery("")
    setSelected(currentID(api) ?? items()[0]?.session.id)
    setOpen(true)
    void refresh()
  }

  const switchTo = (id: string) => {
    if (!items().some((item) => item.session.id === id)) return
    const same = id === currentID(api)
    if (!same) api.route.navigate("session", { sessionID: id })
    close(same)
  }

  const step = (direction: number) => {
    const list = items()
    if (!list.length) return
    const index = list.findIndex((item) => item.session.id === selected())
    setSelected(list[index < 0 ? 0 : (index + direction + list.length) % list.length].session.id)
  }

  // The rail is not an editor: only take plain printable characters while it
  // owns keyboard focus. Leave modifier shortcuts, dialogs and prompt input to
  // the host. Named/navigation keys continue through the guarded keymap layer.
  const onKey = (key: import("@opentui/core").KeyEvent) => {
    if (!open() || !validRoute() || api.ui.dialog.open || api.renderer.currentFocusedEditor ||
      key.eventType === "release" || key.ctrl || key.meta || key.option || key.super || key.hyper ||
      key.defaultPrevented || key.propagationStopped) return
    if ((key.name !== "space" && [...key.name].length !== 1) || [...key.sequence].length !== 1 || /\p{C}/u.test(key.sequence)) return
    key.preventDefault()
    editQuery(query() + key.sequence)
  }
  api.renderer.keyInput.on("keypress", onKey)

  // The app slot cannot change the host's flex layout. It can, however, mount
  // a left-aligned, non-modal overlay that leaves the prompt and dialogs intact.
  api.slots.register({
    slots: {
      app() {
        // The app slot remains mounted across host routes. Observe the host's
        // reactive route here, not only in Show, so a hidden rail is closed.
        createEffect(() => {
          if (open() && !validRoute()) close(false)
        })
        return (
          <Show when={open() && validRoute()} fallback={null}>
            <Rail api={api} items={items} query={query} hasSessions={() => sessions().length > 0} selected={selected} select={setSelected} switchTo={switchTo} close={() => close()} />
          </Show>
        )
      },
      home_prompt_right() {
        return <text fg={api.theme.current.accent} onMouseUp={toggle}>{open() ? "[Sessions ◀]" : "[Sessions ▶]"}</text>
      },
      session_prompt_right() {
        return <text fg={api.theme.current.accent} onMouseUp={toggle}>{open() ? "[Sessions ◀]" : "[Sessions ▶]"}</text>
      },
    },
  })

  api.keymap.registerLayer({
    commands: [{ name: command.toggle, title: "Toggle sessions panel", category: "Session", namespace: "palette", slashName: "sessions-panel", run: toggle }],
  })
  api.keymap.registerLayer({
    mode: "base",
    priority: 10,
    enabled: () => validRoute() && !open() && !api.ui.dialog.open &&
      (!input.requireEmptyPrompt || api.renderer.currentFocusedEditor?.plainText === ""),
    bindings: [{ key: input.openKey, cmd: command.toggle, desc: "Open sessions panel" }],
  })
  api.keymap.registerLayer({
    mode: "base",
    priority: 30,
    enabled: () => open() && validRoute() && !api.ui.dialog.open && !api.renderer.currentFocusedEditor,
    commands: [
      { name: command.close, title: "Close sessions panel", run: () => close() },
      { name: command.next, title: "Next session", run: () => step(1) },
      { name: command.previous, title: "Previous session", run: () => step(-1) },
      { name: command.select, title: "Switch session", run: () => { const id = selected(); if (id) switchTo(id) } },
      { name: command.backspace, title: "Erase search character", run: () => editQuery([...query()].slice(0, -1).join("")) },
      { name: command.clear, title: "Clear session search", run: () => editQuery("") },
    ],
    bindings: [
      { key: input.closeKey, cmd: command.close },
      { key: "escape", cmd: command.close },
      { key: "up", cmd: command.previous },
      { key: "down", cmd: command.next },
      { key: "enter", cmd: command.select },
      { key: "backspace", cmd: command.backspace },
      { key: "ctrl+u", cmd: command.clear },
    ],
  })

  const off = [
    api.event.on("session.created", scheduleRefresh),
    api.event.on("session.updated", scheduleRefresh),
    api.event.on("session.deleted", scheduleRefresh),
    api.event.on("session.status", () => queueMicrotask(() => { if (!disposed) setRevision((value) => value + 1) })),
  ]
  // A click on the uncovered prompt gives its editor focus. Close the rail
  // without refocusing the previously captured editor or stealing that click.
  const onEditorFocus = (current: unknown) => {
    if (current && open()) close(false)
  }
  api.renderer.on("focused_editor", onEditorFocus)
  api.lifecycle.onDispose(() => {
    disposed = true
    off.forEach((unsubscribe) => unsubscribe())
    api.renderer.off("focused_editor", onEditorFocus)
    api.renderer.keyInput.off("keypress", onKey)
    close(!api.renderer.isDestroyed)
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "copilot-sessions", tui }
export default plugin
