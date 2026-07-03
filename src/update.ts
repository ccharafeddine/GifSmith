import { createSignal } from "solid-js";
import { checkForUpdate, type UpdateInfo } from "./ipc";

// Update-check state, shared between the settings panel (manual "Check for
// updates") and the silent startup check so both drive the same UI.

/**
 * `idle`      no check run yet
 * `checking`  request in flight
 * `current`   up to date (this build is the latest)
 * `available` a newer release exists (info holds the details)
 * `error`     the check failed (error holds the message)
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "error";

/** localStorage key for the "check on startup" preference. */
const STARTUP_KEY = "gifsmith:check-updates-on-startup";

export const [updateStatus, setUpdateStatus] =
  createSignal<UpdateStatus>("idle");
export const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null);
export const [updateError, setUpdateError] = createSignal<string | null>(null);

/** Whether the silent startup check is enabled (opt-in, default off). */
export function checkOnStartupEnabled(): boolean {
  return localStorage.getItem(STARTUP_KEY) === "true";
}

/** Persist the "check on startup" preference. */
export function setCheckOnStartup(on: boolean): void {
  localStorage.setItem(STARTUP_KEY, on ? "true" : "false");
}

/**
 * Run the update check and fold the result into the shared status. Never throws:
 * a failed check resolves to the `error` status so callers can decide whether to
 * surface it. Returns the resolved status for the startup path.
 */
export async function runUpdateCheck(): Promise<UpdateStatus> {
  setUpdateStatus("checking");
  setUpdateError(null);
  try {
    const info = await checkForUpdate();
    setUpdateInfo(info);
    const status: UpdateStatus = info.is_newer ? "available" : "current";
    setUpdateStatus(status);
    return status;
  } catch (e) {
    setUpdateError(typeof e === "string" ? e : "Update check failed.");
    setUpdateStatus("error");
    return "error";
  }
}
