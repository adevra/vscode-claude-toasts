# Changelog

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
