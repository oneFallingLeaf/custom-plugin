# opencode-token-usage

An [OpenCode](https://opencode.ai) TUI plugin that adds a **live per-session
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
- Quota bars for OpenAI/ChatGPT and OpenCode Go subscriptions, colored by usage
  (green under 50%, yellow from 50%, red above 85%), with time to reset.
- Resolved quota windows disappear once their reset time passes.

## Install

### As a local file plugin (recommended)

1. Copy the plugin into your global plugin directory:

   ```sh
   mkdir -p ~/.config/opencode/plugins/tui
   cp tui/token-usage.tsx ~/.config/opencode/plugins/tui/
   ```

2. Register it in `~/.config/opencode/tui.json`:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": [
       ["./plugins/tui/token-usage.tsx", { "order": 110, "showCost": true }]
     ]
   }
   ```

3. Restart OpenCode.

TUI plugins are **not** auto-discovered; they must be listed in `tui.json`.

### Directly from this repo

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/custom-plugin/opencode-token-usage/tui/token-usage.tsx"]
}
```

## Configuration

Options are the second element of the `tui.json` entry:

| Option           | Type      | Default | Description                                                                 |
| ---------------- | --------- | ------- | --------------------------------------------------------------------------- |
| `enabled`        | `boolean` | `true`  | Set `false` to disable the plugin without removing it from `tui.json`.      |
| `order`          | `number`  | `110`   | Sidebar slot order. The built-in Context block is `100`.                    |
| `startCollapsed` | `boolean` | `false` | Start with the section collapsed.                                           |
| `showCost`       | `boolean` | `false` | Show cumulative session cost (USD) when non-zero.                           |
| `showCache`      | `boolean` | `true`  | Show cache read/write tokens when non-zero.                                 |
| `showReasoning`  | `boolean` | `true`  | Show reasoning tokens when non-zero.                                        |

## Quota

Quota appears under the token totals when the current model's provider is
`openai` or `opencode-go`; otherwise only token usage is shown.

### ChatGPT / Codex (OpenAI)

Credentials are read from `~/.codex/auth.json` when it contains ChatGPT
(`auth_mode: "chatgpt"`) tokens, falling back to the `openai` entry in
OpenCode's `auth.json`. The plugin calls the ChatGPT usage endpoint with a
`codex-cli` user agent and shows up to two windows (primary and secondary),
labeled `5h` / `Daily` / `Weekly` / `Monthly` from the window length.

### OpenCode Go

The API key is read from the `opencode-go` entry in OpenCode's `auth.json`, or
`OPENCODE_API_KEY` as a fallback. The plugin calls the OpenCode Zen usage
endpoint and shows the `5h` (rolling), `Weekly`, and `Monthly` windows.

Quota is refreshed every 2 minutes (6 minutes after a failed fetch); requests
time out after 10 seconds, and expired windows are hidden immediately.

## Development

Requires [Bun](https://bun.sh). Install dependencies and run the regression
suite:

```sh
bun install
bun test        # 18 tests: option parsing, token math, credential and quota parsing
bun run typecheck
```

The pure helpers (`resolveOptions`, `summarize`, `formatTokens`, `fmtDuration`,
`jwtExpiry`, `codexCredentials`, `parseWhamWindow`, `goApiKey`, `parseGoUsage`)
are exported for testing.

## Caveats

- The ChatGPT usage endpoint is not a public API and may change without notice.
- Without usable credentials the quota section is simply omitted; token usage
  still works.
- On stock OpenCode the provider is taken from the session model; a build that
  exposes `api.model.current()` is preferred when available.

## License

GPL-2.0-only. See [LICENSE](LICENSE).
