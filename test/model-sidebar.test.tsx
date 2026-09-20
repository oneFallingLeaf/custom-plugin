/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import plugin from "../tui/model-sidebar"

type ModelDef = {
  name: string
  status?: string
  release_date?: string
  cost?: { input?: number; output?: number }
}

type Provider = { id: string; name: string; models: Record<string, ModelDef> }

const SESSION = "ses_test"

function provider(id: string, name: string, count: number, prefix = "Model"): Provider {
  const models: Record<string, ModelDef> = {}
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(2, "0")
    models[`model-${n}`] = {
      name: `${prefix} ${n}`,
      release_date: `2026-01-${String(count - i).padStart(2, "0")}`,
      cost: { input: 1, output: 1 },
    }
  }
  return { id, name, models }
}

function longProvider(id: string, count: number): Provider {
  const models: Record<string, ModelDef> = {}
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(2, "0")
    models[`model-${n}`] = {
      name: `Model ${n} Extremely Long Name That Should Never Wrap`,
      release_date: `2026-01-${String(count - i).padStart(2, "0")}`,
      cost: { input: 1, output: 1 },
    }
  }
  return { id, name: "A Very Long Provider Name Incorporated", models }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type Harness = {
  setup: TestRendererSetup
  slot: (ctx: unknown, props: { session_id: string }) => unknown
  setCalls: Array<{ providerID: string; modelID: string }>
  toasts: Array<{ variant?: string; message?: string }>
  dispatched: string[]
}

async function mount(options?: {
  rows?: number
  providers?: Provider[]
  favorites?: Array<{ providerID: string; modelID: string }>
}): Promise<Harness> {
  const setup = await createTestRenderer({ width: 60, height: 30, useThread: false })
  cleanups.push(() => {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
  })

  const setCalls: Harness["setCalls"] = []
  const toasts: Harness["toasts"] = []
  const dispatched: string[] = []
  const state: { slot?: Harness["slot"] } = {}
  const providers = options?.providers ?? [provider("acme", "Acme", 30)]

  const api = {
    theme: {
      current: { text: "#ffffff", textMuted: "#808080", accent: "#00aaff", success: "#00ff00" },
    },
    state: {
      provider: providers,
      session: { get: () => undefined },
    },
    renderer: setup.renderer,
    ui: {
      toast: (value: { variant?: string; message?: string }) => toasts.push(value),
      dialog: { open: false },
    },
    keymap: { dispatchCommand: (command: string) => dispatched.push(command) },
    client: {},
      model: {
        current: () => undefined,
        set: (model: { providerID: string; modelID: string }) => setCalls.push(model),
        favorite: () =>
          options?.favorites ??
          providers.flatMap((provider) => Object.keys(provider.models).map((modelID) => ({ providerID: provider.id, modelID }))),
      },
    slots: {
      register: (config: { slots: { sidebar_content: Harness["slot"] } }) => {
        state.slot = config.slots.sidebar_content
      },
    },
    command: { register: () => () => {} },
    lifecycle: { onDispose: () => {} },
  }

  await plugin.tui(api as unknown as TuiPluginApi, { maxRows: options?.rows ?? 12 } as never, {} as never)
  const slot = state.slot
  if (!slot) throw new Error("plugin did not register sidebar_content")

  await render(() => slot({}, { session_id: SESSION }) as never, setup.renderer)
  await setup.renderOnce()

  return { setup, slot, setCalls, toasts, dispatched }
}

function lineY(setup: TestRendererSetup, text: string): number {
  const frame = setup.captureSpans()
  return frame.lines.findIndex((line) => line.spans.map((span) => span.text).join("").includes(text))
}

function frame(setup: TestRendererSetup): string {
  return setup.captureCharFrame()
}

test("renders the model list under the header", async () => {
  const { setup } = await mount()
  const screen = frame(setup)
  expect(screen).toContain("Models")
  expect(screen).toContain("Model 00")
  expect(screen).toContain("more")
})

test("Favorites and All tabs switch the visible model list", async () => {
  const { setup } = await mount({ favorites: [{ providerID: "acme", modelID: "model-02" }] })
  expect(frame(setup)).toContain("Favorites 1")
  expect(frame(setup)).toContain("All 30")
  expect(frame(setup)).toContain("Model 02")
  expect(frame(setup)).not.toContain("Model 00")

  const allY = lineY(setup, "All 30")
  await setup.mockMouse.click(15, allY)
  await setup.renderOnce()
  expect(frame(setup)).toContain("Model 00")
})

test("hovering a row does not move the selection or scroll the window", async () => {
  const { setup } = await mount({ rows: 12 })
  const before = frame(setup)
  expect(before).toContain("Model 00")
  expect(before).not.toContain("Model 12")

  const y = lineY(setup, "Model 10")
  expect(y).toBeGreaterThanOrEqual(0)

  await setup.mockMouse.moveTo(3, y)
  await setup.renderOnce()

  const after = frame(setup)
  expect(after).toContain("Model 00")
  expect(after).not.toContain("Model 12")
  expect(after).not.toContain("▲")
})

test("single click highlights but does not switch the model", async () => {
  const { setup, setCalls } = await mount()
  const y = lineY(setup, "Model 03")
  expect(y).toBeGreaterThanOrEqual(0)

  await setup.mockMouse.click(3, y)
  await setup.renderOnce()

  expect(setCalls).toHaveLength(0)

  const searchY = lineY(setup, "Search models")
  await setup.mockMouse.click(3, searchY)
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.renderOnce()

  expect(setCalls).toEqual([{ providerID: "acme", modelID: "model-03" }])
})

test("double click switches the model", async () => {
  const { setup, setCalls } = await mount()
  const y = lineY(setup, "Model 04")
  expect(y).toBeGreaterThanOrEqual(0)

  await setup.mockMouse.doubleClick(3, y)
  await setup.renderOnce()

  expect(setCalls).toEqual([{ providerID: "acme", modelID: "model-04" }])
})

test("two quick clicks on different rows do not switch", async () => {
  const { setup, setCalls } = await mount()
  const first = lineY(setup, "Model 02")
  const second = lineY(setup, "Model 05")

  await setup.mockMouse.click(3, first)
  await setup.mockMouse.click(3, second)
  await setup.renderOnce()

  expect(setCalls).toHaveLength(0)
})

test("clicking the more indicator pages the window", async () => {
  const { setup } = await mount({ rows: 12 })
  const before = frame(setup)
  expect(before).toContain("Model 00")
  expect(before).toContain("18 more")

  const y = lineY(setup, "more")
  await setup.mockMouse.click(3, y)
  await setup.renderOnce()

  const after = frame(setup)
  expect(after).not.toContain("Model 00")
  expect(after).toContain("Model 12")
})

test("clicking a row keeps the list perfectly still", async () => {
  const { setup, setCalls } = await mount({ rows: 12 })
  const before = frame(setup)
  const y = lineY(setup, "Model 08")
  expect(y).toBeGreaterThanOrEqual(0)

  await setup.mockMouse.click(3, y)
  await setup.renderOnce()

  expect(frame(setup)).toEqual(before)
  expect(setCalls).toHaveLength(0)
})

test("navigation scrolls only when the selection leaves the window", async () => {
  const { setup } = await mount({ rows: 12 })
  const searchY = lineY(setup, "Search models")
  await setup.mockMouse.click(3, searchY)
  await setup.renderOnce()

  for (let i = 0; i < 11; i++) setup.mockInput.pressArrow("down")
  await setup.renderOnce()
  expect(frame(setup)).toContain("Model 00")
  expect(frame(setup)).not.toContain("▲")

  setup.mockInput.pressArrow("down")
  await setup.renderOnce()
  expect(frame(setup)).toContain("▲")
  expect(frame(setup)).not.toContain("Model 00")
})

test("long names do not wrap and rows stay aligned", async () => {
  const { setup } = await mount({ providers: [longProvider("acme", 30)], rows: 12 })
  const first = lineY(setup, "Model 00")
  expect(lineY(setup, "Model 01")).toBe(first + 1)
  expect(lineY(setup, "Model 02")).toBe(first + 2)
  expect(lineY(setup, "Model 11")).toBe(first + 11)
})

test("hover sets the OSC 22 pointer and leaving restores the default", async () => {
  const { setup } = await mount()
  const seen: string[] = []
  const original = setup.renderer.setMousePointer.bind(setup.renderer)
  setup.renderer.setMousePointer = ((style: string) => {
    seen.push(style)
    original(style as never)
  }) as typeof setup.renderer.setMousePointer

  const y = lineY(setup, "Model 02")
  await setup.mockMouse.moveTo(3, y)
  await setup.renderOnce()
  expect(seen).toContain("pointer")

  await setup.mockMouse.moveTo(3, 28)
  await setup.renderOnce()
  expect(seen.at(-1)).toBe("default")
})
