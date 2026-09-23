# opencode-copilot-sessions

An [OpenCode](https://opencode.ai) TUI plugin for switching sessions from a
collapsible panel at the left edge of the screen.

Press `←` when the prompt is empty, click the **Sessions** button beside the
prompt, or run `/sessions-panel` to toggle the panel. Use `↑`/`↓` to select a
session and `Enter` to switch; `→`, `Escape`, or the `×` button closes it. Click
a session to switch directly. The current session is marked `current`, and
active sessions are grouped under **Running** with `running` or `retrying`
status. The list updates when sessions change and when status events arrive.

The panel is non-modal. OpenCode's TUI plugin API does not provide a left-hand
layout slot that reserves space, so the panel overlays the left edge of the
screen while open. Closing it reveals the content underneath.

## Install

Copy the plugin into your global TUI plugin directory and register it in
`~/.config/opencode/tui.json`:

```sh
mkdir -p ~/.config/opencode/plugins/tui
cp tui/sessions.tsx ~/.config/opencode/plugins/tui/
```

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["./plugins/tui/sessions.tsx", { "openKey": "left", "closeKey": "right" }]
  ]
}
```

Restart OpenCode. TUI plugins are registered in `tui.json`, not `opencode.json`.
You can also register this repository's `tui/sessions.tsx` by absolute path.

## Controls

| Action | Key / control |
| --- | --- |
| Toggle the panel | **Sessions** button beside the prompt or `/sessions-panel` |
| Open from an empty prompt | `left` (configurable) |
| Search session titles | Type while the panel is open |
| Edit / clear search | `backspace` / `ctrl+u` |
| Move selection | `up` / `down` |
| Switch session | `enter` or click a session |
| Close and return to the prompt | `right` (configurable), `escape`, or `×` |

When the prompt contains text, `left` still moves the cursor unless
`requireEmptyPrompt` is set to `false`. The button and command work both at
startup and inside a session.

Search is case-insensitive and filters the fetched session titles within your
configured `scope` and `limit` (50 by default). It is not a search of message
contents or sessions beyond that limit. Running/current markers remain visible
on matching sessions. Arrow keys navigate only matches; Enter does nothing when
there are no matches. Closing and reopening the panel resets the query.

Clicking back into the prompt closes the panel without changing your draft.

## Configuration

Options go in the second element of the `tui.json` plugin entry:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["./plugins/tui/sessions.tsx", {
      "openKey": "left",
      "closeKey": "right",
      "requireEmptyPrompt": true,
      "scope": "project",
      "limit": 50,
      "showStatus": true
    }]
  ]
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `openKey` | `string` | `left` | Key to open the panel when closed. |
| `closeKey` | `string` | `right` | Key to close the panel (`escape` also works). |
| `requireEmptyPrompt` | `boolean` | `true` | Only use `openKey` when the prompt is empty. |
| `scope` | `"project"` or `"all"` | `"project"` | List sessions from this project or all projects. |
| `limit` | `number` | `50` | Maximum number of sessions fetched. |
| `showStatus` | `boolean` | `true` | Group and mark running or retrying sessions. |
| `enabled` | `boolean` | `true` | Disable the plugin without removing its entry. |

The list shows top-level sessions only; subagent sessions are hidden. Active
status depends on OpenCode exposing live status through
`api.state.session.status`.

The `all` scope uses the host's global experimental session-list endpoint.
Positive fractional limits are rounded down, with a minimum of one.

While the prompt is empty, `left` opens this panel instead of OpenCode's
previous-child-session shortcut. Change `openKey` if you use that shortcut.

Requires an OpenCode build with the keymap-backed TUI plugin API and app and
prompt-right slots (`@opencode-ai/plugin` >= 1.18.0).

## Development

From this directory, run `bun install`, `bun test`, and `bun run typecheck`.

## License

GPL-2.0-only. See [LICENSE](LICENSE).
