#!/usr/bin/env node
"use strict";

// Claude Code hook client for vscode-claude-toasts.
//
// Runs once per hook event (async: true, so Claude never waits on it). Reads the
// hook JSON on stdin, slims it, and writes a single NDJSON line to a VS Code
// window's named pipe.
//
// Finding that pipe is two-stage:
//   1. CLAUDE_TOASTS_PIPE / _TOKEN, injected into the terminal by the extension.
//      Exact per-window routing — the fast path.
//   2. If that pipe is gone (the extension host reloaded after an update, so the
//      terminal holds a stale address) or was never injected (terminal predates
//      activation), fall back to the live-window registry that the extension
//      maintains next to this script, and pick the window whose workspace folder
//      contains this session's cwd.
//
// Every failure path ends in exit 0: a broken notifier must never disturb Claude.
// Zero dependencies on purpose — this must start fast.

const fs = require("fs");
const net = require("net");
const path = require("path");

const MAX_STDIN = 1_000_000;
const MAX_MESSAGE_CHARS = 500;
const CONNECT_TIMEOUT_MS = 600;
const MAX_CANDIDATES = 8;
const RESPONSE_TIMEOUT_MS = 25000;

function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("data", (chunk) => {
    if (raw.length < MAX_STDIN) raw += chunk;
  });
  process.stdin.on("end", () => {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return process.exit(0);
    }
    const candidates = buildCandidates(ev);
    if (candidates.length === 0) process.exit(0);
    trySend(candidates, 0, ev);
  });
}

/** Ordered list of {pipe, token} to try: env first, then registry by cwd match. */
function buildCandidates(ev) {
  const out = [];
  const envPipe = process.env.CLAUDE_TOASTS_PIPE;
  const envToken = process.env.CLAUDE_TOASTS_TOKEN;
  if (envPipe && envToken) {
    out.push({ pipe: envPipe, token: envToken });
  }
  for (const entry of rankEntries(readRegistry(), ev && ev.cwd)) {
    if (!out.some((c) => c.pipe === entry.pipe)) {
      out.push({ pipe: entry.pipe, token: entry.token });
    }
  }
  return out.slice(0, MAX_CANDIDATES);
}

function readRegistry() {
  const dir = path.join(__dirname, "live");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (e && typeof e.pipe === "string" && typeof e.token === "string") {
        entries.push(e);
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return entries;
}

function normPath(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : "";
}

/** Longest containing workspace folder wins; then most recently updated. */
function rankEntries(entries, cwd) {
  const target = normPath(cwd);
  const scored = entries.map((e) => {
    let score = -1;
    const folders = Array.isArray(e.folders) ? e.folders : [];
    for (const f of folders) {
      const nf = normPath(f);
      if (!nf || !target) continue;
      if (target === nf || target.startsWith(nf + "/")) {
        score = Math.max(score, nf.length);
      }
    }
    return { entry: e, score, updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0 };
  });
  scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  return scored.map((s) => s.entry);
}

/**
 * One-line human summary of what a tool is about to do, so a permission toast can
 * say "Bash: rm -rf build" instead of just "Bash". Only the fields that matter are
 * read; everything else about the tool input stays inside Claude Code.
 */
function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return null;
  const pick = input.command || input.file_path || input.path || input.pattern || input.url || input.prompt;
  if (typeof pick === "string" && pick.trim()) {
    return pick.trim().slice(0, MAX_MESSAGE_CHARS);
  }
  return null;
}

function buildLine(ev, token) {
  const msg =
    typeof ev.last_assistant_message === "string"
      ? ev.last_assistant_message.slice(0, MAX_MESSAGE_CHARS)
      : null;
  return (
    JSON.stringify({
      t: token,
      ts: Date.now(),
      hook_event_name: ev.hook_event_name || null,
      session_id: ev.session_id || null,
      cwd: ev.cwd || null,
      transcript_path: ev.transcript_path || null,
      notification_type: ev.notification_type || null,
      tool_name: ev.tool_name || null,
      tool_summary: summarizeToolInput(ev.tool_input),
      tool_use_id: ev.tool_use_id || null,
      last_assistant_message: msg,
    }) + "\n"
  );
}

/** Try each candidate in order; stop at the first that accepts the write. */
function trySend(candidates, index, ev) {
  if (index >= candidates.length) process.exit(0);
  const { pipe, token } = candidates[index];

  let settled = false;
  const next = () => {
    if (settled) return;
    settled = true;
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
    trySend(candidates, index + 1, ev);
  };

  const sock = net.createConnection(pipe);
  const timer = setTimeout(next, CONNECT_TIMEOUT_MS);
  if (timer.unref) timer.unref();

  sock.on("error", next);
  sock.on("connect", () => {
    clearTimeout(timer);
    settled = true;
    sock.write(buildLine(ev, token));

    // PermissionRequest is the one event Claude Code waits on: the extension
    // answers with allow / deny / escalate and we print that to stdout. If nothing
    // arrives in time we print nothing, which Claude Code reads as "no decision"
    // and falls through to its own permission prompt — never a hang.
    if (ev.hook_event_name !== "PermissionRequest") {
      sock.end();
      return process.exit(0);
    }

    let reply = "";
    const giveUp = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      process.exit(0);
    }, RESPONSE_TIMEOUT_MS);
    if (giveUp.unref) giveUp.unref();

    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      reply += chunk;
      const nl = reply.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(giveUp);
      const line = reply.slice(0, nl).trim();
      if (line) process.stdout.write(line + "\n");
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    sock.on("close", () => {
      clearTimeout(giveUp);
      process.exit(0);
    });
  });
}

main();
