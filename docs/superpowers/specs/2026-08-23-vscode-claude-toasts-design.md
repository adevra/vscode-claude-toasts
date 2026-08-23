# Design: vscode-claude-toasts

**Date:** 2026-08-23
**Status:** Approved for planning
**Scope:** v1 — two notification kinds, Windows-first, extension-managed global hooks

## Problem

Claude Code runs for minutes at a time in a VS Code terminal. While it works you switch
to a browser, another window, another project. Two moments matter, and both are invisible
unless you are staring at the panel:

1. Claude **finished** the turn.
2. Claude is **blocked on you** — a permission prompt, or it has gone idle waiting for input.

VS Code has no OS-notification API; `showInformationMessage` paints inside the window you
are already not looking at. Warp solves the adjacent problem by watching the terminal
stream and guessing when a command finished. We can do better: Claude Code emits typed
hook events, so we know which session, in which terminal, and why it wants you.

## Non-goals for v1

- macOS and Linux toasts. The notifier is an interface with one implementation; a second
  backend is a new file, not a refactor.
- Interactive toasts (approve or deny a permission from the desktop).
- Subagent, error, task-completed, and teammate-idle notifications.
- Remote workspaces (WSL, SSH, devcontainer, Codespaces) — see Limitations.
- Marketplace packaging.

## Architecture

```
Claude Code (in a VS Code terminal)
  |  fires hook, async: true  ->  no added latency
  v
hook.js  (~40 lines, zero deps, lives in globalStorage)
  |  reads stdin JSON, slims it, writes one NDJSON line
  |  address + token come from env vars injected into the terminal
  v
named pipe  \\.\pipe\claude-toasts-<random>          [one per VS Code window]
  v
HookServer --> SessionRegistry --> NotificationPolicy (pure) --> Notifier
                                         |                          |
                                    OutputChannel              SnoreToast
                                    (every decision                 |
                                     + reason logged)          click callback
                                                                    v
                                                       focus window + terminal.show()
```

The env var is the routing mechanism. A terminal in window A gets window A's pipe name, so
the event lands in the right window with no `cwd` guessing — which matters because two
windows may have the same folder open. A Claude session started outside VS Code has no env
var, so the hook exits 0 silently.

### Modules

| File | Responsibility | Depends on |
|---|---|---|
| `src/extension.ts` | activation, wiring, disposal | everything |
| `src/config.ts` | typed read of `claudeToasts.*` settings | vscode |
| `src/hookInstaller.ts` | reconcile our entries in `~/.claude/settings.json`; copy `hook.js` into globalStorage | node:fs |
| `src/hookServer.ts` | named-pipe server, token check, NDJSON framing, parse to `HookEvent` | node:net |
| `src/sessionRegistry.ts` | `session_id` to `{terminal, cwd, turnStartedAt}` | vscode |
| `src/notificationPolicy.ts` | **pure**: `(event, ctx) => Decision \| null` | nothing |
| `src/notifier/index.ts` | `Notifier` interface plus platform factory | — |
| `src/notifier/windows.ts` | SnoreToast backend, `-id` replace, click pipe | node:child_process |
| `src/notifier/unsupported.ts` | no-op backend that logs why | — |
| `src/focus.ts` | raise this VS Code window; reveal a terminal | vscode, node:child_process |
| `src/statusBar.ts` | `$(bell) Claude` item, bound-session count | vscode |
| `hook/hook.js` | the hook client; plain JS, no deps, never bundled | node:net |

`notificationPolicy.ts` holds every interesting rule and touches no I/O. It is the module
TDD applies to hardest; the rest is wiring around it.

## Event mapping

Five hooks are installed. Two produce toasts; three are bookkeeping.

| Hook | Purpose |
|---|---|
| `SessionStart` | bind `session_id` to a terminal |
| `UserPromptSubmit` | stamp turn start time, which drives the duration gate |
| `Stop` | **toast: Claude finished** — body from `last_assistant_message` |
| `Notification` | **toast: Claude needs you** — when `notification_type` is `permission_prompt`, `idle_prompt`, or `agent_needs_input` |
| `SessionEnd` | drop the binding |

Other `notification_type` values (`auth_success`, `elicitation_*`, `agent_completed`) are
ignored in v1 and logged.

### Session-to-terminal binding

On `SessionStart`, bind to `vscode.window.activeTerminal`. Verify against the event's `cwd`
using `terminal.shellIntegration?.cwd` when available; on mismatch, search all terminals for
a `cwd` match. Bindings are dropped on `SessionEnd` and on `onDidCloseTerminal`. If an event
arrives for an unknown session — the extension activated mid-session — fall back to `cwd`
matching, and if that fails still notify, with a click target of the window rather than a
specific terminal.

### Notification policy

```
decide(event, ctx) -> Decision | null

ctx = { windowFocused, boundTerminal, activeTerminal, turnStartedAt, config, now }

isUserWatching(ctx) = ctx.config.suppressWhenActiveTerminal
                   && ctx.windowFocused
                   && ctx.boundTerminal != null
                   && ctx.boundTerminal === ctx.activeTerminal
```

With `suppressWhenActiveTerminal` off, `isUserWatching` is always false and only the
duration gate, dedup, and rate cap remain.

- **`Stop`** — suppressed if `notifyOnComplete` is off, if the turn took less than
  `minTurnDurationSeconds` (default 20, so a three-second answer stays quiet), or if
  `isUserWatching`. Otherwise: title `Claude finished · <folder>`, body the first
  `messagePreviewLength` characters of `last_assistant_message`, normal urgency.
- **`Notification`** — suppressed if `notifyOnNeedsInput` is off, if the type is not one of
  the three listed above, or if `isUserWatching`. No duration gate: being blocked is
  immediately worth knowing. Title `Claude needs you · <folder>`, body describing which kind
  and naming the tool when the payload carries one, high urgency, sticky.

Both are then subject to **dedup** (same `sessionId` and kind within `dedupWindowSeconds`
collapses) and a **global rate cap** (`maxToastsPerMinute`, a runaway-loop backstop).
Windows toasts are issued with `-id` set to a hash of `sessionId` and kind, so a session
replaces its own toast in place rather than stacking.

Every decision, including every suppression and its reason, is written to the output
channel. "Why did I not get a toast" must be answerable in one look.

`urgency` is an abstract field on `Decision` so the policy stays platform-free. The Windows
backend maps it: `normal` to `-d short`, `high` to `-d long`, and `sticky` suppresses the
auto-dismiss so the toast waits in the Action Center. `claudeToasts.sound` set to false adds
`-silent` regardless of urgency.

## Wire protocol

The hook slims the payload before it leaves the Claude process. Only these fields cross the
pipe:

```json
{
  "t": "<token>",
  "ts": 1755950000000,
  "hook_event_name": "Stop",
  "session_id": "abc123",
  "cwd": "C:\\Users\\adev\\Desktop\\proj",
  "notification_type": null,
  "tool_name": null,
  "last_assistant_message": "<truncated to 500 chars>"
}
```

Assistant text is truncated in the hook itself, so at most 500 characters of transcript ever
leaves Claude Code, over a local named pipe, to a process owned by the same user. That bound
is the ceiling for `messagePreviewLength`, which is clamped to it — a larger setting cannot
surface text the hook never sent. The server rejects any line whose token does not match,
and caps line length.

### Pipe addressing and trust

- Pipe: `\\.\pipe\claude-toasts-<16 random hex>`, one per window, created at activation.
- Token: a separate 128-bit random value, compared on every line.
- Env vars injected via `context.environmentVariableCollection`: `CLAUDE_TOASTS_PIPE` and
  `CLAUDE_TOASTS_TOKEN`.
- `collection.persistent = false` — critical. Otherwise VS Code restores stale pipe names
  into terminals after a window reload and events vanish silently.

Any local process can enumerate named pipes on Windows, hence the token: knowing the pipe
name is not enough to spoof a toast.

## Hook installation contract

Target: `%USERPROFILE%\.claude\settings.json`.

`hook.js` is copied on activation into the extension's **globalStorage** directory, whose
path is stable across extension updates — unlike `extensionPath`, which is versioned and
would invalidate the installed hook config on every update. Entries are identified as ours
by `args[0]` ending in `claude-toasts-hook.js`; no non-schema marker fields are written.

```json
{
  "hooks": {
    "Stop": [ { "hooks": [ {
      "type": "command",
      "command": "node",
      "args": ["<globalStorage>\\claude-toasts-hook.js"],
      "async": true,
      "timeout": 5
    } ] } ]
  }
}
```

`async: true` means Claude Code never waits on us — the node spawn cost is off the critical
path entirely.

Rules:

- **Append, never replace.** Users may already have `Stop` hooks; our entry joins the array.
- **Reconcile on activation.** If entries are missing, duplicated, or point at a stale path,
  fix them. Self-healing.
- **Back up once.** Copy to `settings.json.claude-toasts.bak` before the first write.
- **Refuse on unparseable input.** If the file will not round-trip cleanly, do not write;
  surface an error naming the path.
- **Remove exactly ours.** Uninstall prunes our entries and any arrays or objects they leave
  empty, and nothing else.
- **Consent on first run.** Prompt before the first modification of a global config file.
- **Preflight `node`.** The hook runs `node` from `PATH`. Verify at install time and fail
  with a clear message rather than installing a hook that silently cannot run.

## Click-to-focus

SnoreToast runs in wait mode with `-pipeName`, so activation is reported back without
registering a COM activator. On activation the extension raises its own window and calls
`terminal.show(false)` on the bound terminal.

Raising the window is the one genuinely unsolved piece: a VS Code window has no API to bring
itself to the foreground. Two candidates, to be settled by Spike 1:

1. Spawn `code <workspaceFolder>` — VS Code prefers an existing window that already has that
   folder open. Simple and portable, but needs verification that it focuses rather than
   reopens, including for multi-root and untitled workspaces.
2. Win32 `SetForegroundWindow` against the `Code.exe` top-level window whose title matches
   the workspace name. Precise and fast, fragile if two windows share a folder name.

`focus.ts` exposes one function so the choice stays behind an interface. If both fail,
degrade to firing the toast with no click action rather than shipping a dead click.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `claudeToasts.enabled` | `true` | master switch |
| `claudeToasts.notifyOnComplete` | `true` | toast on `Stop` |
| `claudeToasts.notifyOnNeedsInput` | `true` | toast on blocking `Notification` |
| `claudeToasts.minTurnDurationSeconds` | `20` | skip toasts for quick turns |
| `claudeToasts.suppressWhenActiveTerminal` | `true` | stay quiet if you are already looking |
| `claudeToasts.messagePreviewLength` | `120` | characters of assistant text in the body, clamped to 500 |
| `claudeToasts.sound` | `true` | play the system notification sound |
| `claudeToasts.dedupWindowSeconds` | `5` | collapse repeats per session and kind |
| `claudeToasts.maxToastsPerMinute` | `10` | runaway backstop |

Commands: Install Hooks, Remove Hooks, Send Test Notification, Show Log.

Status bar: `$(bell) Claude` with the bound-session count; tooltip lists sessions; clicking
opens the log.

## Error handling

| Failure | Behavior |
|---|---|
| No env var in the terminal | Hook exits 0. Silent by design — Claude is outside VS Code. |
| Pipe gone because the window closed | Hook connect fails, exits 0. Never disturbs Claude. |
| Bad or missing token | Server drops the line, logs once per source. |
| Oversized line | Truncated and logged; never buffers unboundedly. |
| SnoreToast missing or failing | Log, disable the notifier for the session, show one error. |
| `node` not on `PATH` | Install refuses with an actionable message. |
| Unparseable `settings.json` | Refuse to write, surface the path. |
| Remote workspace | Detect at activation, show one explanatory message, stay dormant. |

Guiding rule: **a broken notifier must never break Claude Code.** Every path from the hook
back into Claude ends in exit 0.

## Testing

- **`notificationPolicy`** — table-driven unit tests over `(event, ctx)` pairs. A pure
  function, so every rule above becomes a case: duration-gate boundaries, each
  `notification_type`, watching versus not, dedup, rate cap. TDD applies here first.
- **`hookInstaller`** — fixture-based: missing file, empty file, file with unrelated user
  hooks on the same events, file already holding our entries at a stale path, malformed
  file. Assert that install then remove round-trips to a byte-identical original.
- **`hook.js`** — feed JSON on stdin, assert the slimmed payload and the truncation bound.
- **Integration** (`@vscode/test-electron`) — activate, write a synthetic event into the
  pipe, assert a stubbed `Notifier` received the expected `Decision`. The `Notifier`
  interface exists partly to make this possible.
- **Manual checklist** for what cannot be automated: a real toast appears; clicking it
  focuses the right window and reveals the right terminal; hooks install and uninstall
  cleanly against a real `~/.claude/settings.json`.

## Build

TypeScript, bundled with esbuild. `@types/vscode` pinned to `^1.90`, well below the
installed 1.133, so the extension is not needlessly version-locked. `hook/hook.js` is copied
verbatim, never bundled, and has zero dependencies so it starts fast and cannot break from a
bundler change.

## Limitations

- **Remote workspaces are out.** The toast must fire on the local Windows machine, but in a
  Remote-SSH, WSL, or devcontainer workspace both the extension host and the terminals live
  on the remote. Splitting into a UI-scoped half and a workspace-scoped half would fix it,
  and is deferred.
- **"Is the terminal visible" is approximated by "is it the active terminal".** VS Code
  exposes no panel-visibility API, so a collapsed panel still reads as watching.
  `suppressWhenActiveTerminal` exists for anyone that annoys.
- **Terminals opened before activation** miss the env vars. VS Code marks them with a
  relaunch affordance; the README will say to relaunch once after install.
- **Session binding is a heuristic** — the active terminal at `SessionStart`, checked against
  `cwd`. Two Claude sessions started back to back in the same folder without focusing their
  terminals could bind wrong. The notification still fires; the click target may be the wrong
  terminal.

## Milestones

- **M0 — Spikes.** (1) Raise a specific VS Code window from an external process. (2)
  SnoreToast on Windows 11: the AUMID shortcut via `--install`, and whether the `-pipeName`
  click callback survives the Action Center. Both are throwaway probes.
- **M1 — Plumbing.** Skeleton, pipe server, `hook.js`, install and remove, session registry,
  output channel. Log every arriving event; no policy and no toasts yet. The point is to see
  real Claude Code events land in the right window before anything is built on top.
- **M2 — Policy.** `notificationPolicy` built test-first, wired to log its decisions instead
  of firing.
- **M3 — Toasts.** Windows notifier, dedup, `-id` replacement, click-to-focus.
- **M4 — Finish.** Settings schema, status bar, test command, README, manual checklist.
