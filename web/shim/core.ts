// @tauri-apps/api/core for the browser build. `invoke` runs the app's own
// command implementations in ../commands.ts (ffmpeg.wasm and browser APIs)
// instead of Rust; `convertFileSrc` maps a stored file to a blob: URL.
import { commands } from "../commands";
import { urlFor } from "./vfs";

export type InvokeArgs = Record<string, unknown>;

export async function invoke<T>(cmd: string, args: InvokeArgs = {}): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (commands as unknown as Record<string, ((a: any) => unknown) | undefined>)[cmd];
  if (!run) throw `${cmd.replace(/_/g, " ")} runs in the desktop app only.`;
  try {
    return (await run(args)) as T;
  } catch (e) {
    // Rust commands reject with a plain string; keep that shape for the UI.
    throw e instanceof Error ? e.message : e;
  }
}

/** A blob: URL for a stored file. It ends in "#" so that a cache-buster the UI
 *  appends (`?v=2`) lands in the fragment instead of breaking the blob URL. */
export function convertFileSrc(path: string, _protocol = "asset"): string {
  const u = urlFor(path);
  return u.startsWith("blob:") ? `${u}#` : u;
}

export function isTauri(): boolean { return false; }

export class Channel<T> {
  onmessage: (m: T) => void = () => undefined;
  send(m: T) { this.onmessage(m); }
}
