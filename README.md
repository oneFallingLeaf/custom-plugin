# custom-plugin

A shared repository of [OpenCode](https://opencode.ai) CLI/TUI plugins. Each
plugin is self-contained, configured independently, and documented in its own
README.

| Plugin                                                 | What it does                                                                            | Docs                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [opencode-session-sidebar](opencode-session-sidebar/) | Session browsing contribution for OpenCode's host-owned session panel.                    | [README](opencode-session-sidebar/README.md)       |
| [opencode-model-sidebar](opencode-model-sidebar/)       | Searchable model list in the session sidebar, with one-click switching on patched builds. | [README](opencode-model-sidebar/README.md)          |
| [opencode-token-usage](opencode-token-usage/)           | Live per-session token usage, plus ChatGPT/Codex and OpenCode Go subscription quota.      | [README](opencode-token-usage/README.md)            |

## Requirements

- OpenCode V1 or V2. The TUI plugin APIs differ: V1 uses `tui.json`, while V2
  loads CLI-only plugins from the global `cli.json`.
- [Bun](https://bun.sh) for development and tests. The plugins run inside
  OpenCode.

## Install

Check the installed OpenCode major version before choosing an entrypoint:

```sh
./scripts/check-opencode-version
```

### OpenCode V2

CLI-only plugins are configured in the global
`~/.config/opencode/cli.json` file, under `plugins` (not in V1 `tui.json` or
`opencode.json`). To enable all three plugins from a checkout, add their
directories as separate entries. Replace the example paths with absolute paths
to this repository on your machine:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "/absolute/path/to/custom-plugin/opencode-token-usage",
    "/absolute/path/to/custom-plugin/opencode-session-sidebar",
    "/absolute/path/to/custom-plugin/opencode-model-sidebar"
  ]
}
```

Keep token usage before the model sidebar in this list so **Usage** appears
below the built-in **Context** section and above **Models**.

Each directory is an independently migrated plugin. You can configure only the
ones you want by keeping only their entries. See the individual
[session-sidebar](opencode-session-sidebar/README.md#install),
[model-sidebar](opencode-model-sidebar/README.md#install), and
[token-usage](opencode-token-usage/README.md#install) READMEs for plugin-specific
installation and configuration details. For the V2 configuration model, see
[CLI plugin documentation](https://opencode.ai/v2/docs/build/plugins/cli) and
[migration from V1](https://opencode.ai/v2/docs/migrate-v1).

## Plugins at a glance

### opencode-session-sidebar

Contributes session browsing to OpenCode's host-owned session panel. See the
[plugin README](opencode-session-sidebar/README.md) for its current behavior and
configuration; panel presentation is owned by the host.

### opencode-model-sidebar

A searchable **Models** section in the session sidebar. On stock V2, selection
opens the built-in model picker; an optional
[`V2 model API patch`](opencode-model-sidebar/patches/opencode-model-api-v2.patch)
enables direct switching. See the [plugin README](opencode-model-sidebar/README.md)
for its current options and patch instructions.

### opencode-token-usage

A live **Usage** section in the session sidebar: requests, input/output tokens,
cache and reasoning tokens, optional cost, and subscription quota for the current
provider when usable local quota credentials exist (ChatGPT/Codex for OpenAI
models, OpenCode Go for `opencode-go` models).
Quota windows show a bar, percentage, and time to reset. Options include
`startCollapsed`, `showCost`, `showCache`, `showReasoning`, `showQuota`, and
`enabled`.

OpenCode V2 already has a session list (`<leader>l`), a recent sessions/projects
menu (`ctrl+o`), a searchable model picker (`<leader>m`), and token/context
displays. These plugins are optional when those built-in views meet your needs;
the token plugin additionally shows subscription quota windows. To retire a
plugin from your active setup, remove its entry from the global `cli.json`
`plugins` array.

### OpenCode V1

V1 uses `~/.config/opencode/tui.json` with the singular `plugin` key. From a
checkout, register the V1 implementations using absolute file paths (and use
`$XDG_CONFIG_HOME/opencode/tui.json` if your config home is customized):

```json
{
  "plugin": [
    "/absolute/path/to/custom-plugin/opencode-session-sidebar/tui/v1.tsx",
    "/absolute/path/to/custom-plugin/opencode-model-sidebar/tui/model-sidebar.tsx",
    "/absolute/path/to/custom-plugin/opencode-token-usage/tui/token-usage-v1.tsx"
  ]
}
```

Run `bun install` in each package you enable. V1 and V2 have distinct TUI
implementations and configuration files; use the per-plugin README for options
and package entrypoints. Version `0.2.0` of the session package is prepared but
has not been published to npm.

## Repository layout

```
.
├── opencode-session-sidebar/   # plugin, tests, README, LICENSE
├── opencode-model-sidebar/      # plugin, patch, scripts, tests, README
└── opencode-token-usage/        # plugin, tests, README
```

## Development

Most plugins use Bun for tests and type checking:

```sh
cd opencode-model-sidebar   # or opencode-token-usage
bun install
bun test
bun run typecheck
```

`opencode-model-sidebar` also ships an optional V2 model API patch and helper
scripts for running a patched OpenCode from source; see
[Direct switching](opencode-model-sidebar/README.md#direct-switching).

## License

GPL-2.0-only. See [LICENSE](LICENSE).
