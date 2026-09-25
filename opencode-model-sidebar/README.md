# opencode-model-sidebar

An [OpenCode](https://opencode.ai) TUI plugin that puts a **searchable model list
in the session sidebar**. On V2 it appends to the `sidebar.content` slot in
plugin order; placement below the built-in LSP / todo / files sections applies
only to the legacy V1 plugin.

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
- Current model highlighted from the TUI selection on a patched host; stock
  V2 can only show the session's server-side model when available.
- Selecting a model switches it: double-click its row, or press `enter`. A
  single click only highlights the row.
- On a patched OpenCode build switching is direct (see
  [Direct switching](#direct-switching)); on stock OpenCode it opens the
  native picker. `switchMode: "session"` explicitly selects the server-only alternative.

## Install

### OpenCode V2

The same package supports V1 (1.18.29+) and V2 (2.0.12+). Its `./tui`
entrypoint selects the implementation for the host; `./v1` and `./v2` are
available for direct imports. Install the package with:

```sh
opencode plugin add opencode-model-sidebar
```

This installs the package and adds it to the global `~/.config/opencode/cli.json`
(or `$XDG_CONFIG_HOME/opencode/cli.json`). It requires 0.1.1 or later; 0.1.0
exports a package root that V2 mistakes for a server plugin. Alternatively, add
the plugin manually to `cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-model-sidebar"]
}
```

For a local checkout, use the absolute path shown in
[`examples/cli.json`](examples/cli.json). `opencode plugin add` accepts npm or
Git package specifiers, not a local directory path.

Restart the CLI after adding it. On stock V2, double-clicking/pressing Enter
opens the native `model.list` picker to complete the switch; the plugin cannot
set the model used by the next typed prompt directly with the public CLI API.
If you require a direct switch, the optional V2 patch below adds that
capability. V1 and V2 implementations are loaded only for their matching hosts.

### OpenCode V1 (legacy)

### As a local file plugin (recommended)

1. Copy the plugin into your global plugin directory:

   ```sh
   mkdir -p ~/.config/opencode/plugins/tui
   cp tui/index.ts tui/model-sidebar.tsx ~/.config/opencode/plugins/tui/
   ```

2. Register it in `~/.config/opencode/tui.json`:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
      "plugin": ["./plugins/tui/index.ts"]
   }
   ```

3. Restart OpenCode.

TUI plugins are **not** auto-discovered; they must be listed in `tui.json`.
The hybrid `tui/index.ts` checks `api.app.version` before loading the V1
implementation. For a direct V1 entry use `./v1` (or
`tui/model-sidebar.tsx`); a local-file installation using `index.ts` must
keep `model-sidebar.tsx` beside it. See [`examples/tui.json`](examples/tui.json).

### Directly from this repo

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/opencode-model-sidebar/tui/index.ts"]
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
| Clear filter        | click search again, or `ctrl+u`               |
| Switch to model     | `enter` or double-click a row                 |
| Highlight a row     | single click a row                            |
| Leave search        | `escape`                                      |
| Collapse section    | click the `Models` header                     |

While the search is focused it takes over the keyboard; `escape` returns focus
to the prompt. Clicking the search field clears its previous text and hides the
placeholder so you can start a new search. The search field and selected model
row have a visible background.

Clicking a row only highlights it; a second click on the same row within 400 ms
switches the model. **Clicking never moves the list** — the visible window is
pinned and only scrolls when keyboard navigation carries the selection out of
view (or when you click `▲/▼ N more` to page). Hovering a row never changes the
selection either; it only shows the pointer cursor, while the search box shows
the text cursor. Long model/provider names are clipped to one line instead of
wrapping, so rows never shift or misalign. Terminal mouse-pointer shapes need a
terminal that supports OSC 22 (for example kitty).

## Configuration

V2 accepts options in the `cli.json` plugin object:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-model-sidebar",
      "options": { "keybind": "ctrl+shift+m", "maxRows": 12, "switchMode": "dialog" }
    }
  ]
}
```

| Option       | Type               | Default         | Description                                                                 |
| ------------ | ------------------ | --------------- | --------------------------------------------------------------------------- |
| `keybind`    | `string`           | `ctrl+shift+m`  | Key that focuses the search box.                                            |
| `maxRows`    | `number`           | `12`            | Visible list rows (the rest scroll via the cursor).                         |
| `switchMode` | `"dialog"｜"session"` | `"dialog"`   | On stock V2, `dialog` opens the native picker; `session` calls `session.switchModel` (session-only, does **not** change the TUI model typed prompts use). |

V2 appends to `sidebar.content` in plugin order; V1's `order` option is not
available in V2. Favorites are only displayed when the patched host exposes
them; stock V2 starts in the All tab and remains usable without a patch.

## Direct switching

The public V2 `@opencode/plugin/tui` context has no client-local model setter
or favorites accessor. The server's `session.switchModel` is not equivalent to
changing the TUI model used by a typed prompt. Direct switching/favorites
therefore require [`patches/opencode-model-api-v2.patch`](patches/opencode-model-api-v2.patch),
which adds `context.model` to the V2 CLI plugin context. It applies cleanly to
the pinned upstream **v2.0.14** tag (not a generic patch for all V2 releases).
The `scripts/opencode-patched` wrapper uses a separate Git worktree and Bun to
build/cache that patched version; using it is optional. Do not place the
wrapper on PATH until you have reviewed it and have a source checkout with the
matching tag. Run the wrapper from this repository with a suitable
`OPENCODE_PATCHED_SRC` or use the native picker on stock V2. Restart the CLI
after changing the binary or plugin.

### V1 patch (legacy)

Stock OpenCode 1.18 does **not** expose the TUI-local model (`context/local`) to
plugins. The model a typed prompt uses lives in TUI-local state, and
`session.switchModel` only changes the session's server-side model. So on stock
OpenCode the only reliable switch is the native picker, and this plugin opens it
for you.

For the v1 TUI plugin, apply
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
bun test        # V1 and V2 rendered mouse/keyboard regressions plus V1 pure helpers
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
