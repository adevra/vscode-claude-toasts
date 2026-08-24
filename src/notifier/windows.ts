import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Notifier, NotifierDeps, ToastRequest } from "./index";

export const TOAST_GROUP = "claude-toasts";
const GROUP = TOAST_GROUP;
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
    const xml = buildToastXml(req);
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

  hide(tag: string): Promise<void> {
    const args = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(this.deps.assetDir, "hide-toast.ps1"),
      "-AppId", this.deps.appId,
      "-Tag", shortTag(tag),
      "-Group", GROUP,
    ];
    return new Promise<void>((resolve) => {
      execFile(POWERSHELL, args, { timeout: SHOW_TIMEOUT_MS, windowsHide: true }, () => resolve());
    });
  }

  dispose(): void {
    /* stateless */
  }
}

export function shortTag(tag: string): string {
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

export function buildToastXml(req: ToastRequest): string {
  const scenario = req.sticky ? ' scenario="urgent"' : "";
  const launch = req.launchUri ? ` launch="${xmlEscape(req.launchUri)}"` : "";
  const audio = req.sound ? "" : '\n  <audio silent="true"/>';
  const title = xmlEscape(req.title);
  const body = xmlEscape(req.body || " ");
  const actionParts: string[] = [];
  if (req.replyPlaceholder) {
    actionParts.push(`    <input id="reply" type="text" placeHolderContent="${xmlEscape(req.replyPlaceholder)}"/>`);
    actionParts.push(`    <action content="Send" activationType="foreground" arguments="action=reply" hint-inputId="reply"/>`);
  }
  for (const a of req.actions ?? []) {
    actionParts.push(
      `    <action content="${xmlEscape(a.content)}" activationType="protocol" arguments="${xmlEscape(a.uri)}"/>`,
    );
  }
  const actions = actionParts.length > 0 ? "\n  <actions>\n" + actionParts.join("\n") + "\n  </actions>" : "";
  const attribution = req.attribution
    ? `\n      <text placement="attribution">${xmlEscape(req.attribution)}</text>`
    : "";
  const strip = req.stripPath
    ? `\n      <image src="${xmlEscape(pathToFileURL(req.stripPath).href)}"/>`
    : "";
  return (
    `<toast activationType="protocol"${launch}${scenario}>\n` +
    `  <visual>\n` +
    `    <binding template="ToastGeneric">\n` +
    `      <text>${title}</text>\n` +
    `      <text hint-wrap="true" hint-maxLines="30">${body}</text>${attribution}${strip}\n` +
    `    </binding>\n` +
    `  </visual>${actions}${audio}\n` +
    `</toast>`
  );
}
