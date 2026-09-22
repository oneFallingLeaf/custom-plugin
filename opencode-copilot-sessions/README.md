# opencode-copilot-sessions

An [OpenCode](https://opencode.ai) TUI plugin that brings the GitHub Copilot
CLI session-switching gesture to OpenCode.

Press `←` while the prompt is empty and a **Sessions** panel opens, with focus
moved into it. Move with `↑`/`↓`, press `Enter` to switch, and press `→` (or
`Escape`) to close and return focus to the prompt. Sessions that are currently
executing are grouped under **Running**, and the session you are in is marked
`current`.

```
┌─ Sessions ───────────────────────────────┐
│  Current                                 │
│▸ My current session            current    │
│  Running                                 │
│  Refactor session store         running   │
│  Today                                    │
│  Fix flaky auth test            12m       │
│  Yesterday                                │
│  Add keybind docs               1d        │
└──────────────────────────────────────────┘
```

## Why

OpenCode's built-in session switcher (`<leader>l` / `/resume`) is a modal
dialog. This plugin keeps that robust dialog-based picker but adds the Copilot
muscle memory: `←` opens it when the command line is empty, `→` closes it.
Or run it any time with `/sessions-panel` or the `Open sessions panel` command.

## Install

### Local file plugin (recommended)

1. Copy the plugin into your global plugin directory:

   ```sh
   mkdir -p ~/.config/opencode/plugins/tui
   cp tui/sessions.tsx ~/.config/opencode/plugins/tui/
   ```

2. Register it in `~/.config/opencode/tui.json`:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": [
       ["./plugins/tui/sessions.tsx", { "openKey": "left", "closeKey": "right" }]
     ]
   }
   ```

3. Restart OpenCode.

TUI plugins are **not** auto-discovered; they must be listed in `tui.json`
(not `opencode.json`).

### Directly from this repo

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/opencode-copilot-sessions/tui/sessions.tsx"]
}
```

## Usage

| Action                     | Key / command                                    |
| -------------------------- | ------------------------------------------------ |
| Open the sessions panel    | `left` (when the prompt is empty, on `home` or a session) or `/sessions-panel` |
| Move selection             | `up` / `down`                                    |
| Switch to the session      | `enter` or click a row                           |
| Close and refocus prompt   | `right` (configurable) or `escape`               |
| Search                     | just type to filter by title                     |

When the prompt already contains text, `left` behaves normally and moves the
cursor — the panel only opens when there is nothing in the command line. This
works both at startup (the `home` route) and inside a session.

## Configuration

Options are the second element of the `tui.json` entry:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "./plugins/tui/sessions.tsx",
      {
        "openKey": "left",
        "closeKey": "right",
        "requireEmptyPrompt": true,
        "scope": "project",
        "limit": 50,
        "showStatus": true
      }
    ]
  ]
}
```

| Option               | Type                 | Default     | Description                                                                 |
| -------------------- | -------------------- | ----------- | --------------------------------------------------------------------------- |
| `openKey`            | `string`             | `left`      | Key that opens the panel.                                                    |
| `closeKey`           | `string`             | `right`     | Key that closes the panel (`escape` always works too).                       |
| `requireEmptyPrompt` | `boolean`            | `true`      | Only open when the prompt input is empty. Set `false` to open on any `←` while focused. |
| `scope`              | `"project"｜"all"`    | `"project"` | Restrict the list to the current project or show every session.             |
| `limit`              | `number`             | `50`        | Maximum number of sessions to list.                                          |
| `showStatus`         | `boolean`            | `true`      | Group running sessions under **Running** and show `running` / `retrying` markers. |
| `enabled`            | `boolean`            | `true`      | Set `false` in the options tuple to disable the plugin without removing it. |

## How it works

- Registers a keymap layer bound to `openKey` with `mode: "base"`, a higher
  `priority` than the prompt's textarea layer, and an `enabled` matcher that
  only activates when the route is `home` or a session, no dialog is open, and
  the prompt is empty. This is why `←` opens the panel when empty but still
  moves the cursor when you are editing, and why it also works at startup
  before you have entered a session.
- Opens the picker through OpenCode's host dialog stack
  (`api.ui.dialog.replace`), using the built-in `DialogSelect`, so navigation,
  filtering, Escape, and focus restoration are handled by the host.
- A second layer binds `closeKey` to close that dialog and return focus to the
  prompt.

## Caveats

- Uses the TUI plugin keymap API (`api.keymap.registerLayer` with layer fields).
  Requires an OpenCode build that ships the keymap-backed TUI plugin API.
- While the prompt is empty, `←` opens this panel instead of OpenCode's
  "previous child session" shortcut (`session.child.previous`, also bound to
  `left`) inside a session, and instead of moving the cursor on the `home`
  route. Change `openKey` or set `enabled: false` if you rely on either.
- The panel lists top-level sessions only; subagent sessions are hidden.
- A session counting as **Running** depends on the host exposing live session
  status through `api.state.session.status`.

## License

GPL-2.0-only. See [LICENSE](LICENSE).
