/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import type { Context, SlotClaim, KeymapLayer } from "@opencode/plugin/tui/context"
import type { ModelInfo } from "@opencode/client"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { KeyEvent } from "@opentui/core"
import { render } from "@opentui/solid"
import plugin from "../tui/model-sidebar-v2"

const sessionID = "ses_test"
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function model(index: number): ModelInfo {
  const n = String(index).padStart(2, "0")
  return {
    id: `model-${n}`, modelID: `model-${n}`, providerID: "acme", name: `Model ${n}`,
    status: "active", enabled: true, time: { released: 1000 - index }, cost: [],
    capabilities: {} as ModelInfo["capabilities"], variants: [], limit: { context: 100, output: 100 },
  }
}

async function mount(input: {
  patched?: boolean; favorites?: number[]; switchMode?: string; rows?: number; models?: ModelInfo[]
} = {}) {
  const setup = await createTestRenderer({ width: 60, height: 32, useThread: false })
  cleanups.push(() => { if (!setup.renderer.isDestroyed) setup.renderer.destroy() })
  const setCalls: Array<{ providerID: string; modelID: string }> = []
  const switched: Array<{ sessionID: string; model: { providerID: string; id: string } }> = []
  const dispatched: string[] = []
  const layers: Array<() => KeymapLayer> = []
  let slot: SlotClaim<"sidebar.content"> | undefined
  const models = input.models ?? Array.from({ length: 30 }, (_, i) => model(i))
  const context = {
    options: { maxRows: input.rows ?? 12, switchMode: input.switchMode },
    renderer: setup.renderer,
    theme: { text: { base: "#ffffff", muted: "#808080", feedback: { success: { base: "#00ff00" } } }, background: { raised: { high: "#333333" } } },
    location: undefined,
    data: {
      session: { get: () => undefined },
      location: { provider: { list: () => [{ id: "acme", name: "Acme" }, { id: "opencode", name: "OpenCode" }] }, model: { list: () => models } },
    },
    model: input.patched ? {
      current: () => undefined,
      favorite: () => (input.favorites ?? []).map((i) => ({ providerID: "acme", modelID: model(i).id })),
      set: (value: { providerID: string; modelID: string }) => setCalls.push(value),
    } : undefined,
    client: { session: { switchModel: async (value: typeof switched[number]) => { switched.push(value) } } },
    keymap: { layer: (value: () => KeymapLayer) => { layers.push(value) }, dispatch: (id: string) => dispatched.push(id) },
    ui: {
      slot: (value: SlotClaim<"sidebar.content">) => { slot = value; return () => { slot = undefined } },
      toast: { show: () => {} },
    },
  } as unknown as Context
  const cleanup = plugin.setup(context)
  expect(slot?.append).toBe("sidebar.content")
  if (!slot) throw new Error("missing slot")
  await render(() => slot!.render({ sessionID }) as never, setup.renderer)
  await setup.renderOnce()
  return { setup, setCalls, switched, dispatched, layers, cleanup }
}

function frame(setup: TestRendererSetup) { return setup.captureCharFrame() }
function line(setup: TestRendererSetup, text: string) {
  return setup.captureSpans().lines.findIndex((row) => row.spans.map((span) => span.text).join("").includes(text))
}

test("V2 stock plugin renders all models and opens the native picker instead of a session-only switch", async () => {
  const { setup, dispatched, switched } = await mount()
  expect(frame(setup)).toContain("Model 00")
  expect(frame(setup)).not.toContain("Favorites")
  await setup.mockMouse.doubleClick(3, line(setup, "Model 03"))
  await setup.renderOnce()
  expect(dispatched).toEqual(["model.list"])
  expect(switched).toEqual([])
})

test("V2 patched plugin switches on double click but never on a single click", async () => {
  const { setup, setCalls } = await mount({ patched: true, favorites: [3, 4] })
  expect(frame(setup)).toContain("Favorites 2")
  expect(frame(setup)).toContain("Model 03")
  expect(frame(setup)).not.toContain("Model 00")
  const y = line(setup, "Model 03")
  await setup.mockMouse.click(3, y)
  await setup.renderOnce()
  expect(setCalls).toEqual([])
  await setup.mockMouse.click(3, y)
  await setup.renderOnce()
  expect(setCalls).toEqual([{ providerID: "acme", modelID: "model-03" }])
})

test("V2 explicit session mode uses the server switch without invoking the native picker", async () => {
  const { setup, switched, dispatched } = await mount({ switchMode: "session" })
  await setup.mockMouse.doubleClick(3, line(setup, "Model 01"))
  await setup.renderOnce()
  expect(switched).toEqual([{ sessionID, model: { providerID: "acme", id: "model-01" } }])
  expect(dispatched).toEqual([])
})

test("V2 hover and single click keep the visible window pinned; more click pages", async () => {
  const { setup } = await mount({ rows: 12 })
  await setup.mockMouse.moveTo(3, line(setup, "Model 10"))
  await setup.renderOnce()
  expect(frame(setup)).toContain("Model 00")
  expect(frame(setup)).not.toContain("▲")
  await setup.mockMouse.click(3, line(setup, "Model 08"))
  await setup.renderOnce()
  expect(frame(setup)).toContain("Model 00")
  expect(frame(setup)).not.toContain("▲")
  await setup.mockMouse.click(3, line(setup, "more"))
  await setup.renderOnce()
  expect(frame(setup)).toContain("Model 12")
  expect(frame(setup)).not.toContain("Model 00")
})

test("V2 hover sets a pointer without shifting rows and resets it on leave", async () => {
  const { setup } = await mount()
  const seen: string[] = []
  const original = setup.renderer.setMousePointer.bind(setup.renderer)
  setup.renderer.setMousePointer = ((style: string) => {
    seen.push(style)
    original(style as never)
  }) as typeof setup.renderer.setMousePointer
  const initial = line(setup, "Model 01")
  await setup.mockMouse.moveTo(3, initial)
  await setup.renderOnce()
  expect(seen).toContain("pointer")
  expect(line(setup, "Model 01")).toBe(initial)
  await setup.mockMouse.moveTo(3, 30)
  await setup.renderOnce()
  expect(seen.at(-1)).toBe("default")
})

test("V2 keyboard focus command searches and selects the filtered model", async () => {
  const { setup, layers, setCalls } = await mount({ patched: true, favorites: [0, 1, 2] })
  expect(layers).toHaveLength(1)
  expect(layers[0]!().commands?.[0]?.id).toBe("model.sidebar.focus")
  layers[0]!().commands?.[0]?.run()
  setup.mockInput.typeText("02")
  await setup.renderOnce()
  expect(frame(setup)).toContain("Model 02")
  expect(frame(setup)).not.toContain("Model 00")
  setup.mockInput.pressEnter()
  await setup.renderOnce()
  expect(setCalls).toEqual([{ providerID: "acme", modelID: "model-02" }])
})

test("V2 clicking search clears the previous filter and highlights the selected row", async () => {
  const { setup } = await mount()
  const search = line(setup, "Search models")
  const background = (text: string) => setup.captureSpans().lines[line(setup, text)]!.spans
    .find((span) => span.text.includes(text))!.bg.toInts().slice(0, 3)
  expect(background("Search models")).toEqual([51, 51, 51])
  await setup.mockMouse.click(3, search)
  setup.mockInput.typeText("02")
  await setup.renderOnce()
  expect(frame(setup)).not.toContain("Model 00")
  await setup.mockMouse.click(3, search)
  await setup.renderOnce()
  expect(frame(setup)).toContain("⌕ █")
  expect(frame(setup)).not.toContain("Search models")
  expect(frame(setup)).toContain("Model 00")
  await setup.mockMouse.click(3, line(setup, "Model 02"))
  await setup.renderOnce()
  expect(background("Model 02")).toEqual([51, 51, 51])
  expect(background("Model 00")).not.toEqual([51, 51, 51])
})

test("V2 search leaves host-consumed shortcuts alone", async () => {
  const { setup, layers } = await mount()
  layers[0]!().commands?.[0]?.run()
  // Simulate an earlier host key handler claiming a printable shortcut.
  setup.renderer.keyInput.prependListener("keypress", (event) => {
    if (event.name === "x") event.preventDefault()
  })
  setup.mockInput.pressKey("x")
  await setup.renderOnce()
  expect(frame(setup)).toContain("⌕ █")
  expect(frame(setup)).not.toContain("Search models…")
  expect(frame(setup)).toContain("Model 00")
  setup.mockInput.pressKey("z")
  await setup.renderOnce()
  expect(frame(setup)).toContain("No models match")
})

test("V2 search ignores key releases and stopped propagation", async () => {
  const { setup, layers } = await mount()
  layers[0]!().commands?.[0]?.run()
  const key = (eventType: "press" | "release") => new KeyEvent({
    name: "x", ctrl: false, meta: false, shift: false, option: false,
    sequence: "x", number: false, raw: "x", source: "kitty", eventType,
  })
  setup.renderer.keyInput.emit("keypress", key("release"))
  const consumed = key("press")
  consumed.stopPropagation()
  setup.renderer.keyInput.emit("keypress", consumed)
  await setup.renderOnce()
  expect(frame(setup)).toContain("⌕ █")
  expect(frame(setup)).not.toContain("Search models…")
  expect(frame(setup)).toContain("Model 00")
})

test("V2 catalog excludes disabled, deprecated and OpenCode nano models and sorts free models last", async () => {
  const paid = model(0)
  const free = { ...model(1), providerID: "opencode", cost: [{ input: 0 }] as ModelInfo["cost"] }
  const disabled = { ...model(2), enabled: false }
  const deprecated = { ...model(3), status: "deprecated" as const }
  const nano = { ...model(4), providerID: "opencode", id: "hidden-nano" }
  const { setup } = await mount({ models: [free, disabled, deprecated, nano, paid] })
  expect(frame(setup)).toContain("Models 2")
  expect(line(setup, "Model 00")).toBeLessThan(line(setup, "Model 01"))
  expect(frame(setup)).toContain("free")
  expect(frame(setup)).not.toContain("Model 02")
  expect(frame(setup)).not.toContain("Model 03")
  expect(frame(setup)).not.toContain("Model 04")
})
