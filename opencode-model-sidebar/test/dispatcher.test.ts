import { expect, test } from "bun:test"

// A separate process prevents the rendered V1/V2 suites from preloading either
// implementation and masking an accidental eager import in the package entry.
function probe(method: "tui" | "setup", version: string) {
  const script = `
    const { default: plugin } = await import("./tui/index.ts")
    const loaded = () => Object.keys(require.cache).filter((path) => /\\/tui\\/model-sidebar(?:-v2)?\\.tsx$/.test(path))
      .map((path) => path.split("/").at(-1)).sort()
    const before = loaded()
    let error
    try {
      if (${JSON.stringify(method)} === "tui") {
        await plugin.tui({ app: { version: ${JSON.stringify(version)} } }, { enabled: false }, {})
      } else {
        await plugin.setup({ app: { version: ${JSON.stringify(version)} }, options: { enabled: false } })
      }
    } catch (cause) { error = String(cause) }
    console.log(JSON.stringify({ id: plugin.id, before, after: loaded(), error }))
  `
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString().trim()) as {
    id: string; before: string[]; after: string[]; error?: string
  }
}

test("hybrid tui selects V1 without importing V2", () => {
  const result = probe("tui", "1.18.29")
  expect(result).toEqual({ id: "model-sidebar", before: [], after: ["model-sidebar.tsx"] })
})

test("hybrid setup selects V2 without importing V1", () => {
  const result = probe("setup", "2.0.12")
  expect(result).toEqual({ id: "model-sidebar", before: [], after: ["model-sidebar-v2.tsx"] })
})

test("hybrid rejects mismatched and unknown host versions before importing either implementation", () => {
  for (const [method, version] of [["tui", "2.0.12"], ["setup", "1.18.29"], ["setup", "3.0.0"], ["tui", ""]] as const) {
    const result = probe(method, version)
    expect(result.before).toEqual([])
    expect(result.after).toEqual([])
    expect(result.error).toContain("model-sidebar:")
  }
})
