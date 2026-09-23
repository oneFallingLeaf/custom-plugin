# Token Usage Plugin — Verification Report

> Historical V1 verification only. This report predates the V2 migration and its
> counts, dependencies, and changed-file statements do not describe the current
> tree. Current V2 checks/results are in the migration handoff, not this report.

Verification of the working-tree `tui/token-usage.tsx` implementation against
`TDD.md`. This pass preserved the existing implementation and test edits, fixed
test/harness defects only, and did not weaken any expected behavior.

- Production source modified in this pass: **no**.
- `TDD.md`, `README.md`, dependencies, lockfiles: **not modified**.
- Other plugins: **not touched**. No commits, reverts, or stashes.

## 1. Commands and results

Run from `opencode-token-usage/` unless noted.

| # | Command | Result |
| --- | --- | --- |
| 1 | `bun test test/token-usage.test.ts` | 37 pass, 0 fail, 133 expect() calls |
| 2 | `bun test test/render.test.tsx` | 34 pass, 0 fail, 117 expect() calls |
| 3 | `bun test` (full plugin suite) | 71 pass, 0 fail, 250 expect() calls, 2 files |
| 4 | `bun run typecheck` (`tsc --noEmit`) | exit 0, no diagnostics |
| 5 | `git diff --check` (repo root) | clean, exit 0 (no whitespace/conflict errors) |

Bun version: `1.4.0`. Typecheck uses the repo's strict `tsconfig.json`.

## 2. Changes made during this verification pass

Both changes are confined to owned files (`test/*`) and correct test/harness
defects; no assertion was weakened to make the implementation pass.

1. `test/render.test.tsx` — the prior harness exposed `fetchCalls` as a getter
   that returned a fresh `requests.map(...)` snapshot. Tests that destructured
   `fetchCalls` before mounting captured an empty array, so three pre-existing
   regression tests failed even though requests had been issued. Replaced the
   getter with a stable live `fetchCalls: string[]` array populated alongside
   `requests` in the `fetch` mock. This restored the three baselines and does not
   change any assertion.
2. `test/render.test.tsx` — the two provider-transition tests
   (`clears previous quota immediately when switching supported providers`,
   `a late response from the previous provider cannot replace the current quota`)
   switched to `opencode-go` without supplying any Go credential, so
   `fetchGoQuota` correctly returned `null` before issuing a request and
   `waitUntil(requests.length === 2)` could never succeed. Added a synthetic
   `auth: { "opencode-go": { key: "sk-go" } }` fixture to each. This was a test
   setup omission, not a production defect.

## 3. Acceptance-ID to test map

Exact test names. Unless noted, the file is `test/render.test.tsx`;
`test/token-usage.test.ts` marks the pure-helper file.

### Q1 — Provider selection precedence

- `a supported session provider takes precedence over a different prompt provider` (render)
- `an unsupported session provider never inherits a supported prompt provider's quota` (render)
- `a missing session provider falls back to the prompt provider` (render)
- Supporting regression: `uses the session model when the prompt model is a different provider` (render)

### Q2 — Stale quota and provider switching

- `clears previous quota immediately when switching supported providers` (render, deferred response)
- `a late response from the previous provider cannot replace the current quota` (render, deferred response; also asserts the old request signal is aborted)

### Q3 — Cancellation, unmount and poll schedule

- `switching providers aborts the in-flight request and prevents later polling` (render, controlled signals)
- `unmounting aborts the in-flight request and prevents later updates` (render, controlled signals)
- `successful quota polling schedules the next poll at 120 seconds` (render, captured timers)
- `failed quota polling schedules the next poll at 360 seconds` (render, captured timers)

### Q4 — Quota opt-out

- `resolveOptions defaults showQuota to true and honors explicit false` (pure)
- `showQuota false preserves token details and makes no quota request` (render)
- Supporting: `resolveOptions applies defaults` and `resolveOptions honors overrides and rejects bad values` (pure)

### C1 — Credential parsing and value preservation

- `codexCredentials rejects whitespace, empty and non-string tokens` (pure)
- `codexCredentials accepts opaque tokens and omits invalid account ids` (pure)
- `codexCredentials returns a fresh ChatGPT token` (pure)
- `codexCredentials rejects expired and non-oauth auth` (pure)
- `opencodeCredentials accepts oauth and legacy entries with exact values` (pure)
- `opencodeCredentials rejects wrong types, whitespace tokens and malformed expires` (pure)
- `opencodeCredentials omits invalid optional account ids` (pure)
- `jwtExpiry reads exp and tolerates junk` (pure)
- `jwtExpiry returns zero for missing or nonfinite exp claims` (pure)

### C2 — Expiration margin, auth type and JWT fallback

- `opencodeCredentials enforces the expiry margin and JWT fallback` (pure, fixed `now`)
- `opencodeCredentials rejects wrong types, whitespace tokens and malformed expires` (pure, fixed `now`)
- `codexCredentials enforces the JWT expiration margin` (pure, exclusive at `now + 60_000`)

### C3 — Credential source precedence (isolated filesystem)

- `a CODEX_HOME credential takes precedence over OpenCode auth` (render, isolated `CODEX_HOME`/XDG)
- `falls back to isolated OpenCode auth when Codex auth is absent` (render)
- `falls back to isolated OpenCode auth when Codex auth is unusable` (render, `auth_mode: "apikey"`)
- `falls back to OPENCODE_API_KEY for Go when no file key exists` (render, isolated env key)
- `a valid file Go key takes precedence over OPENCODE_API_KEY` (render)
- `an invalid environment Go key produces no request` (render)
- Supporting pure: `goApiKey reads the opencode-go auth entry`,
  `goApiKey falls back to OPENCODE_API_KEY and rejects missing keys`,
  `goApiKey prefers a valid file key and rejects whitespace keys`

### C4 — Request shape and graceful failures

- `OpenAI requests use the expected endpoint, headers, redirect policy and timeout signal` (render)
- `OpenCode Go requests use the expected endpoint, headers, redirect policy and timeout signal` (render)
- `HTTP errors hide quota while token totals keep rendering` (render)
- `invalid JSON responses hide quota while token totals keep rendering` (render)
- `transport failures hide quota while token totals keep rendering` (render)
- Supporting: `shows ChatGPT quota for openai sessions`, `shows OpenCode Go quota for opencode-go sessions` (render)

### U1 — Totals and input boundaries

- `summarize tolerates incomplete assistant messages and counts them` (pure)
- `summarize ignores invalid fields without discarding valid ones` (pure)
- `summarize returns exact finite totals across mixed messages` (pure)
- Supporting: `summarize returns zeros for no messages`,
  `summarize sums assistant tokens and counts requests`,
  `summarize ignores user messages and accumulates across turns` (pure)

### U2 — Formatting and rounded boundaries

- `formatTokens returns 0 for invalid values and truncates below one thousand` (pure)
- `formatTokens supports billions` (pure)
- `formatTokens promotes rounded K and M boundaries` (pure)
- Supporting: `formatTokens abbreviates thousands and millions` (pure)

### U3 — Slot order and reset arithmetic

- `resolveOptions floors valid slot orders and rejects orders below one` (pure)
- `parseWhamWindow rejects nonfinite reset arithmetic` (pure)
- Supporting: `resolveOptions honors overrides and rejects bad values`,
  `parseWhamWindow reads reset_at seconds`,
  `parseWhamWindow reads reset_after_seconds relative to now`,
  `parseWhamWindow clamps percent and rejects incomplete windows`,
  `parseWhamWindow labels windows from limit_window_seconds` (pure)

### R1 — Existing behavior remains covered and passing

- `registers a sidebar_content slot` (render)
- `renders the Usage header even with no messages` (render)
- `renders session totals, cache and reasoning from assistant messages` (render)
- `startCollapsed hides totals until the header is clicked` (render)
- `showCost displays the session cost` (render)
- `showCache and showReasoning can be turned off` (render)
- `hides quota windows whose reset time has passed` (render, quota expiry)
- `picks up a session provider that appears after mount` (render, provider discovery)
- `stays quota-free for providers without a subscription endpoint` (render)
- `enabled: false does not register the sidebar slot` (render, disabled-plugin)
- `parseGoUsage maps rolling, weekly and monthly windows`,
  `parseGoUsage clamps percent and skips invalid windows` (pure)
- `fmtDuration formats hours, minutes and days`,
  `dataDir follows OpenCode's XDG data directory` (pure)

## 4. Assertion review

Assertions were reviewed inline for behavior correctness:

- Q1/Q2 use captured request URLs/headers plus deferred `Response` objects, so
  they assert the actually-issued endpoint and the published UI state rather than
  only that a function was called.
- Q2's late-response test additionally asserts the superseded request signal is
  aborted and that the stale percentage never appears.
- Q3 verifies abort propagation and poll scheduling through a captured
  `setTimeout`/`AbortSignal.timeout` wrapper; it does not rely on wall-clock
  waits.
- C4 aborts the captured timeout controller and asserts the combined request
  signal becomes aborted, pinning the timeout wiring.
- U2's boundary cases (`999_950 → 1M`, `999_950_000 → 1B`) pin the promotion
  logic so a naive `toFixed` implementation would fail.

## 5. Test isolation

- `CODEX_HOME`, `XDG_DATA_HOME`, and `OPENCODE_API_KEY` are set to
  synthetic/isolated values for every renderer mount and restored afterwards, so
  no real user credential is read.
- All HTTP is served by a mocked `globalThis.fetch`; no external request is made.
- Globals (`fetch`, `setTimeout`, `AbortSignal.timeout`) are restored in
  `afterEach`; mounted renderers are destroyed on success and failure.
- Polling and timeout checks use controlled timer/signal capture instead of
  multi-minute waits.

## 6. Remaining limitations

1. `redirect: "error"` is asserted on the captured `RequestInit`; an actual
   HTTP 3xx redirect is not exercised because `fetch` is mocked.
2. `showQuota: false` avoidance of credential reads is demonstrated indirectly
   (no provider, no request) rather than by spying on `node:fs/promises`.
3. Timeout behavior is verified by aborting the captured timeout controller;
   the real 10-second expiry race is not waited out.
4. JWT handling inspects the `exp` claim only (no signature verification), by
   design.
5. No real network endpoints (ChatGPT/OpenCode Go) are contacted.

## 7. Production issues

No production defects were found in this pass. Every acceptance behavior in
`TDD.md` §5 was reproduced by the tests above. The five failures observed at the
start of this pass were caused by the test harness (`fetchCalls` snapshot) and
missing Go credentials in two new tests; both were fixed without changing
production code or weakening assertions.
