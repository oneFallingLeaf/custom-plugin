# custom-plugin

A shared repository of [OpenCode](https://opencode.ai) TUI plugins. Each plugin
is self-contained, installed on its own, and documented in its own README.

| Plugin                                                 | What it does                                                                            | Docs                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [opencode-session-sidebar](opencode-session-sidebar/) | Collapsible left-edge sessions panel with live running status and session switching.      | [README](opencode-session-sidebar/README.md)       |
| [opencode-model-sidebar](opencode-model-sidebar/)       | Searchable model list in the session sidebar, with one-click switching on patched builds. | [README](opencode-model-sidebar/README.md)          |
| [opencode-token-usage](opencode-token-usage/)           | Live per-session token usage, plus ChatGPT/Codex and OpenCode Go subscription quota.      | [README](opencode-token-usage/README.md)            |

## Requirements

- OpenCode with the TUI plugin API (`@opencode-ai/plugin` >= 1.18.0).
- [Bun](https://bun.sh) for development and tests. The plugins run inside
  OpenCode.

## Install

TUI plugins are **not** auto-discovered. They must be listed in
`~/.config/opencode/tui.json` (not `opencode.json`).

1. Copy the plugin file into your global plugin directory:

   ```sh
   mkdir -p ~/.config/opencode/plugins/tui
   cp opencode-model-sidebar/tui/model-sidebar.tsx ~/.config/opencode/plugins/tui/
   ```

2. Register it, with options in the second tuple element if you want any:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": [
       ["./plugins/tui/model-sidebar.tsx", { "order": 350 }]
     ]
   }
   ```

3. Restart OpenCode.

Alternatively, point `tui.json` at a file inside a clone of this repository by
absolute path. The per-plugin READMEs have copy-pasteable examples and the full
option reference.

## Plugins at a glance

### opencode-session-sidebar

Click **Sessions** beside the prompt, run `/sessions-panel`, or press `←` while
the prompt is empty to open the left-edge panel. Type to search session titles,
use `Backspace` to edit or `Ctrl+U` to clear. Move with `↑`/`↓`, switch with
`Enter` or click a session, and collapse with `→`/`Escape` or `×`. Running
sessions are grouped and the current session is marked. The panel overlays the
left edge while open because the host does not expose a width-reserving left
sidebar slot. Configure `openKey`, `closeKey`, `requireEmptyPrompt`, `scope`,
`limit`, `showStatus`, and `enabled`.

### opencode-model-sidebar

A **Models** section in the session sidebar, below the built-in LSP/todo/files
blocks: live model list, favorites and all-models tabs, fuzzy search, keyboard
and mouse navigation. Defaults to opening the native picker when switching; apply
[`patches/opencode-model-api.patch`](opencode-model-sidebar/patches/opencode-model-api.patch)
to a source build for real one-click switching. Options: `keybind`, `order`,
`maxRows`, `switchMode`.

### opencode-token-usage

A live **Usage** section in the session sidebar: requests, input/output tokens,
cache and reasoning tokens, optional cost, and subscription quota for the current
provider (ChatGPT/Codex for OpenAI models, OpenCode Go for `opencode-go` models).
Quota windows show a bar, percentage, and time to reset. Options: `order`,
`startCollapsed`, `showCost`, `showCache`, `showReasoning`, `enabled`.

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

`opencode-model-sidebar` also ships the model API patch and helper scripts for
running a patched OpenCode from source; see its
[README](opencode-model-sidebar/README.md#one-click-switching).

## License

GPL-2.0-only. See [LICENSE](LICENSE).
