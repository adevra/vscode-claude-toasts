# Changelog

## 0.5.2

- Extension category corrected to Other (was wrongly listed under Notebooks).

## 0.5.1

- New icon (user-supplied) and a rewritten README covering the full feature set.

## 0.5.0

- **Reply box.** Completion and needs-input toasts now carry a text box and a
  Send button; what you type is sent straight into the session's terminal.
  Windows only delivers typed toast text to the process that created the toast,
  so a small helper (compiled on this machine from bundled C# source with the
  csc.exe that ships with Windows - no binaries distributed) is spawned lazily
  when a reply toast fires and exits after 5 idle minutes: zero steady-state
  cost. Body clicks and Mute keep working through protocol activation even
  after the helper exits; only the Send button needs it alive.
- Reply boxes appear only for sessions with a VS Code terminal to type into;
  permission toasts and external-terminal sessions never get one.
- New setting claudeToasts.replyBox (default on).

## 0.4.5

- Fix: clicking a toast while the VS Code window was MINIMIZED did nothing (the
  previously focused app appeared to stay on top). VS Code's own URI activation
  focuses a minimized window without restoring it, so the extension saw
  focused=true and skipped its raise. The Win32 raise now always runs after the
  self-raise settles - it restores a minimized window and is a visual no-op when
  the window is already up.

## 0.4.4

- Persist the output channel to disk (LogOutputChannel) so raise/suppression
  decisions can be diagnosed from log files.

## 0.4.3

- Fix: clicking a toast while another app (e.g. Edge) was in the foreground could
  leave that app on top. When the Action Center dismisses, Windows restores
  foreground to the previously focused app, undoing the raise after it succeeded.
  A reclaim guard now checks ~0.7s and ~1.6s after a successful raise and
  re-raises once if focus was taken back. Applies to external terminal raises
  too. One retry only - never a focus war.

## 0.4.2

- Removed the large body icon (appLogoOverride) from toasts; the small app icon
  next to the attribution line is the only branding now.

## 0.4.1

- Background-job sessions (daemon-spawned, no terminal in their process
  ancestry) now get watching-suppression via a cwd fallback: no toast when the
  window is focused and the active terminal's cwd is the session's cwd. Applies
  only to sessions without an exact binding, so precisely-bound terminal
  sessions keep exact suppression and two same-folder terminal sessions never
  mute each other. Trade-off: two background sessions sharing one folder are
  muted together while you watch either.
- Diagnostics now labels each session's binding: vscode-terminal,
  external(hwnd), background (cwd fallback), heuristic, or unresolved.

## 0.4.0

- Sessions running in standalone terminals (Windows Terminal, etc.) are now
  first-class: clicking their toast raises the terminal window itself instead of
  VS Code. The hook sends the Claude CLI pid; the extension walks the process
  ancestry to the terminal host and carries its window handle in the toast's
  launch URI, so any VS Code window can perform the raise.
- VS Code terminal binding is now exact: an ancestor pid matching a terminal's
  shell pid beats the old active-terminal-at-SessionStart heuristic, which stays
  only as a fallback. This also makes the 'stay quiet when you are watching'
  suppression reliable for VS Code terminals.

## 0.3.1

- Fix: clicking a toast raised the VS Code window twice. A focus trace showed
  VS Code raising itself while handling the vscode:// URI (the spawned Code.exe
  carries the toast click's foreground rights), after which the extension's Win32
  raise ran anyway - its focus check fired before the self-raise landed. The
  extension now waits up to 500ms for the self-raise and runs the Win32 ladder
  only if the window is still unfocused.

## 0.3.0

- Toasts now show the repository name and branch in the attribution line
  ("vscode-claude-toasts · main"), read from .git/HEAD - no git processes.
- Session color strip: a thin color bar under the toast text. Uses the session's
  /color from Claude Code when set (read live from the session transcript, so
  mid-session changes apply), otherwise a stable auto color per repository from
  the same 8-color palette. /color default falls back to the auto color.

## 0.2.3

- Removed the foreground-lock-timeout strategy from the window-raise ladder. It
  mutated a system-wide setting, and SPI_SETFOREGROUNDLOCKTIMEOUT takes its value
  in pvParam rather than a pointer to it - passing a reference set the live
  timeout to a pointer address, which would have blocked focus changes system
  wide. The remaining strategies (altkey, topmost, minimizerestore) each raise the
  window on their own and touch no global state.

## 0.2.2

- Each rung of the window-raise ladder is now individually verified; a -StartAt
  switch lets the fallbacks be exercised directly, since they otherwise only run
  during the failure they exist to fix. altkey, locktimeout, topmost and
  minimizerestore each raise the window on their own.

## 0.2.1

- Fix: clicking a toast found the right window but Windows refused to raise it.
  A background process may not call SetForegroundWindow, and the previous two
  fallbacks were not enough. The helper now walks a ladder of seven strategies -
  SetForegroundWindow, SwitchToThisWindow, AttachThreadInput, a synthetic ALT tap,
  temporarily zeroing the system foreground-lock timeout, a topmost flicker, and
  finally minimize+restore - and logs which one Windows honored (strategy=...).

## 0.2.0

- **Approve or deny a permission request straight from the toast.** Permission
  toasts now show the actual command ("Bash: rm -rf build") with Allow / Deny
  buttons. PermissionRequest is installed as a blocking hook and the pipe grew a
  request/response path so the decision reaches Claude Code. Safe by design: if
  you are at that terminal, notifications are off, the session is muted, nothing
  answers in time, or the window closes, it escalates to Claude's own prompt.
- **Mute buttons.** Every toast carries "Mute 30m" for that session.
- Answered permission toasts are removed from the Action Center instead of
  lingering with dead buttons.
- Fix: closing a window no longer left a blocked hook waiting for its timeout -
  the pipe server now destroys live connections on dispose.

## 0.1.5

- Window raise now disambiguates when several windows share a folder name. The
  helper reports all matching windows instead of guessing; the extension orders
  them by which one shows its active editor, raises them one at a time, and asks
  VS Code which window actually took focus. Correct by construction rather than
  by title heuristics. Single-match windows keep the old one-shot fast path.

## 0.1.4

- Fix: clicking a toast revealed the right terminal but did not raise the VS Code
  window. Windows grants foreground rights to the Code.exe the shell spawns to
  forward the vscode:// URI, and that process exits immediately, so the running
  window stayed behind. The extension now raises its own window explicitly via
  Win32 (EnumWindows title match, then SwitchToThisWindow / AttachThreadInput).
- Fix: a redundant second toast ("Waiting for your input") arrived ~60s after a
  completed turn. Claude Code emits idle_prompt when you do not reply; it is now
  suppressed when a completion toast already fired for that same turn. It still
  fires when the completion toast was suppressed, and never mutes permission
  prompts.

## 0.1.3

- Fix: terminals stopped delivering notifications after an extension update or
  window reload. Each activation created a new named pipe, but terminals hold the
  address injected at launch, so they wrote into a dead pipe and failed silently.
  The extension now publishes a live-window registry next to the hook script, and
  the hook falls back to it (matching the window whose workspace folder contains
  the session cwd) whenever its injected address is stale.
- Terminals opened before the extension activated now work too, via the same
  fallback - this was previously a documented limitation.
- New command: Claude Toasts: Diagnostics, dumping pipe, registry, sessions and
  config to the log.

## 0.1.2

- New icon: a toasted slice branded with the Claude burst, used for the
  extension and the toast app-logo.

## 0.1.1

- Toasts now show the Claude logo (as the prominent app-logo icon and the
  attribution icon), and the logo is used as the extension icon.

## 0.1.0

- Initial release. Native Windows desktop toasts when Claude Code finishes a turn
  or needs your input, driven by Claude Code hooks. Click a toast to focus the
  right window and terminal.
