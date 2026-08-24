#!/usr/bin/env node
"use strict";

// Claude Code hook client for vscode-claude-toasts.
//
// Runs once per hook event (async: true, so Claude never waits on it). Reads the
// hook JSON on stdin, slims it, and writes a single NDJSON line to this VS Code
// window's named pipe. The pipe name and a shared token arrive as env vars that
// the extension injects into the terminal. No env vars => Claude is running
// outside a managed terminal => exit silently. Every failure path ends in exit 0:
// a broken notifier must never disturb Claude Code.
//
// Zero dependencies on purpose — this must start fast and never break from a
// bundler change.

const net = require("net");

const MAX_STDIN = 1_000_000; // 1 MB guard; assistant messages are truncated below anyway
const MAX_MESSAGE_CHARS = 500;
const CONNECT_TIMEOUT_MS = 2000;

function main() {
  const pipe = process.env.CLAUDE_TOASTS_PIPE;
  const token = process.env.CLAUDE_TOASTS_TOKEN;
  if (!pipe || !token) {
    process.exit(0);
  }

  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("data", (chunk) => {
    if (raw.length < MAX_STDIN) {
      raw += chunk;
    }
  });
  process.stdin.on("end", () => {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      process.exit(0);
    }
    send(pipe, buildLine(ev, token));
  });
}

function buildLine(ev, token) {
  const msg =
    typeof ev.last_assistant_message === "string"
      ? ev.last_assistant_message.slice(0, MAX_MESSAGE_CHARS)
      : null;
  const payload = {
    t: token,
    ts: Date.now(),
    hook_event_name: ev.hook_event_name || null,
    session_id: ev.session_id || null,
    cwd: ev.cwd || null,
    notification_type: ev.notification_type || null,
    tool_name: ev.tool_name || null,
    last_assistant_message: msg,
  };
  return JSON.stringify(payload) + "\n";
}

function send(pipe, line) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  const sock = net.createConnection(pipe);
  const timer = setTimeout(finish, CONNECT_TIMEOUT_MS);
  timer.unref?.();
  sock.on("error", finish);
  sock.on("connect", () => {
    sock.write(line, () => sock.end());
  });
  sock.on("close", finish);
}

main();
