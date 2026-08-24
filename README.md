# Claude Code Toasts

Native Windows desktop notifications when Claude Code — running in your VS Code
terminal — **finishes a turn** or **needs your input**. Like Warp's notifications,
but driven by Claude Code's typed hook events instead of guessing from the
terminal stream, so it knows *which* session, in *which* terminal, and *why*.

## What you get

- **Claude finished** — a toast when a turn ends, with a preview of the last
  message. Quick turns (under 20s by default) stay quiet.
- **Claude needs you** — a sticky, high-urgency toast when Claude is blocked on a
  permission prompt, has gone idle, or explicitly needs input.
- **Click to focus** — clicking a toast focuses the right VS Code window and
  reveals the terminal running that session.
- **Approve or deny from the toast** — when Claude asks permission to run
  something while you're away, the toast shows the actual command with **Allow**
  and **Deny** buttons. Answering there unblocks Claude without touching the
  window. If you're sitting at that terminal, or you don't answer in time, it
  falls straight through to Claude's normal prompt.
- **Mute** — every toast carries a "Mute 30m" button for that session.
- **Stays quiet when you're already looking** — no toast if the window is focused
  and that session's terminal is active.

## How it works

1. The extension opens a per-window named pipe and injects its address into every
   integrated terminal as an environment variable.
2. It installs six Claude Code hooks into `~/.claude/settings.json`
   (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`,
   `PermissionRequest`). All are `async` — Claude never waits — except
   `PermissionRequest`, which blocks only long enough to collect your answer and
   always falls back to the terminal prompt on timeout.
3. A tiny zero-dependency hook script forwards each event to that window's pipe.
4. A pure policy decides whether to toast, and a native Windows (WinRT) toast is
   shown. Clicks route back through VS Code's own `vscode://` URI handler.

## Setup

1. Install the extension (`code --install-extension vscode-claude-toasts-*.vsix`).
2. On first activation it asks to add its hooks to `~/.claude/settings.json`.
   Choose **Install**. (Or run **Claude Toasts: Install Hooks** any time.)
3. **Relaunch any open Claude Code sessions** so they pick up the pipe address.
4. Try **Claude Toasts: Send Test Notification** to confirm toasts appear.

## Commands

- **Claude Toasts: Install Hooks** — add/repair the hooks in `~/.claude/settings.json`.
- **Claude Toasts: Remove Hooks** — remove exactly our hooks and unregister.
- **Claude Toasts: Send Test Notification** — fire a sample toast.
- **Claude Toasts: Show Log** — open the output channel (every decision, including
  why a toast was suppressed, is logged here).

## Settings

All under `claudeToasts.*`: `enabled`, `notifyOnComplete`, `notifyOnNeedsInput`,
`minTurnDurationSeconds`, `suppressWhenActiveTerminal`, `messagePreviewLength`,
`sound`, `dedupWindowSeconds`, `maxToastsPerMinute`. See the Settings UI for
descriptions.

## Limitations (v1)

- **Windows only.** The notifier is behind an interface; macOS/Linux backends are
  future work. On other platforms the extension runs dormant.
- **Local workspaces only.** Remote-SSH / WSL / devcontainer workspaces run the
  extension host on the remote, so the toast can't reach your local desktop yet.
- **Terminals opened before install** miss the pipe address — relaunch them once.

## Development

```
npm install
npm test          # unit + hook-client tests (vitest)
npm run build     # bundle to dist/ (esbuild)
npm run package   # produce a .vsix
```

Press **F5** to launch an Extension Development Host.

The design doc lives in `docs/superpowers/specs/`.

## License

MIT
