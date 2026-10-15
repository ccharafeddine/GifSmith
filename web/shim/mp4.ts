// Minimal ISO-BMFF (MP4/MOV) reader: video keyframe times from the sample
// tables (stss/stts/ctts/elst), read with Blob.slice so even multi-GB files
// cost a few small reads. Returns null when the file isn't MP4/MOV-like.

interface Box { type: string; start: number; size: number; header: number }

async function bytes(b: Blob, start: number, len: number): Promise<DataView> {
  return new DataView(await b.slice(start, start + len).arrayBuffer());
}

async function readBox(b: Blob, at: number, end: number): Promise<Box | null> {
  if (at + 8 > end) return null;
  const v = await bytes(b, at, 16);
  let size = v.getUint32(0);
  const type = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
  let header = 8;
  if (size === 1) { size = Number(v.getBigUint64(8)); header = 16; }
  else if (size === 0) size = end - at;
  if (size < header) return null;
  return { type, start: at, size, header };
}

async function children(b: Blob, parent: { start: number; size: number; header: number }, skip = 0): Promise<Box[]> {
  const out: Box[] = [];
  let at = parent.start + parent.header + skip;
  const end = parent.start + parent.size;
  while (at < end) {
    const c = await readBox(b, at, end);
    if (!c) break;
    out.push(c);
    at += c.size;
  }
  return out;
}

const find = (bs: Box[], t: string) => bs.find((x) => x.type === t);

async function payload(b: Blob, box: Box): Promise<DataView> {
  return bytes(b, box.start + box.header, box.size - box.header);
}

export async function mp4Keyframes(b: Blob): Promise<number[] | null> {
  const top = await children(b, { start: 0, size: b.size, header: 0 });
  if (!find(top, "ftyp") && !find(top, "moov")) return null;
  const moov = find(top, "moov");
  if (!moov) return null;
  for (const trak of (await children(b, moov)).filter((x) => x.type === "trak")) {
    const tk = await children(b, trak);
    const mdia = find(tk, "mdia");
    if (!mdia) continue;
    const md = await children(b, mdia);
    const hdlr = find(md, "hdlr");
    if (!hdlr || (await bytes(b, hdlr.start + hdlr.header + 8, 4)).getUint32(0) !== 0x76696465 /* vide */) continue;
    const mdhd = await payload(b, find(md, "mdhd")!);
    const timescale = mdhd.getUint8(0) === 1 ? mdhd.getUint32(20) : mdhd.getUint32(12);
    const minf = find(md, "minf");
    const stbl = minf && find(await children(b, minf), "stbl");
    if (!stbl) return null;
    const st = await children(b, stbl);
    // Decode times per sample from stts.
    const stts = await payload(b, find(st, "stts")!);
    const n = stts.getUint32(4);
    const dts: number[] = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      const count = stts.getUint32(8 + i * 8), delta = stts.getUint32(12 + i * 8);
      for (let k = 0; k < count; k++) { dts.push(t); t += delta; }
    }
    // Composition offsets (B-frames) from ctts, if present.
    const cttsBox = find(st, "ctts");
    const cto = new Array<number>(dts.length).fill(0);
    if (cttsBox) {
      const c = await payload(b, cttsBox);
      const v1 = c.getUint8(0) === 1;
      let s = 0;
      for (let i = 0, m = c.getUint32(4); i < m; i++) {
        const count = c.getUint32(8 + i * 8);
        const off = v1 ? c.getInt32(12 + i * 8) : c.getUint32(12 + i * 8);
        for (let k = 0; k < count && s < cto.length; k++) cto[s++] = off;
      }
    }
    // Edit list start (media time of presentation 0), if present.
    let shift = 0;
    const edts = find(tk, "edts");
    const elstBox = edts && find(await children(b, edts), "elst");
    if (elstBox) {
      const e = await payload(b, elstBox);
      const v1 = e.getUint8(0) === 1;
      const entries = e.getUint32(4);
      for (let i = 0, at = 8; i < entries; i++, at += v1 ? 20 : 12) {
        const mt = v1 ? Number(e.getBigInt64(at + 8)) : e.getInt32(at + 4);
        if (mt >= 0) { shift = mt; break; }
      }
    }
    const pts = (i: number) => Math.max(0, (dts[i] + cto[i] - shift) / timescale);
    const stssBox = find(st, "stss");
    let keys: number[];
    if (!stssBox) keys = dts.map((_, i) => pts(i)); // every sample is a sync sample
    else {
      const s = await payload(b, stssBox);
      keys = [];
      for (let i = 0, m = s.getUint32(4); i < m; i++) {
        const idx = s.getUint32(8 + i * 4) - 1;
        if (idx >= 0 && idx < dts.length) keys.push(pts(idx));
      }
    }
    keys = [...new Set([0, ...keys.map((k) => Math.round(k * 1e6) / 1e6)])].sort((a, b) => a - b);
    return keys;
  }
  return null;
}
