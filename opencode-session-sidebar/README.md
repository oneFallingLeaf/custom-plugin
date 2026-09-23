# opencode-session-sidebar 0.2.0

A sessions plugin for both OpenCode V1 and [OpenCode V2](https://opencode.ai/v2/docs/build/plugins/cli). The package root and `./tui` resolve to the same hybrid entry: it checks the host's app version and loads only the matching implementation. The root export makes the package discoverable by the CLI; it is not a server plugin. `./v1` and `./v2` are also available as explicit exports; do not load a version-specific entry in the other host.

## OpenCode V1

V1 uses a non-modal overlay over the left edge, from Home or a session. Press `left` with an empty prompt, click **Sessions** next to the prompt, or use `/sessions-panel`; `up`/`down` and `enter` navigate, `right` or `escape` closes. Clicking into the prompt closes the overlay without discarding a draft. The V1 default `openKey` remains `left` (it overrides the previous-child shortcut while the prompt is empty).

Run `bun install` in this checkout and add the package to V1's global `~/.config/opencode/tui.json` (or `$XDG_CONFIG_HOME/opencode/tui.json`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["/absolute/path/to/custom-plugin/opencode-session-sidebar", {
    "openKey": "left", "closeKey": "right", "scope": "project", "limit": 50
  }]]
}
```

See [`examples/tui.json`](examples/tui.json). A published installation can instead use `"opencode-session-sidebar@0.2.0"` in the V1 `plugin` list once 0.2.0 is published. The V1 package loader uses the `./tui` export, not the V2 CLI config. For a manually installed local package, point V1 at the absolute path of `tui/index.ts` in that installed package; keep its dependencies installed. Do not copy only that file: it dynamically loads `v1.tsx` from the same directory.

## OpenCode V2

From a session, click **Sessions** in the prompt footer, use `/sessions-panel`, or select **Toggle sessions panel** from the command palette. There is no default keyboard shortcut to open the panel: V2 uses `left` for `session.child.previous`. V2 presents the list as a left-edge overlay, including when opened with the configured hotkey; it covers the left edge of the session while open. Use `up`/`down` and `enter` to switch, or click a session. `right`, `escape`, and the `×` control close the panel. Typing filters fetched titles case-insensitively; `backspace` removes a character and `ctrl+u` clears the search. Subagent sessions are hidden. The current session appears first; active sessions are grouped under **Running**.

The V2 sessions overlay exists only inside a session: the slash/palette command cannot open it from Home. It temporarily blurs the prompt and restores focus on close. Session status is refreshed from the V2 data cache and status events; retrying is shown when a retry status event is observed while the overlay is mounted.

## Install

From this checkout, run `bun install` in this package directory, then add the
package directory to your **global** `~/.config/opencode/cli.json` (or
`$XDG_CONFIG_HOME/opencode/cli.json`). Replace the path with the absolute path
to your checkout:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/absolute/path/to/custom-plugin/opencode-session-sidebar"]
}
```

OpenCode loads the package's `./tui` export automatically. This configuration is local to the CLI and works when connected to a remote OpenCode server. Use `cli.json` for V2 and `tui.json` for V1; do not put this CLI-only plugin in server `opencode.json`. There is no project-local V2 `cli.json`. Restart the CLI after installation. See [CLI plugin installation](https://opencode.ai/v2/docs/cli/plugins).

The source package is prepared as version `0.2.0`, but this version has not
been published to npm yet. Once published, replace the checkout path with
`"opencode-session-sidebar@0.2.0"`. Alternatively, install it manually with
`npm install --prefix ~/.config/opencode opencode-session-sidebar@0.2.0` (use
`$XDG_CONFIG_HOME/opencode` as the prefix if set) and use
`./node_modules/opencode-session-sidebar` as the package entry. Do not point
the CLI at the individual `.tsx` file; the package exposes `./tui`.

## V2 configuration

Pass options with the V2 object form (also in [`examples/cli.json`](examples/cli.json)):

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [{
    "package": "/absolute/path/to/custom-plugin/opencode-session-sidebar",
    "options": {
      "closeKey": "right",
      "requireEmptyPrompt": true,
      "scope": "project",
      "limit": 50,
      "showStatus": true
    }
  }]
}
```

| Option | Default | Purpose |
| --- | --- | --- |
| `openKey` | unset in V2; `left` in V1 | Optional global key to open from a session in V2; leave unset to preserve V2 shortcuts. |
| `closeKey` | `right` | Key to close (also `escape`). |
| `requireEmptyPrompt` | `true` | If `openKey` is set, do not intercept it while editing a draft. |
| `scope` | `project` | `project` lists sessions in the current session's project; `all` lists across projects. |
| `limit` | `50` | Maximum number of sessions fetched; positive fractions round down to at least one. |
| `showStatus` | `true` | Mark running/retrying sessions and group them before older sessions. |
| `enabled` | `true` | Disable this plugin without removing its configuration. |

Search only filters the fetched session titles, not message contents or sessions beyond `limit`. If the project identity is not yet available in the local session cache, the project view may be empty until reopening the panel.

To opt into the former arrow shortcut, add `"openKey": "left"` to this plugin's `options`. This registers a global keymap layer while in a session with the overlay closed; with the default `requireEmptyPrompt: true`, it is active only when the prompt is empty. **Tradeoff:** it may override V2's `session.child.previous` on `left` in that context. Choose another key after checking your [V2 keybindings](https://opencode.ai/v2/docs/cli/keybinds), or leave `openKey` unset to retain built-in navigation. Setting `openKey` to an empty string also leaves it unbound.

## Development

Run `bun install`, `bun test`, `bun run typecheck`, and `npm pack --dry-run` from this directory. V1 requires the keymap-backed TUI API (`@opencode-ai/plugin` >= 1.18.0) and OpenTUI >= 0.4.5. V2 requires OpenTUI >= 0.5.10. The 0.2.0 package is not yet published. GPL-2.0-only; see [LICENSE](LICENSE).
