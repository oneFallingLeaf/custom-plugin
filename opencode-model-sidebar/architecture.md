# Architecture

`opencode-model-sidebar` is a single-file OpenCode **TUI plugin**
(`tui/model-sidebar.tsx`) that adds a searchable, clickable model list to the
session sidebar, directly below the built-in LSP / todo / files sections. This
document describes how it is wired into the host, the interaction contract, the
test strategy, and the session history that produced the current behavior.

## Agent change guide

Read this document before changing the plugin. The module is intentionally
small, but it has a few UI behaviors that have regressed before.

| If changing... | Start with... | Also update / run... |
| --- | --- | --- |
| Plugin behavior or rendering | `tui/model-sidebar.tsx` | Add or adjust the rendered regression test in `test/model-sidebar.test.tsx`; preserve the invariants in section 8. |
| Filtering, ordering, or option defaults | `collect()` or `resolveOptions()` | `test/collect.test.ts`; update `README.md` if user-visible behavior changes. |
| Keyboard or mouse behavior | `View` and section 5 | Test the exact interaction with the OpenTUI test renderer. Do not replace a regression test with a helper-only test. |
| Model-switch semantics | `choose()` and `patches/opencode-model-api.patch` | Keep the patched, session-only, and native-dialog paths distinct. Update README and this document. |
| Patched OpenCode version or build | `scripts/opencode-patched.version`, wrapper, and patch | Verify the patch against the pinned upstream tag before changing the pin. |
| Plugin configuration or packaging | `examples/tui.json`, `package.json`, or `README.md` | Keep example defaults, documented defaults, and `resolveOptions()` synchronized. |

Before submitting a change, run:

```sh
bun test
bun run typecheck
```

Do not modify the host patch only to avoid testing a plugin behavior. The patch
is a narrowly-scoped capability bridge; plugin behavior must continue to work
on stock OpenCode through the documented fallback.

## 1. Host integration

The plugin is loaded by path from `~/.config/opencode/tui.json` and receives a
`TuiPluginApi`. The entry point is `tui()` at `tui/model-sidebar.tsx:544`:

```
opencode TUI
   │  loads tui.json → tui/model-sidebar.tsx
   ▼
tui(api, options)
   ├─ resolveOptions()                       (model-sidebar.tsx:66)
   ├─ api.command.register("model.sidebar.focus", keybind)   (focus the search)
   ├─ api.lifecycle.onDispose(cleanup)
   └─ api.slots.register({ order: 600, slots: { sidebar_content } })
                                                   (model-sidebar.tsx:561)
                                                        │
                                                        ▼
                                            <View api sessionID maxRows switchMode/>
```

- **Slot** — `sidebar_content` with `order: 600`. Built-ins are context `100`,
  mcp `200`, lsp `300`, todo `400`, files `500`, so `600` sits at the bottom.
- **Command** — `model.sidebar.focus` (default keybind `ctrl+shift+m`) calls the
  `focus` callback that `View` publishes via `props.onReady`.
- **Data in** — `api.state.provider` (`Provider[]` with a `models` map) and
  `api.state.session.get(sessionID)?.model`.
- **Data out (switching a model)** — `choose()` at `model-sidebar.tsx:270`, in
  priority order:
  1. `api.model.set(...)` — the TUI-local model. Only present on opencode builds
     carrying `patches/opencode-model-api.patch`. This is the true one-click
     switch that typed prompts use.
  2. `api.client.v2.session.switchModel(...)` — only when the `switchMode`
     option is `"session"`; switches the server-side session model but **not**
     the TUI-local model.
  3. `api.keymap.dispatchCommand("model.list")` — stock fallback; opens the
     native picker, the only reliable switch there.

## 2. Module structure

```
opencode-model-sidebar/
├── tui/model-sidebar.tsx      # the whole plugin (collect, View, tui)
├── patches/opencode-model-api.patch  # adds api.model to the host
├── scripts/
│   ├── opencode-patched       # builds/caches and runs a patched host binary
│   └── opencode-patched.version # upstream host version targeted by the patch
├── examples/tui.json
├── test/
│   ├── model-sidebar.test.tsx # rendered integration + mouse/keyboard
│   └── collect.test.ts        # pure collect()/resolveOptions()
├── bunfig.toml                # preloads @opentui/solid transform for bun test
├── tsconfig.json               # strict, no-emit TypeScript check
├── package.json                # package metadata, scripts, and peer dependency
└── architecture.md            # this file
```

`model-sidebar.tsx` has three layers:

| Layer | Symbols | Pure? |
| --- | --- | --- |
| Options | `Options`, `Resolved`, `resolveOptions` (`:66`) | yes |
| Data | `ModelItem`, `collect` (`:76`) | yes |
| UI | `View` (`:106`) | no (Solid effects + host api) |
| Entry | `tui` (`:544`), default `plugin` | no |

`collect()` and `resolveOptions()` are exported for unit tests; the default
export is the plugin.

## 3. `View` state and data flow

```
signals                         memos                         derived from
─────────                       ─────                         ────────────
open        (section expanded)  all       = collect(api,"")   api.state.provider
tab         (favorites / all)    favorites = api.model.favorite api.model
filtering   (keyboard captured) filtered  = collect(api,q)    query
query       (search text)       current   = api.model.current?
cursor      (selected index)               ?? session.model
windowStart (first visible idx) clamped   = clamp(cursor)      filtered
                                windowRows= slice(windowStart)  maxRows, filtered
imperative:                     moveCursor / page (below)
editor      (prompt to restore)
pointer     (OSC 22 style)
lastClick   (double-click timer)
```

Render pipeline:

```
api.state.provider ─► collect() ─► filtered() ─► windowRows() ─┬─► <For> rows
                                       ▲            ▲           │
                              query() + tab()   windowStart     │
                                                               │
     keyboard nav ─► moveCursor(index) ─┐                      │
     more buttons ─► page(±1) ──────────┴─► windowStart ───────┘
     click ────────► moveCursor(index) ──► cursor (highlight)
     double click ─► choose()
```

- `moveCursor()` (`:195`) is the only way the selection moves. It keeps
  `windowStart` pinned and shifts it **only** when the requested index would
  fall outside `[windowStart, windowStart + maxRows)`.
- `page(±1)` (`:207`) scrolls `windowStart` by a whole page and keeps the cursor
  inside the new window.
- `windowRows()` (`:187`) slices `[windowStart, windowStart + maxRows)` and is a
  pure function of `filtered()`, `maxRows`, and `windowStart`; it does **not**
  follow the cursor. This is what keeps the list still when a row is clicked.
- `createEffect` (`:170`) resets the OSC 22 pointer, clears `lastClick`, and
  pins `windowStart` back to `0` whenever `filtered()` changes, because
  filtering destroys and rebuilds rows.

## 4. Interaction contract (do not regress)

| Input | Effect |
| --- | --- |
| Hover a row | Sets the OSC 22 pointer to `pointer`. **Must not** move the selection or re-slice the window. |
| Hover the search box | Pointer `text`. |
| Leave rows/box | Pointer `default`. |
| Single click a row | `moveCursor(row())` — highlight only. **Must not scroll.** |
| Double click a row | `clickRow()` (`:262`): same row within `DOUBLE_CLICK_MS` (400 ms) → `choose()`. |
| Click `▲/▼ N more` | `page(±1)` — scrolls one page. |
| Click `Favorites` / `All` | Switches the visible list; search applies within the selected tab. |
| `enter` (while searching) | `choose(filtered()[clamped()])`. |
| `up`/`down`, `ctrl+p`/`ctrl+n` | Move cursor; scrolls only at the window edges. |
| `pageup`/`pagedown`, `home`/`end` | Page / jump. |
| Printable keys / `backspace`, `ctrl+u` | Edit / clear the query (resets to top). |
| `escape` | Leave search, restore prompt focus. |
| Click `Models` header | Expand/collapse the section. |

Long model/provider names render with `wrapMode="none"` and `flexShrink`, so a
row is always exactly one line and rows never shift or misalign.

Why hover must not move the selection: moving the cursor changes `windowStart`,
which slides the window under the pointer. The next render re-hovers the
*shifted* rows, producing a scroll/jump loop — the "auto expand on hover"
regression. Why click must not re-centre: the same recentring shifted the whole
list by a line when `▲ N more` appeared, which looked like the text wrapping and
misaligning.

opentui's `MouseEvent` exposes no click count, so `clickRow` implements
double-click detection itself with `lastClick`.

## 5. Tests

Run with [Bun](https://bun.sh):

```sh
bun install
bun test          # 18 tests
bun run typecheck
```

The integration suite (`test/model-sidebar.test.tsx`) mounts the **real** plugin
through `tui()` into an opentui test renderer and drives it with the mock mouse
and keyboard (`@opentui/core/testing`), then asserts on `captureCharFrame()`
text. `bunfig.toml` preloads `@opentui/solid/preload` so the Solid JSX transform
is the client build.

Covered regressions:

- hovering a row does not move the selection or scroll the window;
- clicking a row keeps the list perfectly still (no re-centring);
- navigation scrolls only when the selection leaves the visible window;
- long names do not wrap; rows stay one line and aligned;
- single click highlights but does not switch; double click switches;
- two quick clicks on different rows do not switch;
- clicking `▲/▼ N more` pages the window;
- the OSC 22 pointer is set on hover and restored on leave;
- `collect()` filtering/sorting and `resolveOptions()` defaults.

The hover/auto-scroll and fixed-window tests were each verified to fail against
the buggy behavior before being accepted.

## 6. Session trace

Reconstructed from the opencode session databases
(`~/.local/share/opencode/{opencode,opencode-main}.db`, `session`/`message`/`part`
tables). Times are local (UTC+8).

| Time | Session | Request | Outcome |
| --- | --- | --- | --- |
| 06:09 | `ses_f5e08375cffe5E57CasCrf5nXH` | "edit opencode to show models on the right side below LSP — search box + model list" | Researched TUI slots; created the plugin, the `api.model` patch, `opencode-patched`, and the repo (commit `180b679`). |
| 06:51 | `ses_f5de16da5ffepMBJo245hJ80tr` | left-arrow Copilot sessions plugin | Sibling plugin (`opencode-copilot-sessions`), unrelated to this one. |
| 06:57 | `ses_f5ddbdc86ffeeY6HU1a6ppk1mP` | "it should not expand the more on hover it needs to be click" + search caret + prompt not typeable | **Removed** row `onMouseOver` cursor movement, made `▲/▼ N more` clickable, fixed the caret, added the `focused_editor` release. This is the original "click, don't hover" contract. |
| 07:11 | `ses_f5dcfc77affeGQIeAuEL6wevXa` | "pressing a model opens the popup instead of switching" | Confirmed stock fallback; installed the patched binary via the `opencode-patched` wrapper + cache. |
| 19:52 | `ses_f5b16c7d3ffeOwnuHL3FT0ctJ2` | "mouse pointer doesn't change after search" | Re-added OSC 22 pointer styles **and** hover-moves-selection (mirroring native `DialogSelect`) → reintroduced the auto-scroll on hover. |
| 22:31 | `ses_f5a8524feffeDsvrIKPzQuUWOv` | "double click when setting model, click just highlight" | Changed row mouse-up to `clickRow` (click = highlight, double = switch). |
| 22:31 | `ses_f5a8524feffeDsvrIKPzQuUWOv` | "now it auto expand … it needed to be click to expand the more text" | **Removed** hover-moves-selection again while keeping the OSC 22 pointer and double-click; added the regression suite and this document. |
| 22:51 | `ses_f5a8524feffeDsvrIKPzQuUWOv` | "click should not move the scroll … the text will misalign … it wraps the text" | **Pinned the window** to `windowStart` (no re-centring on click; scroll only when the selection leaves view / pages), added `wrapMode="none"` + `flexShrink` so rows stay one line, and added tests for both. |

Lesson recorded here so it does not regress a third time:

- The OSC 22 **pointer** (hover cosmetic) and **selection-follows-hover** are
  independent. The native `DialogSelect` couples them; this sidebar must not.
- Any handler that changes `cursor` on hover will slide `windowStart` and
  re-trigger hover on the shifted rows.
- `windowRows()` must not derive its offset from `cursor`; recentring moves the
  whole list (and the `▲ N more` line appears/disappears), which looks like the
  text wrapping/misaligning.

## 8. Invariants

1. Only intentional actions (`click`, `enter`, keyboard navigation, `more`
   clicks) may change `cursor`. Hover is pointer-only.
2. `windowRows()` is a pure function of `filtered()` + `maxRows` +
   `windowStart()`; it never follows the cursor and never mutates state.
3. A click never changes `windowStart`; `moveCursor` shifts it only when the
   selection would leave `[windowStart, windowStart + maxRows)`.
4. Row text uses `wrapMode="none"` so every row is exactly one line.
5. Switching side effects live in `choose()` and degrade gracefully:
   `api.model.set` → `session.switchModel` → native `model.list` dialog.
6. `createEffect` clears per-list state (`pointer`, `lastClick`, `windowStart`)
   whenever `filtered()` changes.
