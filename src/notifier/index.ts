export interface ToastRequest {
  kind: "complete" | "needs-input";
  title: string;
  body: string;
  urgency: "normal" | "high";
  sticky: boolean;
  sound: boolean;
  /** Stable id per session+kind so a toast replaces its own predecessor. */
  tag: string;
  /** vscode:// URI opened when the toast is clicked (focuses window + terminal). */
  launchUri?: string;
}

export interface Notifier {
  readonly available: boolean;
  show(req: ToastRequest): Promise<void>;
  dispose(): void;
}

export interface NotifierDeps {
  /** Directory holding the bundled .ps1 helpers (dist/). */
  assetDir: string;
  appId: string;
  /** Absolute path to the toast logo, shown as appLogoOverride; optional. */
  iconPath?: string;
  log(message: string): void;
}
