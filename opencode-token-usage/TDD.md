# Token Usage Plugin — Technical Design Document

> Historical V1 design (before the OpenCode V2 CLI migration). The V1 implementation
> is restored as `tui/token-usage-v1.tsx`, alongside V2's `tui/token-usage-v2.tsx`.
> `tui/index.ts` exposes the lazy `tui/token-usage.tsx` dispatcher to V2's directory
> loader. V1 `order` and
> prompt-model fallback apply only in V1; V2 uses `data.session` caches and
> `sidebar.content`. The counts and handoff below remain historical.

## 1. Status and handoff

- Scope: a focused improvement pass on `tui/token-usage.tsx`.
- Implementation: initial edits are present in the working tree and must be
  preserved. This document defines their intended behavior for independent
  regression testing.
- Validation completed: the testing subagent reports 71 passing tests, a passing
  strict TypeScript check, and a clean whitespace check. See `TEST-REPORT.md`
  for exact test mappings and verification limitations.
- Requested testing owner: GPT Luna Max. The current orchestration interface
  cannot select a subagent model; the configured testing subagent can perform
  the verification below.
- Record actual commands, results, and requirement-to-test mappings in
  `TEST-REPORT.md`. Report production defects instead of weakening assertions
  to make the current implementation pass.

## 2. Context

The plugin is distributed as a single TSX file copied into an OpenCode TUI
plugin directory. It renders session token totals and optionally queries
subscription quota for OpenAI/ChatGPT and OpenCode Go.

Existing stack:

- Bun tests, TypeScript strict checking, Solid reactive components.
- OpenTUI's test renderer in `test/render.test.tsx`.
- Pure-helper tests in `test/token-usage.test.ts`.
- Success polling interval: 120 seconds; unsuccessful polling: 360 seconds.
- Request timeout: 10 seconds; display clock: 1 second.

The credential review preceding this work found no apparent real secrets in
project files. The following changes harden runtime handling; they do not
remediate a confirmed credential leak.

## 3. Problems identified by source review

1. `modelProvider` searches both session and prompt models for any supported
   provider. An unsupported session provider can incorrectly inherit OpenAI
   quota from the prompt model.
2. Switching between supported providers does not immediately clear previous
   quota windows. Old percentages can appear under the new provider's title.
3. Effect cleanup suppresses late results but does not abort the HTTP request.
4. Quota fetching cannot be disabled independently of the token display.
5. Direct reads of token fields can throw on incomplete messages or propagate
   invalid numeric values into totals.
6. Formatting near a unit boundary can produce `1000K`; billions use a large
   `M` value rather than a compact `B` suffix.
7. OpenCode credential parsing trusts asserted JSON types and applies a
   different expiration rule than Codex parsing. `CODEX_HOME` is ignored.
8. A positive fractional slot order below one resolves to zero. Reset timestamp
   arithmetic can overflow even when its input is finite.

## 4. Design

### 4.1 Provider selection and quota opt-out

Add `showQuota?: boolean` to public options and `showQuota: boolean` to resolved
options. Default to `true`; only explicit `false` disables quota.

Provider selection:

1. Use the session model's `providerID` when present.
2. Only when that ID is nullish, use the optional prompt model API.
3. Return a quota provider only for `openai` or `opencode-go`.

An unsupported session provider is authoritative: it must not fall back to a
supported prompt provider. Stock OpenCode without `api.model.current()` remains
supported. Continue the existing one-second clock so nonreactive provider
updates can still be detected.

With `showQuota: false`, render normal token/cost details but do not invoke
quota credential loading or issue quota requests.

### 4.2 Request lifecycle and stale data

Each provider effect owns one abort controller, cancellation flag, and polling
timer. Clear quota immediately when the effect starts, before fetching for a
new provider. On cleanup:

- Set the cancellation flag.
- Abort the effect's controller.
- Clear the pending poll timer.

Both quota fetch functions accept the controller's signal. After asynchronous
credential reads, check cancellation before starting a request. Combine that
signal with the existing 10-second timeout signal. Retain the cancellation
flag check after awaiting the request: a mock or transport that ignores abort
must still be unable to publish stale results or schedule another poll.

Set `redirect: "error"` on authenticated requests so these calls remain
restricted to their configured HTTPS endpoints:

- `https://chatgpt.com/backend-api/wham/usage`
- `https://opencode.ai/zen/go/v1/usage`

Preserve the existing success/failure polling intervals and failure behavior:
HTTP errors, invalid response bodies, timeouts, and transport failures hide
quota while session usage continues rendering. Do not add automatic login,
token refresh, credential writes, or sensitive diagnostics.

### 4.3 Credential parsing

Keep credential parsing separate from filesystem access. Export the new pure
`opencodeCredentials(raw, now)` helper alongside the existing testable helpers.

Credential strings must be nonempty strings without whitespace. Reject invalid
tokens; omit an invalid optional account ID. Do not coerce objects or numbers
into authorization values.

OpenAI credential source order:

1. `${CODEX_HOME}/auth.json` when `CODEX_HOME` is nonempty; otherwise
   `~/.codex/auth.json`. Require Codex `auth_mode: "chatgpt"`.
2. OpenCode's `openai` entry in `${XDG_DATA_HOME}/opencode/auth.json`, using the
   existing `~/.local/share/opencode` fallback when XDG data home is unset.

For OpenCode credentials, allow `type: "oauth"` or an absent type for existing
legacy fixtures. Reject an explicitly different type. If `expires` is present,
require a finite number in milliseconds greater than `now + 60_000`. Reject
zero, negative, expired, malformed, and near-expiry values. If a token carries
a readable positive JWT expiration in seconds, apply the same margin to it.
An opaque token with no readable JWT expiration remains accepted when the
other checks pass. JWT payload decoding is expiration inspection, not signature
verification. `jwtExpiry` returns zero for missing, invalid, or nonfinite claims.

For OpenCode Go, prefer a valid `opencode-go.key`; otherwise use a valid
`OPENCODE_API_KEY`. Preserve the separation from the ordinary `opencode` key.
Malformed files and entries must return no credential or the documented
fallback, without throwing.

### 4.4 Totals, formatting, and input boundaries

- Count assistant messages as requests using the existing semantics, including
  an incomplete assistant message. Ignore user messages.
- Sum each finite nonnegative numeric token/cost field independently. Missing,
  string-valued, negative, `NaN`, and infinite fields contribute zero. A bad
  field must not discard valid fields on the same message.
- Preserve existing output for ordinary token values, support `B`, and promote
  rounded unit boundaries: `999_950` becomes `1M`, `999_950_000` becomes `1B`,
  and `1_200_000_000` becomes `1.2B`. Below 1,000, keep integer truncation.
- Slot orders must be finite and at least one before flooring; otherwise use
  110. Existing positive orders such as 300 remain valid.
- `parseWhamWindow` must reject a nonfinite computed reset timestamp, including
  overflow from a finite input. Retain percent clamping and existing labels.

## 5. Acceptance criteria and regression plan

The testing subagent should map every ID below to exact test names in its
report. Parameterize equivalent input cases where that improves clarity.

| ID | Required observable behavior | Preferred test layer |
| --- | --- | --- |
| Q1 | Supported session provider beats a different prompt provider; unsupported session provider never uses prompt quota; a missing session provider may fall back to prompt. | Renderer with captured requests |
| Q2 | Switching supported providers clears old quota before the new response resolves; a late old response cannot replace the new provider's quota. | Renderer with deferred responses |
| Q3 | Switching providers or unmounting aborts an in-flight request and prevents later updates or polling; successful and failed requests still use 120s/360s scheduling. | Controlled signals and poll timers |
| Q4 | `showQuota` defaults to true; explicit false preserves token details and produces no quota request or credential read. | Options plus renderer/I/O observation |
| C1 | Both credential parsers reject malformed entries and whitespace-bearing tokens; valid opaque tokens and valid optional account IDs retain exact values. | Pure helpers |
| C2 | OpenCode expiration margin boundaries, wrong auth type, malformed expires, and JWT expiry fallback follow section 4.3. | Pure helpers with fixed `now` |
| C3 | A temporary `CODEX_HOME` credential takes precedence; absent/unusable Codex auth falls back to isolated XDG OpenCode auth. Go key fallback uses only a valid environment value. | Isolated credential integration plus helpers |
| C4 | Both providers send expected authorization headers only to their endpoint, reject redirects, have a timeout signal, and fail gracefully on HTTP/JSON/transport errors. | Captured request options and controlled responses |
| U1 | Mixed valid/incomplete/invalid assistant messages yield exact finite totals; invalid fields do not erase valid contributions. | Pure helpers |
| U2 | Ordinary values, invalid values, billion formatting, and rounded K/M/B boundaries produce exact expected strings. | Pure helpers |
| U3 | Fractional order below one falls back to 110; valid order is floored; nonfinite reset arithmetic is rejected. | Pure helpers |
| R1 | Existing collapse, cost/cache/reasoning toggles, quota expiry, provider discovery, and disabled-plugin behavior remain covered and passing. | Existing plugin suite |

### Test isolation requirements

- Use only synthetic credentials and mocked network responses.
- Set both `CODEX_HOME` and `XDG_DATA_HOME` to temporary directories. Isolate
  `OPENCODE_API_KEY` as well, restoring its original presence/value afterward.
  Existing renderer tests currently isolate XDG but can still read real Codex
  credentials; fix this in the harness.
- Observe request URLs, headers, redirect policy, and signals without making
  actual external requests. Support deferred responses and explicit HTTP errors
  in the harness rather than always returning a successful JSON response.
- For provider transitions, use a reactive test provider or controlled clock;
  assert state before and after resolving deferred responses.
- Drive long polling/timeout checks with scoped clock/scheduler controls rather
  than waiting two or six minutes. Avoid interfering with OpenTUI's own timers.
- Restore replaced globals and dispose mounted views on success and failure.
- Do not add dependencies or split the distributable TSX file merely to test it.

## 6. Files and ownership

| File | Work |
| --- | --- |
| `tui/token-usage.tsx` | Preserve current implementation edits; report defects for targeted fixes. |
| `test/token-usage.test.ts` | Extend pure-function regression coverage and resolved option expectations. |
| `test/render.test.tsx` | Improve isolation and verify lifecycle, provider changes, requests, and UI. |
| `README.md` | Document `showQuota`, provider precedence, `CODEX_HOME`, expiration behavior, cancellation, and redirects. |
| `TDD.md` | Design and acceptance contract. |
| `TEST-REPORT.md` | Actual commands, passing/failing totals, acceptance-ID-to-test map, limitations. |

Keep dependencies and package versions unchanged. Broader features such as new
quota providers, manual refresh controls, shared cross-session quota caches, and
usage history are deferred.

## 7. Verification and completion

Run from `opencode-token-usage/`:

```sh
bun test test/token-usage.test.ts
bun test test/render.test.tsx
bun run typecheck
bun test
```

Also run `git diff --check` from the repository root. A final passing full-plugin
test run and typecheck are required. If a production defect is found, preserve
its regression test and describe the failing behavior before a targeted fix.

Finish by reviewing assertions against all acceptance IDs and documenting any
remaining limitation rather than implying coverage from test counts alone.
For installation, the user must copy the updated TSX file if using the local-file
installation and quit/restart OpenCode to load the changed plugin.

## 8. Testing handoff prompt

> Test the existing token-usage improvements against
> `opencode-token-usage/TDD.md`. Preserve the implementation edits. Extend the
> existing tests and their harness for every acceptance ID, isolate credentials
> and network access, and run the listed commands. Write
> `opencode-token-usage/TEST-REPORT.md` with exact test names and actual results.
> Report production defects rather than weakening the expected behavior. Do not
> commit, revert source changes, modify other plugins, or change dependencies.
