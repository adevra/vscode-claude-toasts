export interface ToastAction {
  content: string;
  uri: string;
}

export interface ToastRequest {
  kind: "complete" | "needs-input" | "permission";
  title: string;
  body: string;
  urgency: "normal" | "high";
  sticky: boolean;
  sound: boolean;
  /** Stable id per session+kind so a toast replaces its own predecessor. */
  tag: string;
  /** vscode:// URI opened when the toast is clicked (focuses window + terminal). */
  launchUri?: string;
  /** Buttons; each opens its own vscode:// URI via protocol activation. */
  actions?: ToastAction[];
  /** Small bottom line: "repo · branch". */
  attribution?: string;
  /** Absolute path to a color-strip PNG rendered under the text; optional. */
  stripPath?: string;
}

export interface Notifier {
  readonly available: boolean;
  show(req: ToastRequest): Promise<void>;
  /** Remove an already-shown toast from the Action Center by its tag. */
  hide(tag: string): Promise<void>;
  dispose(): void;
}

export interface NotifierDeps {
  /** Directory holding the bundled .ps1 helpers (dist/). */
  assetDir: string;
  appId: string;
  log(message: string): void;
}
