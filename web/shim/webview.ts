// @tauri-apps/api/webview for the browser build: OS file drops become DOM
// drag-and-drop, and dropped files are stored so their paths work everywhere.
import { addFile } from "./vfs";
import type { Event, UnlistenFn } from "./event";

type Pos = { x: number; y: number };
export type DragDropEvent =
  | { type: "enter"; paths: string[]; position: Pos }
  | { type: "over"; position: Pos }
  | { type: "drop"; paths: string[]; position: Pos }
  | { type: "leave" };

function hasFiles(e: DragEvent) { return !!e.dataTransfer && [...e.dataTransfer.types].includes("Files"); }

export function getCurrentWebview() {
  return {
    label: "main",
    async onDragDropEvent(handler: (e: Event<DragDropEvent>) => void): Promise<UnlistenFn> {
      let depth = 0;
      let id = 0;
      const fire = (payload: DragDropEvent) => handler({ event: "tauri://drag-drop", id: ++id, payload });
      const pos = (e: DragEvent): Pos => ({ x: e.clientX * devicePixelRatio, y: e.clientY * devicePixelRatio });
      const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); if (depth++ === 0) fire({ type: "enter", paths: [], position: pos(e) }); };
      const over = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); fire({ type: "over", position: pos(e) }); };
      const leave = (e: DragEvent) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; fire({ type: "leave" }); } };
      const drop = (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        const paths = [...(e.dataTransfer?.files ?? [])].map((f) => addFile(f, f.name));
        fire({ type: "drop", paths, position: pos(e) });
      };
      window.addEventListener("dragenter", enter);
      window.addEventListener("dragover", over);
      window.addEventListener("dragleave", leave);
      window.addEventListener("drop", drop);
      return () => {
        window.removeEventListener("dragenter", enter);
        window.removeEventListener("dragover", over);
        window.removeEventListener("dragleave", leave);
        window.removeEventListener("drop", drop);
      };
    },
  };
}
export const getCurrentWebviewWindow = getCurrentWebview;
