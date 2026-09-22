# opencode-model-sidebar

An [OpenCode](https://opencode.ai) TUI plugin that puts a **searchable model list
in the session sidebar**, directly below the built-in LSP / todo / files
sections.

```
▼ Models 98
⌕ Search models…▏
● Muse Spark 1.3        OpenCode Zen
  DeepSeek V4 Flash     DeepSeek
  GLM-5.3-Flash         OpenCode Go
  ...
```

- Live model list from your providers (deprecated models and `-nano` variants
  hidden, same rules as the native picker).
- Tabs for your native OpenCode favorites and the full model list.
- Fuzzy-ish search box: type to filter by model name, provider, or model id.
- Keyboard and mouse driven.
- Current model highlighted.
- Selecting a model switches it: double-click its row, or press `enter`. A
  single click only highlights the row.
- On a patched OpenCode build switching is direct (see
  [One-click switching](#one-click-switching)); on stock OpenCode it opens the
  native picker.

## Install

### As a local file plugin (recommended)

1. Copy the plugin into your global plugin directory:

   ```sh
   mkdir -p ~/.config/opencode/plugins/tui
   cp tui/model-sidebar.tsx ~/.config/opencode/plugins/tui/
   ```

2. Register it in `~/.config/opencode/tui.json`:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["./plugins/tui/model-sidebar.tsx"]
   }
   ```

3. Restart OpenCode.

TUI plugins are **not** auto-discovered; they must be listed in `tui.json`.

### Directly from this repo

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/custom-plugin/tui/model-sidebar.tsx"]
}
```

## Usage

| Action              | Key / mouse                                   |
| ------------------- | --------------------------------------------- |
| Focus the search    | `ctrl+shift+m` (configurable) or click search |
| Filter              | just type                                     |
| Move selection      | `up` / `down`, `ctrl+p` / `ctrl+n`            |
| Page                | `pageup` / `pagedown`, or click `▲/▼ N more`  |
| Switch tab          | click `Favorites` or `All`                     |
| Clear filter        | `ctrl+u`                                      |
| Switch to model     | `enter` or double-click a row                 |
| Highlight a row     | single click a row                            |
| Leave search        | `escape`                                      |
| Collapse section    | click the `Models` header                     |

While the search is focused it takes over the keyboard; `escape` returns focus
to the prompt.

Clicking a row only highlights it; a second click on the same row within 400 ms
switches the model. **Clicking never moves the list** — the visible window is
pinned and only scrolls when keyboard navigation carries the selection out of
view (or when you click `▲/▼ N more` to page). Hovering a row never changes the
selection either; it only shows the pointer cursor, while the search box shows
the text cursor. Long model/provider names are clipped to one line instead of
wrapping, so rows never shift or misalign. Terminal mouse-pointer shapes need a
terminal that supports OSC 22 (for example kitty).

## Configuration

The plugin accepts options as the second element of the `tui.json` entry:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "./plugins/tui/model-sidebar.tsx",
      {
        "keybind": "ctrl+shift+m",
        "order": 600,
        "maxRows": 12,
        "switchMode": "dialog"
      }
    ]
  ]
}
```

| Option       | Type               | Default         | Description                                                                 |
| ------------ | ------------------ | --------------- | --------------------------------------------------------------------------- |
| `keybind`    | `string`           | `ctrl+shift+m`  | Key that focuses the search box.                                            |
| `order`      | `number`           | `600`           | Sidebar slot order. Built-ins: context `100`, mcp `200`, lsp `300`, todo `400`, files `500`. Use `>500` to sit at the bottom, `350` for directly under LSP. |
| `maxRows`    | `number`           | `12`            | Visible list rows (the rest scroll via the cursor).                         |
| `switchMode` | `"dialog"｜"session"` | `"dialog"`   | Fallback when the host does not expose `api.model`. `dialog` opens the native picker; `session` calls `session.switchModel` (session-only, does **not** change the model typed prompts use). |

## One-click switching

Stock OpenCode 1.18 does **not** expose the TUI-local model (`context/local`) to
plugins. The model a typed prompt uses lives in TUI-local state, and
`session.switchModel` only changes the session's server-side model. So on stock
OpenCode the only reliable switch is the native picker, and this plugin opens it
for you.

To get a real one-click switch, apply
[`patches/opencode-model-api.patch`](patches/opencode-model-api.patch), which adds
`api.model` (`current` / `set` / `recent` / `favorite` / `toggleFavorite`) to the
TUI plugin API. The plugin detects `api.model.set` at runtime and switches
directly when it is present. The Favorites tab also uses `api.model.favorite`, so
it is populated only on a patched build.

The patch touches:

- `packages/plugin/src/tui.ts` — public `TuiPluginApi` type
- `packages/tui/src/plugin/adapters.tsx` — adapter over `useLocal().model`
- `packages/tui/src/app.tsx` — passes `local` to the adapters
- `packages/opencode/src/plugin/tui/runtime.ts` — exposes `model` to external plugins
- `packages/opencode/test/fixture/tui-plugin.ts` — test fixture stub

Apply and run from source (needs Bun):

```sh
git clone https://github.com/anomalyco/opencode
cd opencode
git checkout v1.18.29
git apply /path/to/patches/opencode-model-api.patch
bun install
bun run --cwd packages/opencode src/index.ts
```

Or build a binary with `bun run --cwd packages/opencode build --single --skip-embed-web-ui`.

## Development

Requires [Bun](https://bun.sh). Install dependencies and run the regression suite:

```sh
bun install
bun test        # 18 tests: pure helpers + rendered mouse/keyboard behavior
bun run typecheck
```

Tests render the real plugin with opentui's test renderer and mock mouse/keyboard
(`@opentui/solid` `render`, `@opentui/core/testing`), covering the behaviors that
have regressed before:

- hovering a row must not move the selection or scroll the window
- clicking a row keeps the list perfectly still (no re-centring/scroll)
- navigation scrolls only when the selection leaves the visible window
- long names do not wrap; rows stay one line and aligned
- a single click only highlights; a double click switches the model
- two quick clicks on different rows do not switch
- clicking `▲/▼ N more` pages the window
- the OSC 22 pointer is set on hover and restored on leave
- `collect()` filtering/sorting and `resolveOptions()` defaults

## Tracing

The behavior and its history are documented in
[`architecture.md`](architecture.md), including the sessions that introduced and
fixed each interaction.

## License

GPL-2.0-only. See [LICENSE](LICENSE).
