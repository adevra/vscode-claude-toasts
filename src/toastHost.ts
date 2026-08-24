import { ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { hideCommand, parseHostLine, showCommand } from "./toastHostProtocol";

/**
 * Manages the compiled toast host (media/ToastHost.cs): reply-capable toasts
 * must be shown by a live process to receive their typed text, so the host is
 * spawned lazily on the first reply toast and exits after an idle TTL. While no
 * reply toast is pending, nothing runs.
 */

const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const FRAMEWORK = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319";
const WINMETADATA = "C:\\Windows\\System32\\WinMetadata";
const HOST_IDLE_TTL_MS = 5 * 60_000;

export interface ToastHostDeps {
  /** dist/ directory holding ToastHost.cs. */
  assetDir: string;
  /** globalStorage directory for the compiled exe. */
  storageDir: string;
  appId: string;
  onActivated(id: string, args: string, reply: string): void;
  log(message: string): void;
}

/** Compile the host if the exe is missing or older than the shipped source. */
export function ensureHostCompiled(deps: Pick<ToastHostDeps, "assetDir" | "storageDir" | "log">): Promise<string | null> {
  const source = path.join(deps.assetDir, "ToastHost.cs");
  const exe = path.join(deps.storageDir, "toast-host.exe");
  try {
    if (!fs.existsSync(CSC)) {
      deps.log("[host] csc.exe not found; reply boxes unavailable");
      return Promise.resolve(null);
    }
    if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(source).mtimeMs) {
      return Promise.resolve(exe);
    }
  } catch (e) {
    deps.log(`[host] compile preflight failed: ${(e as Error).message}`);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile(
      CSC,
      [
        "-nologo",
        "-target:exe",
        `-out:${exe}`,
        `-r:${FRAMEWORK}\\System.Runtime.WindowsRuntime.dll`,
        `-r:${FRAMEWORK}\\System.Runtime.dll`,
        `-r:${FRAMEWORK}\\System.Runtime.InteropServices.WindowsRuntime.dll`,
        `-r:${WINMETADATA}\\Windows.Foundation.winmd`,
        `-r:${WINMETADATA}\\Windows.UI.winmd`,
        `-r:${WINMETADATA}\\Windows.Data.winmd`,
        source,
      ],
      { timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          deps.log(`[host] compile failed: ${(stdout || err.message).trim()}`);
          resolve(null);
        } else {
          deps.log("[host] toast host compiled");
          resolve(exe);
        }
      },
    );
  });
}

export class ToastHost {
  private child: ChildProcess | undefined;
  private ready = false;
  private queue: string[] = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private exePath: string | null | undefined;

  constructor(private readonly deps: ToastHostDeps) {}

  /** Show a reply-capable toast through the host. False if the host is unavailable. */
  async show(id: string, tag: string, group: string, xml: string): Promise<boolean> {
    if (!(await this.ensureRunning())) {
      return false;
    }
    this.send(showCommand(id, tag, group, xml));
    this.touch();
    return true;
  }

  hide(tag: string, group: string): void {
    if (this.child && !this.child.killed) {
      this.send(hideCommand(tag, group));
    }
  }

  dispose(): void {
    this.stop();
  }

  private async ensureRunning(): Promise<boolean> {
    if (this.child && !this.child.killed) {
      return true;
    }
    if (this.exePath === undefined) {
      this.exePath = await ensureHostCompiled(this.deps);
    }
    if (!this.exePath) {
      return false;
    }
    try {
      const child = spawn(this.exePath, [this.deps.appId], { windowsHide: true });
      this.child = child;
      this.ready = false;
      this.queue = [];
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          this.handleLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.on("error", (e) => {
        this.deps.log(`[host] spawn error: ${e.message}`);
        this.child = undefined;
      });
      child.on("close", (code) => {
        this.deps.log(`[host] exited (${code ?? "signal"})`);
        this.child = undefined;
        this.ready = false;
      });
      return true;
    } catch (e) {
      this.deps.log(`[host] failed to start: ${(e as Error).message}`);
      this.child = undefined;
      return false;
    }
  }

  private handleLine(line: string): void {
    const event = parseHostLine(line);
    if (!event) {
      return;
    }
    switch (event.ev) {
      case "ready":
        this.ready = true;
        for (const queued of this.queue) {
          this.child?.stdin?.write(queued);
        }
        this.queue = [];
        break;
      case "activated":
        this.touch();
        this.deps.onActivated(event.id, event.args, event.reply);
        break;
      case "err":
        this.deps.log(`[host] ${event.message}`);
        break;
      case "shown":
      case "dismissed":
        break;
    }
  }

  private send(line: string): void {
    if (this.ready) {
      this.child?.stdin?.write(line);
    } else {
      this.queue.push(line);
    }
  }

  /** Restart the idle countdown; the host exits when no reply toast is recent. */
  private touch(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => this.stop(), HOST_IDLE_TTL_MS);
    this.idleTimer.unref?.();
  }

  private stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    if (child && !child.killed) {
      try {
        child.stdin?.write("exit\n");
        setTimeout(() => {
          if (!child.killed) {
            child.kill();
          }
        }, 1000).unref?.();
      } catch {
        child.kill();
      }
    }
  }
}
