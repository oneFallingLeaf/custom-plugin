/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

type Options = {
  enabled?: boolean
  openKey?: string
  closeKey?: string
  requireEmptyPrompt?: boolean
  scope?: "project" | "all"
  limit?: number
  showStatus?: boolean
}
type Settings = Required<Omit<Options, "openKey">> & { openKey?: string }
type Item = { session: SessionInfo; category: string; status?: "running" | "retrying" }
const name = "session-sidebar.sessions"
const commands = {
  toggle: `${name}.toggle`, close: `${name}.close`, next: `${name}.next`,
  previous: `${name}.previous`, select: `${name}.select`, backspace: `${name}.backspace`, clear: `${name}.clear`,
}

function key(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback
}
function options(value: Options): Settings {
  return {
    enabled: value.enabled !== false,
    openKey: typeof value.openKey === "string" && value.openKey.trim() ? value.openKey : undefined,
    closeKey: key(value.closeKey, "right"),
    requireEmptyPrompt: value.requireEmptyPrompt !== false,
    scope: value.scope === "all" ? "all" : "project",
    limit: typeof value.limit === "number" && Number.isFinite(value.limit) && value.limit > 0 ? Math.max(1, Math.floor(value.limit)) : 50,
    showStatus: value.showStatus !== false,
  }
}
function dayLabel(updated: number) {
  const date = new Date(updated)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toDateString()
}
function relativeTime(updated: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - updated) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function Sessions(props: { panel: PanelInput; settings: Settings }) {
  const ctx = usePlugin()
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])
  const [selected, setSelected] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [statuses, setStatuses] = createSignal<Record<string, "running" | "retrying" | undefined>>({})
  let request = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const items = createMemo(() => {
    const list = [...sessions()].sort((a, b) => b.time.updated - a.time.updated)
    const seen = new Set<string>()
    const result: Item[] = []
    const status = (session: SessionInfo): Item["status"] => {
      if (!props.settings.showStatus) return
      return statuses()[session.id] ?? (ctx.data.session.status(session.id) === "running" ? "running" : undefined)
    }
    const add = (session: SessionInfo, category: string) => {
      if (session.parentID || seen.has(session.id)) return
      seen.add(session.id)
      result.push({ session, category, status: status(session) })
    }
    const current = list.find((session) => session.id === props.panel.sessionID)
    if (current) add(current, "Current")
    for (const session of list) if (status(session)) add(session, "Running")
    for (const session of list) add(session, dayLabel(session.time.updated))
    const needle = query().toLocaleLowerCase()
    return needle ? result.filter((item) => item.session.title?.toLocaleLowerCase().includes(needle)) : result
  })
  const reconcile = () => {
    if (!items().some((item) => item.session.id === selected())) setSelected(items()[0]?.session.id)
  }
  const edit = (text: string) => { setQuery(text); reconcile() }
  const refresh = async () => {
    const generation = ++request
    try {
      const project = ctx.data.session.get(props.panel.sessionID)?.projectID
      const response = await ctx.client.session.list({
        limit: props.settings.limit, parentID: null,
        ...(props.settings.scope === "project" && project ? { project } : {}),
      })
      if (disposed || generation !== request) return
      // Do not show another project's sessions if the current session has not yet synced.
      setSessions(props.settings.scope === "project" && !project ? response.data.filter((item) => item.projectID === ctx.data.session.get(props.panel.sessionID)?.projectID) : response.data)
      reconcile()
    } catch {
      if (!disposed && generation === request) ctx.ui.toast.show({ variant: "error", message: "Unable to load sessions" })
    }
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void refresh() }, 100)
  }
  const close = () => props.panel.close()
  const switchTo = (id: string) => {
    if (!items().some((item) => item.session.id === id)) return
    if (id !== props.panel.sessionID) ctx.ui.router.navigate({ type: "session", sessionID: id })
    close()
  }
  const step = (direction: number) => {
    const list = items()
    if (!list.length) return
    const index = list.findIndex((item) => item.session.id === selected())
    setSelected(list[index < 0 ? 0 : (index + direction + list.length) % list.length]!.session.id)
  }
  ctx.keymap.layer(() => ({
    enabled: props.panel.focused,
    priority: 30,
    commands: [
      { id: commands.close, bind: props.settings.closeKey, run: close },
      { bind: "escape", run: close },
      { id: commands.next, bind: "down", run: () => step(1) },
      { id: commands.previous, bind: "up", run: () => step(-1) },
      { id: commands.select, bind: "enter", run: () => { const id = selected(); if (id) switchTo(id) } },
      { id: commands.backspace, bind: "backspace", run: () => edit([...query()].slice(0, -1).join("")) },
      { id: commands.clear, bind: "ctrl+u", run: () => edit("") },
    ],
  }))
  const onKey = (event: import("@opentui/core").KeyEvent) => {
    if (!props.panel.focused || event.eventType === "release" || event.ctrl || event.meta || event.option || event.super || event.hyper ||
      event.defaultPrevented || event.propagationStopped ||
      (event.name !== "space" && [...event.name].length !== 1) || [...event.sequence].length !== 1 || /\p{C}/u.test(event.sequence)) return
    event.preventDefault()
    edit(query() + event.sequence)
  }
  onMount(() => {
    setSelected(props.panel.sessionID)
    void refresh()
    ctx.renderer.keyInput.on("keypress", onKey)
  })
  const off = [
    ctx.data.on("session.created", schedule),
    ctx.data.on("session.renamed", schedule),
    ctx.data.on("session.metadata.updated", schedule),
    ctx.data.on("session.deleted", schedule),
    ctx.data.on("session.status", (event) => {
      const value = event.data.status.type
      setStatuses((previous) => ({ ...previous, [event.data.sessionID]: value === "retry" ? "retrying" : value === "busy" ? "running" : undefined }))
    }),
  ]
  onCleanup(() => {
    disposed = true
    request++
    if (timer) clearTimeout(timer)
    off.forEach((stop) => stop())
    ctx.renderer.keyInput.off("keypress", onKey)
  })
  const width = () => props.panel.width
  const compact = () => width() < 12
  const searchBox = () => width() >= 30 && ctx.renderer.height >= 12
  const rows = () => Math.max(1, Math.floor((ctx.renderer.height - 7 - (searchBox() ? 2 : 0)) / 3))
  const window = () => {
    const list = items()
    const index = Math.max(0, list.findIndex((item) => item.session.id === selected()))
    const start = Math.min(Math.max(0, index - Math.floor(rows() / 2)), Math.max(0, list.length - rows()))
    return { items: list.slice(start, start + rows()), start, more: list.length - start - rows() }
  }
  const theme = ctx.theme
  return <box position="absolute" top={0} bottom={0} left={0} width={width()} zIndex={1500}
    flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.base}
    border={["right"]} borderColor={theme.border.base}>
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={theme.text.base} wrapMode="none">{compact() ? "S" : "Sessions"}</text>
      <text fg={theme.text.muted} onMouseUp={close}>×</text>
    </box>
    <Show when={searchBox()} fallback={<text fg={theme.text.action.primary.base} flexShrink={0} wrapMode="none">{compact() ? "/" : "Search: "}{query() || (compact() ? "" : "type to filter")}</text>}>
      <box height={3} flexShrink={0} border borderStyle="heavy" borderColor={theme.border.base} backgroundColor={theme.background.raised.high} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text.base} wrapMode="none"><b>Search: {query() || "type to filter"}</b></text>
      </box>
    </Show>
    <Show when={width() >= 20}><text fg={theme.text.muted} flexShrink={0} wrapMode="none">↑↓ · Enter · Esc</text></Show>
    <text fg={theme.text.muted} flexShrink={0}>{window().start > 0 ? `↑ ${window().start} more` : " "}</text>
    <For each={window().items}>{(item) => <box flexDirection="column" flexShrink={0}
      backgroundColor={item.session.id === selected() ? theme.background.raised.high : theme.background.raised.base}
      onMouseDown={() => setSelected(item.session.id)} onMouseUp={() => switchTo(item.session.id)}>
      <text fg={theme.text.muted} wrapMode="none">{item.category}</text>
      <text fg={item.session.id === selected() ? theme.text.action.primary.base : theme.text.base} wrapMode="none">{item.session.id === selected() ? "▸ " : "  "}{item.session.title ?? "Untitled"}</text>
      <text fg={item.status ? theme.text.feedback.success.base : theme.text.muted} wrapMode="none">{item.session.id === props.panel.sessionID ? "current · " : ""}{item.status ?? ""}{item.status ? " · " : ""}{relativeTime(item.session.time.updated)}</text>
    </box>}</For>
    <text fg={theme.text.muted} flexShrink={0}>{window().more > 0 ? `↓ ${window().more} more` : " "}</text>
    <text fg={theme.text.muted} wrapMode="none">{items().length === 0 ? query() && sessions().length ? "No matches" : "No sessions" : " "}</text>
  </box>
}

export default Plugin.define({
  id: "session-sidebar",
  setup(ctx) {
    const settings = options(ctx.options)
    if (!settings.enabled) return
    const [open, setOpen] = createSignal(false)
    let editor: { plainText?: string; blur(): void; focus(): void; isDestroyed?: boolean } | undefined
    const route = () => ctx.ui.router.current()
    const close = (restore = true) => {
      setOpen(false)
      const previous = editor
      editor = undefined
      if (restore && previous && !previous.isDestroyed && !ctx.renderer.isDestroyed) previous.focus()
    }
    const toggle = () => {
      if (open()) return close()
      if (route().type !== "session") return
      editor = ctx.renderer.currentFocusedEditor as typeof editor
      editor?.blur()
      setOpen(true)
    }
    const stops = [
      ctx.ui.slot({ append: "prompt.footer.status", render: () => <Show when={route().type === "session"}><text fg={ctx.theme.text.action.primary.base} onMouseUp={toggle}>[Sessions]</text></Show> }),
      ctx.ui.slot({ append: "app", render: () => {
        createEffect(() => { if (open() && route().type !== "session") close(false) })
        ctx.keymap.layer(() => ({ mode: "global", commands: [{ id: commands.toggle, title: "Toggle sessions panel", group: "Session", palette: true,
          slash: { name: "sessions-panel" }, run: toggle }] }))
        if (settings.openKey) ctx.keymap.layer(() => ({ mode: "global", priority: 10, enabled: () =>
          route().type === "session" && !open() &&
          (!settings.requireEmptyPrompt || ctx.renderer.currentFocusedEditor?.plainText === ""),
          commands: [{ bind: settings.openKey, run: toggle }],
        }))
        return <Show when={open() && route().type === "session"}>
          {(() => {
            const panel: PanelInput = {
              name,
              get sessionID() { const current = route(); return current.type === "session" ? current.sessionID : "" },
              get width() { return Math.min(36, Math.max(4, ctx.renderer.width - 2)) },
              presentation: "panel",
              get focused() { return open() },
              focus: () => {},
              close: () => close(),
              toggleFullscreen: () => {},
            }
            return <Sessions panel={panel} settings={settings} />
          })()}
        </Show>
      } }),
    ]
    return () => { close(false); stops.forEach((stop) => stop()) }
  },
})
