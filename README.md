# Claude Code Toasts

Native Windows desktop notifications for Claude Code sessions — in VS Code
terminals and standalone terminals alike. Driven by Claude Code's typed hook
events rather than terminal-stream guessing, so every toast knows which session
it came from, which repo and branch, and why it fired. Reply to Claude without
leaving the notification.

## What you get

- **Claude finished** — a toast when a turn ends, with a preview of the last
  message. Quick turns (under 20s by default) stay quiet.
- **Claude needs you** — a sticky, high-urgency toast when Claude is blocked on
  a permission prompt, has gone idle, or explicitly needs input.
- **Reply from the toast** (opt-in: `claudeToasts.replyBox`) — completion and
  needs-input toasts carry a text box and a Send button. What you type is sent into that session's terminal as your
  next prompt, submitted. Powered by a tiny helper compiled on your machine at
  first use (Windows' own `csc.exe`, no bundled binaries) that runs only while a
  reply toast is recent — zero steady-state cost.
- **Approve or deny from the toast** — permission toasts show the actual command
  ("Bash: rm -rf build") with **Allow** and **Deny** buttons, backed by a
  blocking `PermissionRequest` hook. If you're at the terminal, don't answer in
  time, or anything goes wrong, it falls through to Claude's normal prompt.
- **Click to focus** — clicking a toast raises the right window: the exact VS
  Code window and terminal for editor sessions, or the terminal's own window
  (Windows Terminal etc.) for standalone sessions. A ladder of Win32 strategies
  gets past foreground lock, restores minimized windows, and re-raises once if
  the Action Center hands focus back to the previous app.
- **Repo, branch, and color** — every toast names the repository and branch
  (read from `.git/HEAD`, no git processes) and carries a color strip: the
  session's `/color` from Claude Code when set (read live from the transcript,
  so mid-session changes apply), otherwise a stable per-repo color.
- **Stays quiet when you're watching** — no toast when the window is focused and
  that session's terminal is active. Terminal sessions bind exactly by process
  ancestry; background-job sessions fall back to cwd matching.
- **Mute** — every toast has a "Mute 30m" button for its session.

## How it works

1. The extension opens a per-window named pipe and injects its address into
   every integrated terminal, and publishes a live-window registry so terminals
   survive extension reloads and updates.
2. It installs six Claude Code hooks into `~/.claude/settings.json`
   (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`,
   `PermissionRequest`). All are `async` — Claude never waits — except
   `PermissionRequest`, which blocks only to collect your Allow/Deny and always
   falls back to the terminal prompt on timeout.
3. A zero-dependency hook script forwards each event to the right window's pipe,
   falling back to the registry (matched by cwd) when its injected address is
   stale, and walks in the session's process identity for exact terminal binding.
4. A pure policy decides whether to toast; native WinRT toasts render it. Clicks
   route back through VS Code's `vscode://` URI handler; typed replies come back
   through the compiled toast host's in-process activation event.

## Setup

1. Install: `code --install-extension vscode-claude-toasts-*.vsix`
2. On first activation it asks to add its hooks to `~/.claude/settings.json` —
   accept, or run **Claude Toasts: Install Hooks** later.
3. Try **Claude Toasts: Send Test Notification**.

Existing hooks in your settings are preserved (ours append), and **Claude
Toasts: Remove Hooks** removes exactly ours.

## Commands

- **Claude Toasts: Install Hooks** / **Remove Hooks**
- **Claude Toasts: Send Test Notification**
- **Claude Toasts: Show Log** — every decision is logged, including why a toast
  was suppressed; the log also persists to VS Code's log directory.
- **Claude Toasts: Diagnostics** — pipe, registry, per-session bindings, config.

## Settings

All under `claudeToasts.*`:

| Setting | Default | Purpose |
|---|---|---|
| `enabled` | `true` | master switch |
| `notifyOnComplete` | `true` | toast when a turn ends |
| `notifyOnNeedsInput` | `true` | toast when Claude is blocked on you |
| `replyBox` | `false` | opt-in: text box + Send on toasts |
| `minTurnDurationSeconds` | `20` | skip toasts for quick turns |
| `suppressWhenActiveTerminal` | `true` | stay quiet while you watch |
| `messagePreviewLength` | `120` | characters of Claude's message shown |
| `sound` | `true` | system notification sound |
| `dedupWindowSeconds` | `5` | collapse repeats per session and kind |
| `maxToastsPerMinute` | `10` | runaway backstop |

## Limitations

- **Windows only** for now; the notifier sits behind an interface so macOS and
  Linux backends can be added without restructuring.
- **Local workspaces only** — in Remote-SSH / WSL / devcontainer workspaces the
  extension host runs remotely and can't reach your desktop.
- At least one VS Code window must be running — the extension renders the
  toasts, including for standalone-terminal sessions.
- Replies work while the toast helper is alive (about 5 minutes per toast);
  after that the Send button does nothing, but body clicks and Mute still work.
- Windows policy the extension won't fight: elevated apps keep the foreground,
  exclusive-fullscreen apps suppress banners, and fullscreen auto–Do Not
  Disturb sends toasts straight to the Action Center.

## Development

```
npm install
npm test          # vitest — pure policy, protocol, and parser tests
npm run build     # esbuild bundle + assets into dist/
npm run package   # .vsix
```

Press **F5** for an Extension Development Host. The design spec and its
implementation deviations live in `docs/superpowers/specs/`.

## License

MIT
