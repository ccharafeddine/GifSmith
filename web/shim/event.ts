// @tauri-apps/api/event for the browser build: an in-page event bus.
export interface Event<T> { event: string; id: number; payload: T }
export type EventCallback<T> = (e: Event<T>) => void;
export type UnlistenFn = () => void;
export type EventName = string;

const subs = new Map<string, Set<EventCallback<unknown>>>();
let id = 0;

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const set = subs.get(event) ?? new Set();
  subs.set(event, set);
  set.add(handler as EventCallback<unknown>);
  return () => set.delete(handler as EventCallback<unknown>);
}

export async function once<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const off = await listen<T>(event, (e) => { off(); handler(e); });
  return off;
}

/** Deliver an event synchronously (commands use this for progress). */
export function emitLocal<T>(event: string, payload: T): void {
  for (const h of [...(subs.get(event) ?? [])]) h({ event, id: ++id, payload });
}

export async function emit<T>(event: string, payload?: T): Promise<void> { emitLocal(event, payload); }
export async function emitTo<T>(_target: unknown, event: string, payload?: T): Promise<void> { emitLocal(event, payload); }

export const TauriEvent = { DRAG_DROP: "tauri://drag-drop", DRAG_ENTER: "tauri://drag-enter", DRAG_LEAVE: "tauri://drag-leave", DRAG_OVER: "tauri://drag-over" } as const;
