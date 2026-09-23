import { expect, test } from "bun:test"
import { Host } from "@opencode/plugin/host"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

test("V2 host discovers the hybrid directory and both npm package entrypoints", async () => {
  const directory = resolve(import.meta.dir, "..")
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as {
    exports: Record<string, string>
  }
  expect(manifest.exports["."]).toBe("./tui/index.ts")
  expect(manifest.exports["./tui"]).toBe(manifest.exports["."])
  expect(manifest.exports["./v1"]).toBe("./tui/token-usage-v1.tsx")
  expect(manifest.exports["./v2"]).toBe("./tui/token-usage-v2.tsx")
  const entrypoint = Host.resolve({ directory }).tui
  expect(entrypoint).toBe(pathToFileURL(resolve(directory, "tui/index.ts")).href)
  expect(Host.resolve({ directory, name: "opencode-token-usage" }).tui).toBe(entrypoint)
  const module = await Host.load(entrypoint!) as { default: { id: string; setup: unknown; tui: unknown } }
  expect(module.default.id).toBe("token-usage")
  expect(typeof module.default.setup).toBe("function")
  expect(typeof module.default.tui).toBe("function")
})

// Fresh Bun processes isolate module mocks from the real OpenTUI renderer suites.
function run(mode: "guards" | "v1" | "v2") {
  const code = `
    import { mock } from "bun:test"
    import { resolve } from "node:path"
    import { pathToFileURL } from "node:url"
    const entry = (name) => resolve(process.cwd(), "tui", name)
    const seen = []
    if (${JSON.stringify(mode)} === "guards") {
      mock.module(entry("token-usage-v1.tsx"), () => { throw Error("eager V1 import") })
      mock.module(entry("token-usage-v2.tsx"), () => { throw Error("eager V2 import") })
    } else {
      mock.module(entry("token-usage-v1.tsx"), () => {
        seen.push("v1")
        if (${JSON.stringify(mode)} !== "v1") throw Error("cross-imported V1")
        return { default: { tui: async (_api, options, meta) => ({ options, meta }) } }
      })
      mock.module(entry("token-usage-v2.tsx"), () => {
        seen.push("v2")
        if (${JSON.stringify(mode)} !== "v2") throw Error("cross-imported V2")
        return { default: { setup: async (ctx) => ({ version: ctx.app.version }) } }
      })
    }
    const { default: hybrid } = await import(pathToFileURL(entry("token-usage.tsx")).href)
    if (hybrid.id !== "token-usage" || typeof hybrid.tui !== "function" || typeof hybrid.setup !== "function") throw Error("invalid export shape")
    if (seen.length) throw Error("eager runtime import")
    if (${JSON.stringify(mode)} === "guards") {
      for (const version of [undefined, "", "1.invalid", "1.18", "3.0.0", "2.0.15", "10.0.0"]) {
        try { await hybrid.tui({ app: { version } }, {}, {}) ; throw Error("accepted V1 " + version) }
        catch (error) { if (!String(error).includes("requires OpenCode V1")) throw error }
      }
      for (const version of [undefined, "", "2.invalid", "2.0", "1.18.29", "20.0.0"]) {
        try { await hybrid.setup({ app: { version } }) ; throw Error("accepted V2 " + version) }
        catch (error) { if (!String(error).includes("requires OpenCode V2")) throw error }
      }
      if (seen.length) throw Error("imported after failed guards")
    } else if (${JSON.stringify(mode)} === "v1") {
      const result = await hybrid.tui({ app: { version: "1.18.29" } }, { order: 123 }, { state: "first" })
      if (result.options.order !== 123 || result.meta.state !== "first" || seen.join() !== "v1") throw Error("V1 did not receive arguments")
    } else {
      const result = await hybrid.setup({ app: { version: "2.0.15" } })
      if (result.version !== "2.0.15" || seen.join() !== "v2") throw Error("V2 did not receive context")
    }
    console.log("dispatcher " + ${JSON.stringify(mode)} + " passed")
  `
  const output = Bun.spawnSync([process.execPath, "-e", code], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
  expect(new TextDecoder().decode(output.stderr)).toBe("")
  expect(output.exitCode).toBe(0)
  expect(new TextDecoder().decode(output.stdout)).toContain(`dispatcher ${mode} passed`)
}

test("hybrid rejects missing, unsupported and wrong-major versions before loading either runtime", () => run("guards"))
test("hybrid V1 entry loads only the V1 module and forwards options and meta", () => run("v1"))
test("hybrid V2 entry loads only the V2 module and forwards context", () => run("v2"))
