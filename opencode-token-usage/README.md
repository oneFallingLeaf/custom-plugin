# opencode-token-usage

An OpenCode [V1](https://opencode.ai/v2/docs/build/plugins/migrate-v1) / [V2](https://opencode.ai/v2/docs/build/plugins/cli) TUI plugin that adds a **live per-session
token usage section to the session sidebar**, and shows subscription quota for
the current provider: ChatGPT/Codex while the session model is an OpenAI model,
OpenCode Go while it is an `opencode-go` model.

```
▼ Usage 42 reqs
In 1.2M · Out 180K
Cache 900K↓ 60K↑
Think 45K
$3.42
OpenAI
Daily   ▓▓▓░░░ 48% · 3h 12m
Weekly  ▓░░░░░ 12% · 2d 6h
```

- Live totals for the current session: requests, input/output, cache
  read/write, reasoning tokens, and optionally cost.
- Collapsible section — click the **Usage** header.
- Quota bars for the active OpenAI V2 OAuth connection when the companion server plugin is installed, or legacy credential-source quotas, colored by usage
  (green under 50%, yellow from 50%, red above 85%), with time to reset.
- Resolved quota windows disappear once their reset time passes.
- Disable quota requests with `showQuota: false` while keeping session totals.
- Token totals tolerate incomplete messages and use compact `K`, `M`, and `B`
  suffixes, including rounded unit boundaries.

## Install

### OpenCode V2 (global CLI configuration)

Add the CLI plugin to the global `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`):

   ```json
   {
      "$schema": "https://opencode.ai/v2/cli.json",
      "plugins": [{
        "package": "/absolute/path/to/custom-plugin/opencode-token-usage",
        "options": { "showCost": true }
      }]
   }
    ```

To display quota for your **active OpenAI V2 sign-in**, also register the server plugin in your global `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/custom-plugin/opencode-token-usage/server"]
}
```

Merge these entries into your existing configurations rather than replacing other plugins. The server plugin runs where your OpenCode server runs, including for a remote server; install it and its dependencies on that server. Restart OpenCode's service (`opencode service restart`) and the CLI after configuration changes. The server resolves the active OAuth credential, calls the ChatGPT usage endpoint, and returns **only quota windows** to the CLI. API-key OpenAI connections cannot use this ChatGPT subscription endpoint.

Run `bun install` in the package first if loading from the checkout. The package exposes `.` and `./tui` as the same hybrid entrypoint; `tui/index.ts` lets the V2 directory loader discover it (the loader looks for `tui/index`, not just package exports). Register the CLI entry in `cli.json`, and register only the optional quota server entry in `opencode.json(c)`. CLI settings are global, not project-local. Restart OpenCode after installing or editing the plugin.

### OpenCode V1 (legacy TUI configuration)

For OpenCode **1.18.29 or newer**, register the hybrid file in V1 `~/.config/opencode/tui.json` (or another V1-supported TUI configuration location):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["/absolute/path/to/opencode-token-usage/tui/token-usage.tsx", { "order": 110, "showCost": true }]
  ]
}
```

See [`examples/tui.json`](examples/tui.json) (V1) and [`examples/cli.json`](examples/cli.json) (V2). Install package dependencies with `bun install` when loading from a checkout and restart the TUI. V1's object-style plugin entrypoint requires 1.18.29+; older V1 releases are not claimed as supported. Do **not** replace an existing V1 `tui.json` with V2 `cli.json`: each host reads its own configuration.

The default `.` / `./tui` entrypoint has `id`, V1 `tui(api, options, meta)`, and V2 `setup(ctx)`. It checks the host's `api.app.version` / `ctx.app.version` and dynamically imports only that version's implementation; unknown, absent, or mismatched versions error instead of guessing. Explicit exports `./v1` and `./v2` are available for version-specific imports.

## Configuration

Options go under `plugins[].options` in V2 `cli.json` or the tuple's options object in V1 `tui.json`:

| Option           | Type      | Default | Description                                                                 |
| ---------------- | --------- | ------- | --------------------------------------------------------------------------- |
| `enabled`        | `boolean` | `true`  | Set `false` to disable the plugin without removing it from `cli.json`.      |
| `startCollapsed` | `boolean` | `false` | Start with the section collapsed.                                           |
| `showCost`       | `boolean` | `false` | Show cumulative session cost (USD) when non-zero.                           |
| `showCache`      | `boolean` | `true`  | Show cache read/write tokens when non-zero.                                 |
| `showReasoning`  | `boolean` | `true`  | Show reasoning tokens when non-zero.                                        |
| `showQuota`      | `boolean` | `true`  | Fetch and display subscription quota. OpenAI V2 requires the companion server plugin. Set `false` to skip quota credential reads and requests. |
| `order`          | `number`  | `110`   | **V1 only:** numeric sidebar slot order (minimum 1, floored). V2 uses plugin placement order. |

## Quota

In V1, quota appears under the token totals when the session model's provider is
`openai` or `opencode-go`; if no session provider exists, the V1 prompt model is used.
V1's `order` positions the section; V1 quota uses legacy local credentials without V2 connection checks or warning.

In V2, quota appears under the token totals when the current model's provider is
`openai` or `opencode-go`. For an OpenAI V2 connection, the CLI asks the companion
server plugin for quota for the **active OAuth account**; the credential and
authenticated request remain on the connected server (also when using a remote
server). Without that plugin, or when a V2 request fails, the UI shows
`Quota unavailable for V2 sign-in`. The same status appears for OpenCode Go V2
connections and for failed connection-metadata lookups. The CLI does not use a
possibly unrelated local legacy token when a V2 connection is reported.
Connection metadata does not identify the active connection, so this hides
legacy quota even if the reported connection is not selected.
Legacy quota is explicitly labeled and warns `Account may differ from V2`:
local Codex/OpenCode files and environment variables do **not** establish the
active OpenCode V2 account. Avoid using these bars to infer your current V2
account or its remaining allowance. Set `showQuota: false` to hide both quota
and the unavailable status.
The V2 cached session model takes precedence. If it has no provider ID, the
plugin uses the last model-switch event in **that session's** cached messages.
An unsupported session provider never inherits quota from the event.

### ChatGPT / Codex (OpenAI)

Credentials are read from `${CODEX_HOME}/auth.json` (or `~/.codex/auth.json`
when `CODEX_HOME` is unset or empty) when it contains ChatGPT
(`auth_mode: "chatgpt"`) tokens, falling back to the `openai` entry in
OpenCode's `auth.json`. The plugin calls the ChatGPT usage endpoint with a
`codex-cli` user agent and shows up to two windows (primary and secondary),
labeled `5h` / `Daily` / `Weekly` / `Monthly` from the window length.
OpenCode authentication is read from `${XDG_DATA_HOME}/opencode/auth.json`,
defaulting to `~/.local/share/opencode/auth.json`.

Malformed credentials and whitespace-bearing tokens are rejected. OpenCode's
explicit expiration and readable positive JWT expiration claims must be more
than 60 seconds away. The plugin does not refresh tokens or modify authentication
files; without a usable credential it omits quota.

### OpenCode Go

The API key is read from the `opencode-go` entry in OpenCode's `auth.json`, or
`OPENCODE_API_KEY` as a fallback. The plugin calls the OpenCode Zen usage
endpoint and shows the `5h` (rolling), `Weekly`, and `Monthly` windows.

Quota is refreshed every 2 minutes (6 minutes after a failed fetch); requests
time out after 10 seconds, and expired windows are hidden immediately.
Switching providers clears old quota and aborts outstanding requests; unmounting
the sidebar also aborts requests and stops polling. Authenticated requests reject
redirects. Failed requests hide quota while session token totals remain visible.

## Development

Requires [Bun](https://bun.sh). Install dependencies and run the regression
suite:

```sh
bun install
bun test        # helper and rendered-sidebar regression tests
bun run typecheck
```

Each version's pure helpers (`resolveOptions`, `summarize`, `formatTokens`, `fmtDuration`,
`jwtExpiry`, `codexCredentials`, `opencodeCredentials`, `parseWhamWindow`,
`goApiKey`, `parseGoUsage`)
are exported from its `./v1` or `./v2` module for testing (not the hybrid entrypoint).

The tests use temporary credential directories and mocked HTTP requests.
[TDD.md](TDD.md) and [TEST-REPORT.md](TEST-REPORT.md) record the historical V1
design and verification; current hybrid, V1 and V2 regressions live in `test/`.

## Caveats

- The ChatGPT usage endpoint is not a public API and may change without notice.
- Without usable quota credentials the quota section is omitted; token usage
  still works. With a V2 connection (or failed connection lookup), legacy quota
  is not used even if legacy credentials are present.
- V2's `sidebar.content` slot supports append, not V1's numeric `order` option.
  V1 `order` remains supported in V1 only; V2 placement follows plugin order.

## License

GPL-2.0-only. See [LICENSE](LICENSE).
