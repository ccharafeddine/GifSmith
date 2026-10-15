// @tauri-apps/plugin-opener for the browser build.
export async function openUrl(url: string | URL): Promise<void> { window.open(String(url), "_blank", "noopener"); }
// There is no file manager to open in a browser; saved files are in Downloads.
export async function openPath(_path: string): Promise<void> {}
export async function revealItemInDir(_path: string): Promise<void> {}
