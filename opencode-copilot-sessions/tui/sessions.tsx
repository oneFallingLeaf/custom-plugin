/** @jsxImportSource @opentui/solid */
/**
 * Copilot-style sessions panel (TUI plugin)
 *
 * Mimics GitHub Copilot CLI: pressing the left arrow while the prompt is empty
 * opens a modal sessions picker and moves focus into it. Up/Down move through
 * sessions, Enter switches to the highlighted session and returns focus to the
 * prompt, and the right arrow (or Escape) closes the picker.
 *
 * Register it from `~/.config/opencode/tui.json`:
 *
 *   {
 *     "plugin": [
 *       ["./plugins/tui/sessions.tsx", { "openKey": "left", "closeKey": "right" }]
 *     ]
 *   }
 *
 * Options:
 *   openKey             key that opens the panel (default "left")
 *   closeKey            key that closes the panel (default "right")
 *   requireEmptyPrompt  only open when the prompt input is empty (default true)
 *   scope               "project" (default) or "all"
 *   limit               maximum sessions to list (default 50)
 *   showStatus          show working/retrying markers (default true)
 */
import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { createMemo, createResource, createSignal } from "solid-js"

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

const OPEN_COMMAND = "session.panel.open"
const CLOSE_COMMAND = "session.panel.close"

function pick(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback
  return value
}

function resolve(input: Options | undefined): Resolved {
  return {
    openKey: pick(input?.openKey, "left"),
    closeKey: pick(input?.closeKey, "right"),
    requireEmptyPrompt: input?.requireEmptyPrompt !== false,
    scope: input?.scope === "all" ? "all" : "project",
    limit: typeof input?.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 50,
    showStatus: input?.showStatus !== false,
  }
}

function promptIsEmpty(api: TuiPluginApi): boolean {
  const editor = api.renderer.currentFocusedEditor as { plainText?: unknown } | null | undefined
  if (!editor) return false
  return typeof editor.plainText === "string" && editor.plainText.length === 0
}

function relativeTime(updated: number): string {
  const minutes = Math.floor((Date.now() - updated) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
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

function Picker(props: { api: TuiPluginApi; input: Resolved }) {
  const DialogSelect = props.api.ui.DialogSelect

  const currentID = (): string | undefined => {
    const route = props.api.route.current
    if (route.name !== "session") return undefined
    const params = route.params as { sessionID?: unknown } | undefined
    return typeof params?.sessionID === "string" ? params.sessionID : undefined
  }

  const [sessions] = createResource(
    () => props.input.scope,
    async (scope) => {
      const result = await props.api.client.session.list({
        roots: true,
        limit: props.input.limit,
        ...(scope === "project" ? { scope: "project" as const } : {}),
      })
      return result.data ?? []
    },
  )

  const options = createMemo<TuiDialogSelectOption<string>[]>(() => {
    const id = currentID()
    const seen = new Set<string>()
    const items: TuiDialogSelectOption<string>[] = []

    const statusOf = (session: Session) =>
      props.input.showStatus ? props.api.state.session.status(session.id) : undefined

    const runningLabel = (status: ReturnType<typeof statusOf>) => {
      if (status?.type === "retry") return "retrying"
      if (status?.type === "busy") return "running"
      return undefined
    }

    const option = (session: Session, category: string): TuiDialogSelectOption<string> => {
      const description = [
        session.id === id ? "current" : undefined,
        runningLabel(statusOf(session)),
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ")
      return {
        title: session.title,
        value: session.id,
        description: description || undefined,
        category,
        footer: relativeTime(session.time.updated),
      }
    }

    const add = (session: Session, category: string) => {
      if (session.parentID || seen.has(session.id)) return
      seen.add(session.id)
      items.push(option(session, category))
    }

    const list = [...(sessions() ?? [])].sort((a, b) => b.time.updated - a.time.updated)

    if (id) {
      const current = props.api.state.session.get(id)
      if (current) add(current, "Current")
    }

    for (const session of list) {
      if (runningLabel(statusOf(session))) add(session, "Running")
    }

    for (const session of list) add(session, dayLabel(session.time.updated))

    return items
  })

  return (
    <DialogSelect
      title="Sessions"
      placeholder="Search sessions"
      options={options()}
      current={currentID()}
      onSelect={(option) => {
        props.api.route.navigate("session", { sessionID: option.value })
        props.api.ui.dialog.clear()
      }}
    />
  )
}

const tui: TuiPlugin = async (api, options) => {
  const input = resolve(options as Options | undefined)
  if ((options as Options | undefined)?.enabled === false) return

  const [open, setOpen] = createSignal(false)

  const canOpen = () => {
    const name = api.route.current.name
    if (name !== "session" && name !== "home") return false
    if (api.ui.dialog.open) return false
    if (!input.requireEmptyPrompt) return true
    return promptIsEmpty(api)
  }

  const openPanel = () => {
    setOpen(true)
    api.ui.dialog.setSize("large")
    api.ui.dialog.replace(
      () => <Picker api={api} input={input} />,
      () => setOpen(false),
    )
  }

  const closePanel = () => {
    api.ui.dialog.clear()
    setOpen(false)
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: OPEN_COMMAND,
        title: "Open sessions panel",
        category: "Session",
        namespace: "palette",
        slashName: "sessions-panel",
        run: openPanel,
      },
    ],
  })

  api.keymap.registerLayer({
    mode: "base",
    priority: 10,
    enabled: () => canOpen(),
    bindings: [{ key: input.openKey, cmd: OPEN_COMMAND, desc: "Open sessions panel" }],
  })

  api.keymap.registerLayer({
    enabled: () => open() && api.ui.dialog.open,
    commands: [{ name: CLOSE_COMMAND, title: "Close sessions panel", run: closePanel }],
    bindings: [{ key: input.closeKey, cmd: CLOSE_COMMAND, desc: "Close sessions panel" }],
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "copilot-sessions",
  tui,
}

export default plugin
