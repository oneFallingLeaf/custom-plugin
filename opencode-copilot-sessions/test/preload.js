import { plugin } from "bun"
import { mock } from "bun:test"
import { fileURLToPath } from "node:url"
import * as runtime from "solid-js/dist/solid.js"
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"

// The host preloads @opentui/solid/preload. That preload's optional module
// resolver is unnecessary for these tests, so
// apply the same Solid universal transform without the unused resolver plugin.
mock.module("solid-js", () => runtime)
mock.module(fileURLToPath(new URL("../node_modules/solid-js/dist/server.cjs", import.meta.url)), () => runtime)
plugin({
  name: "sessions-solid-test-transform",
  setup(build) {
    build.onResolve({ filter: /^solid-js$/ }, () => ({
      path: fileURLToPath(new URL("../node_modules/solid-js/dist/solid.js", import.meta.url)),
    }))
    build.onLoad({ filter: /[/\\]opencode-copilot-sessions[/\\](?:tui|test)[/\\].*\.tsx$/ }, async (args) => {
      const result = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        configFile: false,
        babelrc: false,
        presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], typescript],
      })
      return { contents: result?.code ?? "", loader: "js" }
    })
  },
})
