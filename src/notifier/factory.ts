import { Notifier, NotifierDeps } from "./index";
import { UnsupportedNotifier } from "./unsupported";
import { WindowsNotifier } from "./windows";

export function createNotifier(deps: NotifierDeps): Notifier {
  if (process.platform === "win32") {
    return new WindowsNotifier(deps);
  }
  return new UnsupportedNotifier(deps.log, process.platform);
}
