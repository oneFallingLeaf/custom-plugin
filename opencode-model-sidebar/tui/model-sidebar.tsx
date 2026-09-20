/** @jsxImportSource @opentui/solid */
/**
 * Model sidebar (TUI plugin)
 *
 * Adds a searchable model browser to the session sidebar, below the built-in
 * LSP/todo/files sections. Register it from `~/.config/opencode/tui.json`:
 *
 *   {
 *     "plugin": [
 *       ["./plugins/tui/model-sidebar.tsx", { "keybind": "ctrl+shift+m", "switchMode": "dialog" }]
 *     ]
 *   }
 *
 * Options:
 *   keybind    key that focuses the search box (default "ctrl+shift+m")
 *   order      sidebar slot order; built-ins are 100..500 (default 600)
 *   maxRows    visible list rows (default 12)
 *   switchMode fallback when the host does not expose `api.model`:
 *              "dialog" (default) opens the native model picker on select;
 *              "session" calls session.switchModel, which changes the session's
 *              model but NOT the TUI-local model used by typed prompts.
 *
 * Selecting a model (double-clicking its row) is a true switch on opencode
 * builds that expose the TUI-local model as `api.model` (the `model-api` patch
 * in this repo). Stock opencode 1.18 does not expose it, so the plugin falls
 * back to opening the native picker, the only reliable switch there.
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"

type Options = {
  enabled?: boolean
  order?: number
  keybind?: string
  maxRows?: number
  switchMode?: "session" | "dialog"
}

type Resolved = {
  order: number
  keybind: string
  maxRows: number
  switchMode: "session" | "dialog"
}

type ModelItem = {
  providerID: string
  providerName: string
  id: string
  name: string
  release: string
  free: boolean
}

type ModelRef = { providerID: string; modelID: string }

type Editor = { focus: () => void; blur: () => void; focused: boolean; isDestroyed?: boolean }

type PointerStyle = "default" | "pointer" | "text"

const DEFAULT_KEYBIND = "ctrl+shift+m"
const DEFAULT_ROWS = 12
const DOUBLE_CLICK_MS = 400

function resolveOptions(input: Options | undefined): Resolved {
  return {
    order: typeof input?.order === "number" ? input.order : 600,
    keybind: typeof input?.keybind === "string" && input.keybind ? input.keybind : DEFAULT_KEYBIND,
    maxRows:
      typeof input?.maxRows === "number" && input.maxRows > 0 ? Math.floor(input.maxRows) : DEFAULT_ROWS,
    switchMode: input?.switchMode === "session" ? "session" : "dialog",
  }
}

function collect(api: TuiPluginApi, query: string): ModelItem[] {
  const needle = query.trim().toLowerCase()
  const items: ModelItem[] = []
  for (const provider of api.state.provider) {
    for (const [id, model] of Object.entries(provider.models)) {
      if (model.status === "deprecated") continue
      if (provider.id === "opencode" && id.includes("-nano")) continue
      const name = model.name ?? id
      if (needle) {
        const haystack = `${name} ${provider.name} ${id}`.toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      items.push({
        providerID: provider.id,
        providerName: provider.name,
        id,
        name,
        release: model.release_date ?? "",
        free: (model.cost?.input ?? 0) === 0 && provider.id === "opencode",
      })
    }
  }
  return items.sort((a, b) => {
    if (a.free !== b.free) return a.free ? 1 : -1
    const byRelease = String(b.release).localeCompare(String(a.release))
    if (byRelease !== 0) return byRelease
    return a.name.localeCompare(b.name)
  })
}

function View(props: {
  api: TuiPluginApi
  sessionID: string
  maxRows: number
  switchMode: "session" | "dialog"
  onReady: (focus: () => void) => void
}) {
  const theme = () => props.api.theme.current
  const [open, setOpen] = createSignal(true)
  const [filtering, setFiltering] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [tab, setTab] = createSignal<"favorites" | "all">("favorites")
  const [cursor, setCursor] = createSignal(0)
  const [windowStart, setWindowStart] = createSignal(0)

  let editor: Editor | undefined
  let pointer: PointerStyle | undefined
  let lastClick: { row: number; at: number } | undefined

  // Terminal mouse pointer (OSC 22). Hovering rows shows a hand, the search
  // box an I-beam, and leaving them restores the default arrow.
  function setPointer(style: PointerStyle) {
    if (pointer === style) return
    pointer = style
    const renderer = props.api.renderer as unknown as {
      isDestroyed?: boolean
      setMousePointer?: (style: string) => void
    }
    if (renderer.isDestroyed) return
    renderer.setMousePointer?.(style)
  }

  const modelApi = (
    props.api as unknown as {
      model?: {
        current?: () => ModelRef | undefined
        set?: (model: ModelRef, options?: { recent?: boolean }) => void
        favorite?: () => ReadonlyArray<ModelRef>
      }
    }
  ).model

  const current = createMemo(() => {
    const local = modelApi?.current?.()
    if (local) return { providerID: local.providerID, id: local.modelID }
    return props.api.state.session.get(props.sessionID)?.model
  })
  const all = createMemo(() => collect(props.api, ""))
  const favorites = createMemo(() => {
    return new Set((modelApi?.favorite?.() ?? []).map((item) => `${item.providerID}\u0000${item.modelID}`))
  })
  const filtered = createMemo(() => {
    const items = collect(props.api, query())
    if (tab() === "all") return items
    const selected = favorites()
    return items.filter((item) => selected.has(`${item.providerID}\u0000${item.id}`))
  })

  // Filtering rebuilds every row, so the row the mouse was over is destroyed
  // and never fires `mouseout`. Restore the default pointer whenever the list
  // changes; opentui re-checks hover after the render and replays `mouseover`
  // for whatever now sits under the mouse. Clicking is the only thing that
  // moves the selection: hovering must not re-slice the window (that made the
  // list auto-scroll/"expand"), matching the original implementation.
  createEffect(() => {
    filtered()
    setPointer("default")
    lastClick = undefined
    setWindowStart(0)
  })

  const clamped = createMemo(() => {
    const length = filtered().length
    if (length === 0) return 0
    return Math.min(Math.max(cursor(), 0), length - 1)
  })

  // The visible window is pinned to `windowStart` and does NOT follow the
  // selection. It only moves when the selection would leave the window, or when
  // the user pages. This keeps the list perfectly still when a row is clicked
  // (highlight) instead of re-centring on every cursor change.
  const windowRows = createMemo(() => {
    const items = filtered()
    const rows = props.maxRows
    const maxStart = Math.max(0, items.length - rows)
    const start = Math.min(Math.max(windowStart(), 0), maxStart)
    return { items: items.slice(start, start + rows), offset: start, more: items.length - start - rows }
  })

  function moveCursor(index: number) {
    const rows = props.maxRows
    const total = filtered().length
    const next = total === 0 ? 0 : Math.min(Math.max(index, 0), total - 1)
    const maxStart = Math.max(0, total - rows)
    let start = windowStart()
    if (next < start) start = next
    else if (next >= start + rows) start = next - rows + 1
    setWindowStart(Math.min(Math.max(start, 0), maxStart))
    setCursor(next)
  }

  function page(direction: 1 | -1) {
    const rows = props.maxRows
    const total = filtered().length
    const maxStart = Math.max(0, total - rows)
    const start = Math.min(Math.max(windowStart() + direction * rows, 0), maxStart)
    setWindowStart(start)
    const index = clamped()
    if (index < start) setCursor(start)
    else if (index >= start + rows) setCursor(Math.min(start + rows - 1, Math.max(total - 1, 0)))
  }

  function swallow(evt: { preventDefault: () => void; stopPropagation: () => void }) {
    evt.preventDefault()
    evt.stopPropagation()
  }

  function isCurrent(item: ModelItem) {
    const value = current()
    return value?.providerID === item.providerID && value.id === item.id
  }

  function enterSearch() {
    const focused = props.api.renderer.currentFocusedEditor as Editor | null
    if (focused) {
      editor = focused
      if (focused.focused) focused.blur()
    }
    setFiltering(true)
  }

  function exitSearch(restoreFocus = true) {
    setFiltering(false)
    setPointer("default")
    if (!restoreFocus) return
    const value = editor
    if (value && !value.isDestroyed) value.focus()
  }

  function append(text: string) {
    setQuery((value) => value + text)
    moveCursor(0)
  }

  function step(direction: 1 | -1) {
    const length = filtered().length
    if (length === 0) return
    const next = clamped() + direction
    if (next < 0) moveCursor(length - 1)
    else if (next >= length) moveCursor(0)
    else moveCursor(next)
  }

  // First click highlights the row, a second click on the same row within
  // DOUBLE_CLICK_MS switches to it. opentui's MouseEvent has no click count,
  // so track the previous click ourselves.
  function clickRow(item: ModelItem, row: number) {
    const now = Date.now()
    const double = lastClick !== undefined && lastClick.row === row && now - lastClick.at <= DOUBLE_CLICK_MS
    lastClick = double ? undefined : { row, at: now }
    moveCursor(row)
    if (double) void choose(item)
  }

  async function choose(item: ModelItem | undefined) {
    if (!item) return
    exitSearch()

    // Patched opencode exposes the TUI-local model. This is a true switch:
    // the prompt will use the chosen model on the next message.
    if (modelApi?.set) {
      modelApi.set({ providerID: item.providerID, modelID: item.id }, { recent: true })
      props.api.ui.toast({ variant: "success", message: `Model: ${item.name}`, duration: 2500 })
      return
    }

    const client = props.api.client as unknown as {
      v2?: {
        session?: {
          switchModel?: (input: {
            sessionID: string
            model: { id: string; providerID: string }
          }) => Promise<{ error?: unknown } | undefined>
        }
      }
    }

    if (props.switchMode === "session" && client.v2?.session?.switchModel) {
      try {
        const result = await client.v2.session.switchModel({
          sessionID: props.sessionID,
          model: { id: item.id, providerID: item.providerID },
        })
        if (result?.error) throw result.error
        props.api.ui.toast({ variant: "success", message: `Session model: ${item.name}`, duration: 2500 })
        return
      } catch (error) {
        props.api.ui.toast({
          variant: "error",
          message: `Switch failed: ${(error as Error)?.message ?? String(error)}`,
        })
        return
      }
    }

    // The plugin API cannot set the TUI-local model, so defer to the native
    // picker for a switch that the prompt will actually use.
    props.api.keymap.dispatchCommand("model.list")
  }

  onMount(() => {
    props.onReady(() => {
      if (filtering()) exitSearch()
      else enterSearch()
    })

    // If the user gives focus back to a real editor (for example by clicking
    // the prompt), stop capturing the keyboard so typing goes there again.
    const renderer = props.api.renderer as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void
      off: (event: string, listener: (...args: unknown[]) => void) => void
    }
    const onFocusedEditor = (current: unknown) => {
      if (current && filtering()) exitSearch(false)
    }
    renderer.on("focused_editor", onFocusedEditor)
    onCleanup(() => {
      renderer.off("focused_editor", onFocusedEditor)
      setPointer("default")
    })
  })

  useKeyboard((evt) => {
    if (!filtering()) return
    if (props.api.ui.dialog.open) return

    // Safety net in case the focus event was missed: never keep swallowing
    // keys once another editor owns focus.
    if (props.api.renderer.currentFocusedEditor) {
      exitSearch(false)
      return
    }

    if (editor && !editor.isDestroyed && editor.focused) editor.blur()

    const name = evt.name

    if (evt.ctrl || evt.meta || evt.super) {
      if (name === "u") {
        swallow(evt)
        setQuery("")
        moveCursor(0)
        return
      }
      if (name === "p") {
        swallow(evt)
        step(-1)
        return
      }
      if (name === "n") {
        swallow(evt)
        step(1)
        return
      }
      return
    }

    if (name === "escape") {
      swallow(evt)
      exitSearch()
      return
    }
    if (name === "up") {
      swallow(evt)
      step(-1)
      return
    }
    if (name === "down") {
      swallow(evt)
      step(1)
      return
    }
    if (name === "pageup") {
      swallow(evt)
      page(-1)
      return
    }
    if (name === "pagedown") {
      swallow(evt)
      page(1)
      return
    }
    if (name === "home") {
      swallow(evt)
      moveCursor(0)
      return
    }
    if (name === "end") {
      swallow(evt)
      moveCursor(Math.max(0, filtered().length - 1))
      return
    }
    if (name === "return" || name === "enter") {
      swallow(evt)
      void choose(filtered()[clamped()])
      return
    }
    if (name === "backspace") {
      swallow(evt)
      setQuery((value) => value.slice(0, -1))
      moveCursor(0)
      return
    }
    if (name === "space") {
      swallow(evt)
      append(" ")
      return
    }
    if (name.length === 1) {
      swallow(evt)
      append(name)
      return
    }
    swallow(evt)
  })

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        gap={1}
        onMouseOver={() => setPointer("pointer")}
        onMouseOut={() => setPointer("default")}
        onMouseDown={() => setOpen((value) => !value)}
      >
        <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        <text fg={theme().text}>
          <b>Models</b>
        </text>
        <text fg={theme().textMuted}>{all().length}</text>
        <Show when={filtering()}>
          <text fg={theme().accent}>search</text>
        </Show>
      </box>
      <Show when={open()}>
        <box flexDirection="row" gap={1}>
          <text
            fg={tab() === "favorites" ? theme().accent : theme().textMuted}
            onMouseOver={() => setPointer("pointer")}
            onMouseOut={() => setPointer("default")}
            onMouseUp={() => setTab("favorites")}
          >
            {"Favorites " + favorites().size}
          </text>
          <text fg={theme().textMuted}>|</text>
          <text
            fg={tab() === "all" ? theme().accent : theme().textMuted}
            onMouseOver={() => setPointer("pointer")}
            onMouseOut={() => setPointer("default")}
            onMouseUp={() => setTab("all")}
          >
            {"All " + all().length}
          </text>
        </box>
        <box
          flexDirection="row"
          onMouseOver={() => setPointer("text")}
          onMouseOut={() => setPointer("default")}
          onMouseDown={() => enterSearch()}
        >
          <text fg={theme().textMuted}>{"⌕ "}</text>
          <Show when={filtering() && !query()}>
            <text fg={theme().accent}>█</text>
          </Show>
          <Show when={query()} fallback={<text fg={theme().textMuted}>Search models…</text>}>
            <text fg={theme().text}>{query()}</text>
          </Show>
          <Show when={filtering() && query()}>
            <text fg={theme().accent}>█</text>
          </Show>
        </box>
        <Show when={windowRows().offset > 0}>
          <text
            fg={theme().textMuted}
            onMouseOver={() => setPointer("pointer")}
            onMouseOut={() => setPointer("default")}
            onMouseUp={() => page(-1)}
          >
            {"  ▲ " + windowRows().offset + " more"}
          </text>
        </Show>
        <For each={windowRows().items}>
          {(item, index) => {
            const row = () => windowRows().offset + index()
            const active = () => row() === clamped()
            return (
              <box
                flexDirection="row"
                gap={1}
                onMouseOver={() => setPointer("pointer")}
                onMouseOut={() => setPointer("default")}
                onMouseDown={() => moveCursor(row())}
                onMouseUp={() => clickRow(item, row())}
              >
                <text fg={isCurrent(item) ? theme().success : theme().textMuted}>{isCurrent(item) ? "●" : " "}</text>
                <text fg={active() ? theme().accent : theme().text} wrapMode="none" flexShrink={1}>
                  {item.name}
                </text>
                <text fg={theme().textMuted} wrapMode="none" flexShrink={1}>
                  {item.providerName}
                </text>
                <Show when={item.free}>
                  <text fg={theme().success} wrapMode="none">
                    free
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={windowRows().more > 0}>
          <text
            fg={theme().textMuted}
            onMouseOver={() => setPointer("pointer")}
            onMouseOut={() => setPointer("default")}
            onMouseUp={() => page(1)}
          >
            {"  ▼ " + windowRows().more + " more"}
          </text>
        </Show>
        <Show when={filtered().length === 0}>
          <text fg={theme().textMuted}>No models match</text>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const resolved = resolveOptions(options as Options | undefined)
  if ((options as Options | undefined)?.enabled === false) return

  let focus: (() => void) | undefined
  const unregister = api.command?.register(() => [
    {
      title: "Focus model search",
      value: "model.sidebar.focus",
      category: "Models",
      hidden: false,
      keybind: resolved.keybind,
      onSelect: () => focus?.(),
    },
  ])
  api.lifecycle.onDispose(() => unregister?.())

  api.slots.register({
    order: resolved.order,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <View
            api={api}
            sessionID={props.session_id}
            maxRows={resolved.maxRows}
            switchMode={resolved.switchMode}
            onReady={(value) => {
              focus = value
            }}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "model-sidebar",
  tui,
}

export { collect, resolveOptions }
export type { ModelItem, Options, Resolved }
export default plugin
