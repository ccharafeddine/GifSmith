/** Format seconds as `m:ss` (clamps NaN/negatives to 0:00). */
export function formatTimecode(secs: number): string {
  const safe = Number.isFinite(secs) && secs > 0 ? secs : 0;
  const total = Math.floor(safe);
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${mins}:${rem.toString().padStart(2, "0")}`;
}
