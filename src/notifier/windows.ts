import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Notifier, NotifierDeps, ToastRequest } from "./index";

const GROUP = "claude-toasts";
const POWERSHELL = "powershell.exe";
const SHOW_TIMEOUT_MS = 10_000;

/** Native Windows toast via WinRT, driven by the bundled show-toast.ps1. */
export class WindowsNotifier implements Notifier {
  readonly available = true;
  private readonly scriptPath: string;

  constructor(private readonly deps: NotifierDeps) {
    this.scriptPath = path.join(deps.assetDir, "show-toast.ps1");
  }

  show(req: ToastRequest): Promise<void> {
    const xml = buildToastXml(req, this.deps.iconPath);
    const b64 = Buffer.from(xml, "utf8").toString("base64");
    const tag = shortTag(req.tag);
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.scriptPath,
      "-AppId",
      this.deps.appId,
      "-XmlBase64",
      b64,
      "-Tag",
      tag,
      "-Group",
      GROUP,
    ];

    return new Promise<void>((resolve) => {
      execFile(POWERSHELL, args, { timeout: SHOW_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) {
          this.deps.log(`toast failed: ${err.message}${stderr ? ` | ${stderr.trim()}` : ""}`);
        }
        resolve();
      });
    });
  }

  dispose(): void {
    /* stateless */
  }
}

function shortTag(tag: string): string {
  return createHash("sha1").update(tag).digest("hex").slice(0, 16);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildToastXml(req: ToastRequest, iconPath?: string): string {
  const scenario = req.sticky ? ' scenario="urgent"' : "";
  const launch = req.launchUri ? ` launch="${xmlEscape(req.launchUri)}"` : "";
  const audio = req.sound ? "" : '\n  <audio silent="true"/>';
  const title = xmlEscape(req.title);
  const body = xmlEscape(req.body || " ");
  const logo = iconPath
    ? `\n      <image placement="appLogoOverride" src="${xmlEscape(pathToFileURL(iconPath).href)}"/>`
    : "";
  return (
    `<toast activationType="protocol"${launch}${scenario}>\n` +
    `  <visual>\n` +
    `    <binding template="ToastGeneric">\n` +
    `      <text>${title}</text>\n` +
    `      <text>${body}</text>${logo}\n` +
    `    </binding>\n` +
    `  </visual>${audio}\n` +
    `</toast>`
  );
}
