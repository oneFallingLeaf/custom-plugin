import { expect, test } from "bun:test"
import pkg from "../package.json"

// V2's `opencode plugin add` treats a package root export as a server plugin,
// so the package must stay TUI-only for the installer to register it correctly.
test("package exposes only TUI entrypoints", () => {
  expect(Object.keys(pkg.exports)).not.toContain(".")
  expect(pkg.exports["./tui"]).toBe("./tui/index.ts")
  expect(pkg["oc-plugin"]).toEqual(["tui"])
})
