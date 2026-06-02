import { createSignal } from "solid-js";
import type { VideoMeta } from "./ipc";

// Shared app state. Per CLAUDE.md, plain signals until this grows past ~10.

/** Absolute path of the loaded source video, or null when none is open. */
export const [filePath, setFilePath] = createSignal<string | null>(null);

/** Probed metadata for the loaded video, or null until probing succeeds. */
export const [meta, setMeta] = createSignal<VideoMeta | null>(null);
