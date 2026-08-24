import { Notifier, ToastRequest } from "./index";

/** No-op backend for non-Windows platforms (v1 is Windows-first). */
export class UnsupportedNotifier implements Notifier {
  readonly available = false;

  constructor(private readonly log: (m: string) => void, private readonly platform: string) {}

  async show(req: ToastRequest): Promise<void> {
    this.log(`no toast backend for ${this.platform}; would have shown: ${req.title} — ${req.body}`);
  }

  async hide(): Promise<void> {
    /* nothing was ever shown */
  }

  dispose(): void {
    /* nothing to clean up */
  }
}
