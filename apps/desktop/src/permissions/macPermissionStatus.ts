import * as Electron from "electron";

import type { MacPermission } from "./MacPermission.ts";

export function isMacPermissionGranted(permission: Exclude<MacPermission, "full-disk-access">) {
  return permission === "accessibility"
    ? Electron.systemPreferences.isTrustedAccessibilityClient(false)
    : Electron.systemPreferences.getMediaAccessStatus("screen") === "granted";
}

export async function requestMacPermission(permission: Exclude<MacPermission, "full-disk-access">) {
  if (permission === "accessibility") {
    Electron.systemPreferences.isTrustedAccessibilityClient(true);
    return;
  }
  if (Electron.systemPreferences.getMediaAccessStatus("screen") !== "not-determined") return;
  try {
    // First capture makes the app appear in the Screen Recording settings pane.
    await Electron.desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
  } catch {
    // Permission denial is reported by the status check.
  }
}
