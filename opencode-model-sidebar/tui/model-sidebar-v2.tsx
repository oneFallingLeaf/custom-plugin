/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { ModelInfo } from "@opencode/client"
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { useKeyboard } from "@opentui/solid"

type Item = ModelInfo & { providerName: string; free: boolean }
type ModelRef = { providerID: string; modelID: string }
type PatchedContext = Plugin.Context & {
  model?: {
    current(): { providerID: string; modelID: string } | undefined
    set(model: ModelRef, options?: { recent?: boolean }): void
    favorite(): readonly ModelRef[]
  }
}

function View(props: { context: PatchedContext; sessionID: string }) {
  const api = props.context
  const theme = () => api.theme
  const [open, setOpen] = createSignal(true)
  const [searching, setSearching] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [tab, setTab] = createSignal<"favorites" | "all">(api.model?.favorite ? "favorites" : "all")
  const [cursor, setCursor] = createSignal(0)
  const [start, setStart] = createSignal(0)
  const maxRows = typeof api.options.maxRows === "number" && Number.isFinite(api.options.maxRows) && api.options.maxRows > 0
    ? Math.floor(api.options.maxRows) : 12
  const last = { id: "", at: 0 }
  let restore: { focus(): void; isDestroyed?: boolean } | undefined
  let pointer: "default" | "pointer" | "text" | undefined

  function setPointer(style: "default" | "pointer" | "text") {
    if (pointer === style) return
    pointer = style
    if (!api.renderer.isDestroyed) api.renderer.setMousePointer(style)
  }

  const location = () => api.data.session.get(props.sessionID)?.location ?? api.location
  const models = createMemo(() => {
    const providers = new Map((api.data.location.provider.list(location()) ?? []).map((p) => [p.id, p.name]))
    return (api.data.location.model.list(location()) ?? [])
      .filter((m) => m.enabled && m.status !== "deprecated" && !(m.providerID === "opencode" && m.id.includes("-nano")))
      .map((m): Item => ({ ...m, providerName: providers.get(m.providerID) ?? m.providerID,
        free: m.providerID === "opencode" && m.cost[0]?.input === 0 }))
      .sort((a, b) => Number(a.free) - Number(b.free) || b.time.released - a.time.released || a.name.localeCompare(b.name))
  })
  const favorites = createMemo(() => new Set((api.model?.favorite?.() ?? []).map((m) => `${m.providerID}\0${m.modelID}`)))
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()
    return models().filter((m) =>
      (tab() === "all" || favorites().has(`${m.providerID}\0${m.id}`)) &&
      (!needle || `${m.name} ${m.providerName} ${m.id}`.toLowerCase().includes(needle)),
    )
  })
  const selected = createMemo(() => Math.min(cursor(), Math.max(0, filtered().length - 1)))
  const offset = createMemo(() => Math.min(start(), Math.max(0, filtered().length - maxRows)))
  const visible = createMemo(() => filtered().slice(offset(), offset() + maxRows))

  createEffect(() => {
    filtered()
    setPointer("default")
    last.id = ""
    last.at = 0
    setStart(0)
  })
  onCleanup(() => {
    setPointer("default")
    if (searching()) stop()
  })

  function move(index: number) {
    const next = Math.max(0, Math.min(index, filtered().length - 1))
    if (next < start()) setStart(next)
    if (next >= start() + maxRows) setStart(next - maxRows + 1)
    setCursor(next)
  }
  function page(direction: number) {
    const next = Math.max(0, Math.min(start() + direction * maxRows, filtered().length - maxRows))
    setStart(next)
    if (selected() < next) setCursor(next)
    else if (selected() >= next + maxRows) setCursor(Math.min(next + maxRows - 1, filtered().length - 1))
  }
  function stop() {
    setSearching(false)
    setPointer("default")
    if (restore && !restore.isDestroyed) restore.focus()
    restore = undefined
  }
  function focus() {
    if (searching()) return stop()
    if (query()) {
      setQuery("")
      move(0)
    }
    const current = api.renderer.currentFocusedEditor
    if (current) {
      restore = current
      current.blur()
    }
    setSearching(true)
  }
  function clickSearch() {
    if (searching()) {
      if (query()) {
        setQuery("")
        move(0)
      }
    } else focus()
  }
  api.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "model.sidebar.focus",
      title: "Focus model search",
      bind: typeof api.options.keybind === "string" && api.options.keybind ? api.options.keybind : "ctrl+shift+m",
      palette: true,
      run: focus,
    }],
  }))
  async function choose(item: Item | undefined) {
    if (!item) return
    stop()
    if (api.model?.set) {
      api.model.set({ providerID: item.providerID, modelID: item.id }, { recent: true })
      api.ui.toast.show({ variant: "success", message: `Model: ${item.name}`, duration: 2500 })
      return
    }
    if (api.options.switchMode === "session") {
      try {
        await api.client.session.switchModel({ sessionID: props.sessionID, model: { providerID: item.providerID, id: item.id } })
        api.ui.toast.show({ variant: "success", message: `Session model: ${item.name}`, duration: 2500 })
      } catch (error) {
        api.ui.toast.show({ variant: "error", message: `Switch failed: ${String(error)}` })
      }
      return
    }
    // Stock V2 has no public TUI-local model setter. The native picker owns the next typed prompt's model.
    api.keymap.dispatch("model.list")
  }
  const unfocus = (editor: unknown) => {
    if (editor && searching()) {
      setSearching(false)
      restore = undefined
    }
  }
  api.renderer.on("focused_editor", unfocus)
  onCleanup(() => api.renderer.off("focused_editor", unfocus))

  useKeyboard((event) => {
    if (!searching() || event.eventType === "release" || event.defaultPrevented || event.propagationStopped) return
    if (api.renderer.currentFocusedEditor) {
      setSearching(false)
      return
    }
    const key = event.name
    if (key === "escape") stop()
    else if (key === "up" || (event.ctrl && key === "p")) move(selected() - 1)
    else if (key === "down" || (event.ctrl && key === "n")) move(selected() + 1)
    else if (key === "pageup") page(-1)
    else if (key === "pagedown") page(1)
    else if (key === "return" || key === "enter") void choose(filtered()[selected()])
    else if (key === "home") move(0)
    else if (key === "end") move(filtered().length - 1)
    else if (key === "backspace") { setQuery((q) => q.slice(0, -1)); move(0) }
    else if (event.ctrl && key === "u") { setQuery(""); move(0) }
    else if (!event.ctrl && !event.meta && !event.super && (key.length === 1 || key === "space")) {
      setQuery((q) => q + (key === "space" ? " " : key))
      move(0)
    } else return
    event.preventDefault()
    event.stopPropagation()
  })

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseOver={() => setPointer("pointer")} onMouseOut={() => setPointer("default")}
        onMouseDown={() => setOpen((x) => !x)}>
        <text fg={theme().text.base}>{open() ? "▼" : "▶"}</text>
        <text fg={theme().text.base}><b>Models</b></text>
        <text fg={theme().text.muted}>{models().length}</text>
      </box>
      <Show when={open()}>
        <box flexDirection="row" gap={1}>
          <Show when={api.model?.favorite}>
            <text fg={tab() === "favorites" ? theme().text.base : theme().text.muted}
              onMouseOver={() => setPointer("pointer")} onMouseOut={() => setPointer("default")}
              onMouseUp={() => { setTab("favorites"); setCursor(0); setStart(0) }}>Favorites {favorites().size}</text>
            <text fg={theme().text.muted}>|</text>
          </Show>
          <text fg={tab() === "all" ? theme().text.base : theme().text.muted}
            onMouseOver={() => setPointer("pointer")} onMouseOut={() => setPointer("default")}
            onMouseUp={() => { setTab("all"); setCursor(0); setStart(0) }}>All {models().length}</text>
        </box>
        <box width="100%" minWidth={0} paddingLeft={1} backgroundColor={theme().background.raised.high}
           onMouseOver={() => setPointer("text")} onMouseOut={() => setPointer("default")}
           onMouseDown={clickSearch}>
          <text fg={searching() ? theme().text.base : theme().text.muted} wrapMode="none" truncate>
            {`⌕ ${query() || (searching() ? "" : "Search models…")}${searching() ? "█" : ""}`}
          </text>
        </box>
        <Show when={offset() > 0}>
          <text fg={theme().text.muted} onMouseOver={() => setPointer("pointer")} onMouseOut={() => setPointer("default")}
            onMouseUp={() => page(-1)}>▲ {offset()} more</text>
        </Show>
        <For each={visible()}>{(item, index) => {
          const row = () => offset() + index()
          const current = () => {
            const local = api.model?.current?.()
            if (local) return local
            const session = api.data.session.get(props.sessionID)?.model
            return session && { providerID: session.providerID, modelID: session.id }
          }
          return <box flexDirection="row" gap={1} minWidth={0}
            backgroundColor={selected() === row() ? theme().background.raised.high : undefined}
            onMouseOver={() => setPointer("pointer")} onMouseOut={() => setPointer("default")}
            onMouseUp={() => {
              const now = Date.now()
              const id = `${item.providerID}\0${item.id}`
              move(row())
              if (last.id === id && now - last.at <= 400) {
                last.id = ""
                void choose(item)
              } else {
                last.id = id
                last.at = now
              }
            }}>
            <text fg={theme().text.feedback.success.base}>
              {current()?.providerID === item.providerID && current()?.modelID === item.id ? "●" : " "}
            </text>
            <text fg={selected() === row() ? theme().text.base : theme().text.muted}
              wrapMode="none" truncate flexShrink={1}>{item.name}</text>
            <text fg={theme().text.muted} wrapMode="none" truncate flexShrink={1}>{item.providerName}</text>
            <Show when={item.free}><text fg={theme().text.feedback.success.base}>free</text></Show>
          </box>
        }}</For>
        <Show when={filtered().length > offset() + maxRows}>
          <text fg={theme().text.muted} onMouseOver={() => setPointer("pointer")} onMouseOut={() => setPointer("default")}
            onMouseUp={() => page(1)}>
            ▼ {filtered().length - offset() - maxRows} more
          </text>
        </Show>
        <Show when={filtered().length === 0}><text fg={theme().text.muted}>No models match</text></Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "model-sidebar",
  setup(context) {
    if (context.options.enabled === false) return
    return context.ui.slot({ append: "sidebar.content", render: (props) =>
      <View context={context as PatchedContext} sessionID={props.sessionID} /> })
  },
})
