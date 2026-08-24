import { execFile } from "node:child_process";

/**
 * Registers a notification-only AppUserModelID so Windows will show and attribute
 * our toasts. This is a plain HKCU registry key — no Start Menu shortcut, no COM.
 * Verified sufficient for CreateToastNotifier(appId).Show() on Windows 11.
 */
export function registerAppId(appId: string, displayName: string, iconPath?: string): Promise<void> {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
  return reg(["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", displayName, "/f"]).then(() => {
    if (iconPath) {
      return reg(["add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", iconPath, "/f"]).then(() => undefined);
    }
    return undefined;
  });
}

export function unregisterAppId(appId: string): Promise<void> {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
  return reg(["delete", key, "/f"]).catch(() => undefined);
}

function reg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("reg.exe", args, { windowsHide: true }, (err, _out, stderr) => {
      if (err) {
        reject(new Error(`reg ${args[0]} failed: ${stderr?.trim() || err.message}`));
      } else {
        resolve();
      }
    });
  });
}
