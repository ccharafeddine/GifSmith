// @tauri-apps/plugin-dialog for the browser build. `open` uses a file input and
// returns stored paths; `save` returns a path in the virtual Downloads folder
// (the command that writes there triggers the real browser download).
import { addFile, DOWNLOADS, basename } from "./vfs";

export interface DialogFilter { name: string; extensions: string[] }
export interface OpenDialogOptions { multiple?: boolean; directory?: boolean; filters?: DialogFilter[]; title?: string; defaultPath?: string }
export interface SaveDialogOptions { defaultPath?: string; filters?: DialogFilter[]; title?: string }

function accept(filters?: DialogFilter[]): string {
  const exts = (filters ?? []).flatMap((f) => f.extensions).filter((e) => e && e !== "*");
  return exts.map((e) => "." + e).join(",");
}

export function pickFiles(acceptAttr: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = acceptAttr;
    input.multiple = multiple;
    input.style.display = "none";
    document.body.appendChild(input);
    const done = (f: File[]) => { input.remove(); resolve(f); };
    input.onchange = () => done(Array.from(input.files ?? []));
    input.addEventListener("cancel", () => done([]));
    input.click();
  });
}

export async function open(o: OpenDialogOptions = {}): Promise<string | string[] | null> {
  // Folders can't be picked in a browser: saved files go to the Downloads list.
  if (o.directory) return o.multiple ? [DOWNLOADS] : DOWNLOADS;
  const picked = await pickFiles(accept(o.filters), !!o.multiple);
  if (!picked.length) return null;
  const paths = picked.map((f) => addFile(f, f.name));
  return o.multiple ? paths : paths[0];
}

export async function save(o: SaveDialogOptions = {}): Promise<string | null> {
  const name = basename(o.defaultPath || "export");
  return `${DOWNLOADS}/${name}`;
}

export async function message(msg: string): Promise<void> { window.alert(msg); }
export async function ask(msg: string): Promise<boolean> { return window.confirm(msg); }
export async function confirm(msg: string): Promise<boolean> { return window.confirm(msg); }
