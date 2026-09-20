import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { collect, resolveOptions } from "../tui/model-sidebar"

type Model = {
  name?: string
  status?: string
  release_date?: string
  cost?: { input?: number; output?: number }
}

function provider(id: string, name: string, models: Record<string, Model>) {
  return { id, name, models }
}

function api(providers: unknown[]): TuiPluginApi {
  return { state: { provider: providers } } as unknown as TuiPluginApi
}

test("resolveOptions applies defaults", () => {
  expect(resolveOptions(undefined)).toEqual({
    order: 600,
    keybind: "ctrl+shift+m",
    maxRows: 12,
    switchMode: "dialog",
  })
})

test("resolveOptions honors overrides and rejects bad values", () => {
  expect(resolveOptions({ order: 350, keybind: "ctrl+m", maxRows: 8, switchMode: "session" })).toEqual({
    order: 350,
    keybind: "ctrl+m",
    maxRows: 8,
    switchMode: "session",
  })
  expect(resolveOptions({ keybind: "", maxRows: 0 }).maxRows).toBe(12)
  expect(resolveOptions({ maxRows: -5 }).maxRows).toBe(12)
})

test("collect skips deprecated models", () => {
  const items = collect(
    api([
      provider("acme", "Acme", {
        good: { name: "Good", release_date: "2026-01-02" },
        dead: { name: "Dead", status: "deprecated", release_date: "2026-01-01" },
      }),
    ]),
    "",
  )
  expect(items.map((item) => item.id)).toEqual(["good"])
})

test("collect hides -nano variants only for the opencode provider", () => {
  const items = collect(
    api([
      provider("opencode", "OpenCode", {
        "gpt-5-nano": { name: "GPT-5 Nano", release_date: "2026-01-03" },
        "gpt-5": { name: "GPT-5", release_date: "2026-01-02" },
      }),
      provider("acme", "Acme", {
        "acme-nano": { name: "Acme Nano", release_date: "2026-01-01" },
      }),
    ]),
    "",
  )
  expect(items.map((item) => item.id).sort()).toEqual(["acme-nano", "gpt-5"])
})

test("collect filters by name, provider, and id", () => {
  const providers = [
    provider("acme", "Acme Labs", {
      "foo-1": { name: "Foo One", release_date: "2026-01-03" },
    }),
    provider("beta", "Beta Co", {
      "bar-9": { name: "Bar Nine", release_date: "2026-01-02" },
    }),
  ].map((p) => p as { id: string; name: string; models: Record<string, Model> })

  expect(collect(api(providers), "foo").map((item) => item.id)).toEqual(["foo-1"])
  expect(collect(api(providers), "beta").map((item) => item.id)).toEqual(["bar-9"])
  expect(collect(api(providers), "bar-9").map((item) => item.id)).toEqual(["bar-9"])
  expect(collect(api(providers), "nope")).toEqual([])
})

test("collect marks free opencode models and sorts them last", () => {
  const items = collect(
    api([
      provider("opencode", "OpenCode", {
        free: { name: "Free", release_date: "2026-01-01", cost: { input: 0 } },
        paid: { name: "Paid", release_date: "2026-01-05", cost: { input: 3 } },
      }),
      provider("acme", "Acme", {
        other: { name: "Other", release_date: "2026-01-04", cost: { input: 0 } },
      }),
    ]),
    "",
  )
  expect(items.map((item) => item.id)).toEqual(["paid", "other", "free"])
  expect(items.find((item) => item.id === "free")?.free).toBe(true)
  expect(items.find((item) => item.id === "other")?.free).toBe(false)
  expect(items.find((item) => item.id === "paid")?.free).toBe(false)
})

test("collect sorts by release date descending then name", () => {
  const items = collect(
    api([
      provider("acme", "Acme", {
        a: { name: "Alpha", release_date: "2026-01-01" },
        b: { name: "Bravo", release_date: "2026-03-01" },
        c: { name: "Charlie", release_date: "2026-01-01" },
      }),
    ]),
    "",
  )
  expect(items.map((item) => item.id)).toEqual(["b", "a", "c"])
})
