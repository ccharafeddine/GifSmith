// @tauri-apps/api/app for the browser build.
declare const __APP_VERSION__: string;
declare const __APP_NAME__: string;
export async function getVersion(): Promise<string> { return __APP_VERSION__; }
export async function getName(): Promise<string> { return __APP_NAME__; }
export async function getTauriVersion(): Promise<string> { return "web"; }
