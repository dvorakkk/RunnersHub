/* ─── MP4 remux: fragmented (MediaRecorder) → progressive (playable) ─────────
   MediaRecorder emits a FRAGMENTED MP4 (ftyp + moof/mdat pairs) whose mvhd,
   tkhd and mdhd durations are 0. Phone galleries and Instagram then report
   "cannot access media" / a 0-second clip.

   This module rewrites the recording as a normal progressive MP4 in faststart
   layout (ftyp + moov + mdat) with a real duration. No dependencies. If
   anything unexpected is found it returns null and the caller keeps the original
   file, so it can never make things worse.
   ------------------------------------------------------------------------- */

const U32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const U16 = (b, o) => (b[o] << 8) | b[o + 1];
const I32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) | 0;
const TAG = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function readBoxes(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = U32(b, p);
    const type = TAG(b, p + 4);
    let hdr = 8;
    if (size === 1) { size = U32(b, p + 8) * 4294967296 + U32(b, p + 12); hdr = 16; }
    if (!size) size = end - p;
    if (p + size > end) break;
    out.push({ type, start: p, end: p + size, payload: p + hdr });
    p += size;
  }
  return out;
}
const first = (list, type) => list.find(x => x.type === type) || null;
const child = (b, box, type) => box ? first(readBoxes(b, box.payload, box.end), type) : null;
// Sample entry types we can copy verbatim into a progressive file. Chrome also
// records VP9 inside MP4 for the generic "video/mp4" type.
const CODEC_ENTRIES = ['avc1', 'avc3', 'vp09', 'vp08', 'hvc1', 'hev1', 'av01'];

// ─── writers ───────────────────────────────────────────────────────────────
function makeBox(type, ...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const b = new Uint8Array(8 + len);
  b[0] = ((8 + len) >>> 24) & 255; b[1] = ((8 + len) >>> 16) & 255;
  b[2] = ((8 + len) >>> 8) & 255; b[3] = (8 + len) & 255;
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { b.set(p, o); o += p.length; }
  return b;
}
function fullBox(type, version, flags, ...parts) {
  const head = new Uint8Array(4);
  head[0] = version; head[1] = (flags >>> 16) & 255; head[2] = (flags >>> 8) & 255; head[3] = flags & 255;
  return makeBox(type, head, ...parts);
}
function u32(v) { const a = new Uint8Array(4); a[0] = (v >>> 24) & 255; a[1] = (v >>> 16) & 255; a[2] = (v >>> 8) & 255; a[3] = v & 255; return a; }
function u16(v) { const a = new Uint8Array(2); a[0] = (v >>> 8) & 255; a[1] = v & 255; return a; }
const MATRIX = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0]);
const ZERO4 = new Uint8Array(4);

function mvhd(timescale, duration) {
  return fullBox('mvhd', 0, 0, ZERO4, ZERO4, u32(timescale), u32(duration),
    u32(0x00010000), u16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2));
}
function tkhd(width, height, duration) {
  return fullBox('tkhd', 0, 3, ZERO4, ZERO4, u32(1), ZERO4, u32(duration), new Uint8Array(8),
    u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
}
function mdhd(timescale, duration) {
  return fullBox('mdhd', 0, 0, ZERO4, ZERO4, u32(timescale), u32(duration), u16(0x55c4), u16(0));
}
function hdlr() {
  return fullBox('hdlr', 0, 0, ZERO4,
    new Uint8Array([118, 105, 100, 101]), new Uint8Array(12), new Uint8Array([0]));
}
function vmhd() { return fullBox('vmhd', 0, 1, u16(0), new Uint8Array(6)); }
function dinf() { return makeBox('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))); }
function stsd(avc1Bytes) { return fullBox('stsd', 0, 0, u32(1), avc1Bytes); }
// NB: stts and stsc are FULL boxes — they need the 4-byte version/flags header
// before entry_count. Writing them as plain boxes shifts every field by 4 and
// makes FFmpeg (and therefore every browser) refuse the file.
function stts(runs) {
  const body = new Uint8Array(4 + runs.length * 8);
  body[0] = (runs.length >>> 24) & 255; body[1] = (runs.length >>> 16) & 255;
  body[2] = (runs.length >>> 8) & 255; body[3] = runs.length & 255;
  let o = 4;
  for (const r of runs) { body.set(u32(r.count), o); body.set(u32(r.delta), o + 4); o += 8; }
  return fullBox('stts', 0, 0, body);
}
function stsc(total) {
  const body = new Uint8Array(16);
  body[3] = 1; body.set(u32(1), 4); body.set(u32(total), 8); body.set(u32(1), 12);
  return fullBox('stsc', 0, 0, body);
}
function stsz(sizes) {                     // FullBox as well: version/flags + sample_size + count
  const body = new Uint8Array(8 + sizes.length * 4);
  body.set(u32(0), 0); body.set(u32(sizes.length), 4);
  let o = 8;
  for (const s of sizes) { body.set(u32(s), o); o += 4; }
  return fullBox('stsz', 0, 0, body);
}
function stss(syncs) {                     // syncs: 1-based sample numbers
  const body = new Uint8Array(4 + syncs.length * 4);
  body[0] = (syncs.length >>> 24) & 255; body[1] = (syncs.length >>> 16) & 255;
  body[2] = (syncs.length >>> 8) & 255; body[3] = syncs.length & 255;
  let o = 4;
  for (const s of syncs) { body.set(u32(s), o); o += 4; }
  return fullBox('stss', 0, 0, body);
}
function stco(chunkOffset) { return fullBox('stco', 0, 0, u32(1), u32(chunkOffset)); }
function ftyp() {
  return makeBox('ftyp', new Uint8Array([105, 115, 111, 109]), u32(512),
    new Uint8Array([105, 115, 111, 109, 105, 115, 111, 50, 97, 118, 99, 49, 109, 112, 52, 49]));
}

// ─── main ──────────────────────────────────────────────────────────────────
export async function remuxRecordedMp4(blob, fallbackSeconds, fps) {
  if (!blob || !blob.size) return null;
  try {
    const b = new Uint8Array(await blob.arrayBuffer());
    const top = readBoxes(b, 0, b.length);
    const moov = first(top, 'moov');
    if (!moov) return null;
    const trakBox0 = child(b, moov, 'trak');
    const mdiaBox0 = child(b, trakBox0, 'mdia');
    const stblBox0 = child(b, child(b, mdiaBox0, 'minf'), 'stbl');
    const stsd = child(b, stblBox0, 'stsd');
    if (!stsd) return null;
    const entry = stsd.payload + 8;
    const entryType = TAG(b, entry + 4);
    if (CODEC_ENTRIES.indexOf(entryType) < 0) return null;
    const avc1Start = entry, avc1End = entry + U32(b, entry);
    const avc1Bytes = b.slice(avc1Start, avc1End);
    const width = U16(b, avc1Start + 8 + 24);
    const height = U16(b, avc1Start + 8 + 26);
    const mdhdBox = child(b, mdiaBox0, 'mdhd');
    const mdhdVersion = mdhdBox ? b[mdhdBox.payload] : 0;
    const timescale = mdhdBox ? U32(b, mdhdBox.payload + (mdhdVersion === 1 ? 20 : 12)) : 0;
    if (!timescale || !width || !height) return null;

    // Chrome usually keeps the sample duration/size defaults in moov/mvex/trex
    // instead of repeating them in every tfhd/trun. Without them every delta in
    // stts would be 0 and the remuxed file would be unplayable.
    let trexDur = 0, trexSize = 0, trexFlags = 0;
    const trex = child(b, child(b, moov, 'mvex'), 'trex');
    if (trex && trex.end - trex.payload >= 24) {
      trexDur = U32(b, trex.payload + 12);
      trexSize = U32(b, trex.payload + 16);
      trexFlags = U32(b, trex.payload + 20);
    }

    // ── collect samples from moof/traf/trun (fragmented layout) ────────────
    const sizes = [], durations = [], offsets = [], sampleFlags = [];
    for (const moof of top.filter(x => x.type === 'moof')) {
      const traf = child(b, moof, 'traf');
      if (!traf) continue;
      const tfhd = child(b, traf, 'tfhd');
      let baseOffset = moof.start, defDur = trexDur, defSize = trexSize, defFlags = trexFlags;
      if (tfhd) {
        const flags = U32(b, tfhd.payload) & 0xffffff;
        let q = tfhd.payload + 8;                    // version/flags + track_ID
        if (flags & 0x01) { baseOffset = U32(b, q) * 4294967296 + U32(b, q + 4); q += 8; }
        if (flags & 0x02) q += 4;
        if (flags & 0x08) { defDur = U32(b, q); q += 4; }
        if (flags & 0x10) { defSize = U32(b, q); q += 4; }
        if (flags & 0x20) { defFlags = U32(b, q); q += 4; }
      }
      for (const trun of readBoxes(b, traf.payload, traf.end).filter(x => x.type === 'trun')) {
        const flags = U32(b, trun.payload) & 0xffffff;
        const count = U32(b, trun.payload + 4);
        let q = trun.payload + 8;
        let dataOffset = 0, firstFlags = -1;
        if (flags & 0x01) { dataOffset = I32(b, q); q += 4; }
        if (flags & 0x04) { firstFlags = U32(b, q); q += 4; }
        let pos = baseOffset + dataOffset;
        for (let s = 0; s < count; s++) {
          const dur = (flags & 0x100) ? U32(b, q) : defDur;
          if (flags & 0x100) q += 4;
          const sz = (flags & 0x200) ? U32(b, q) : defSize;
          if (flags & 0x200) q += 4;
          let sf = defFlags;
          if (flags & 0x400) { sf = U32(b, q); q += 4; }   // per-sample flags
          if (s === 0 && firstFlags >= 0) sf = firstFlags;
          if (!sz) continue;
          durations.push(dur); sizes.push(sz); offsets.push(pos); sampleFlags.push(sf);
          pos += sz;
        }
      }
    }

    // Fragmented but unreadable → do not touch it (the caller keeps the original).
    if (!sizes.length) {
      if (top.some(x => x.type === 'moof')) return null;
      return patchDurations(b, timescale, fallbackSeconds);
    }
    // Every sample needs a duration; if the recorder omitted them, derive it
    // from the frame rate so stts never contains a 0 delta.
    const perFrame = Math.max(1, Math.round(timescale / (Number(fps) || 30)));
    for (let i = 0; i < durations.length; i++) if (!(durations[i] > 0)) durations[i] = perFrame;

    // Without a keyframe table every sample counts as a sync sample, so seeking
    // lands on a P-frame and decoding fails. Detect real IDR frames for AVC;
    // other codecs are left without stss (all samples treated as sync).
    const syncs = (entryType === 'avc1' || entryType === 'avc3')
      ? findSyncSamples(b, avc1Bytes, sizes, offsets)
      : syncFromFlags(sampleFlags);
    return buildProgressive(b, avc1Bytes, width, height, timescale, sizes, durations, offsets, fallbackSeconds, syncs);
  } catch (_) {
    return null;
  }
}

// Finds the NAL length prefix size inside the avcC record (usually 4).
function nalLengthSize(avc1Bytes) {
  try {
    const kids = readBoxes(avc1Bytes, 8 + 78, avc1Bytes.length);
    const avcC = first(kids, 'avcC');
    if (!avcC || avcC.end - avcC.payload < 5) return 4;
    const n = (avc1Bytes[avcC.payload + 4] & 0x03) + 1;
    return n >= 1 && n <= 4 ? n : 4;
  } catch (_) { return 4; }
}

// Non-AVC: use the "sample_is_non_sync_sample" flag when the recorder wrote it.
// Without any flags we can only guarantee the first sample, which still lets the
// player seek (it rewinds to the start and decodes forward) instead of failing.
function syncFromFlags(sampleFlags) {
  if (!sampleFlags.length) return [1];
  const syncs = [];
  for (let i = 0; i < sampleFlags.length; i++) {
    if (i === 0 || !(sampleFlags[i] & 0x00010000)) syncs.push(i + 1);
  }
  return syncs.length ? syncs : [1];
}

// A sample is a keyframe when it carries an IDR NAL (type 5).
function findSyncSamples(b, avc1Bytes, sizes, offsets) {
  const lenSize = nalLengthSize(avc1Bytes);
  const syncs = [];
  for (let i = 0; i < sizes.length; i++) {
    let p = offsets[i], end = offsets[i] + sizes[i];
    let idr = false;
    while (p + lenSize < end) {
      let n = 0;
      for (let k = 0; k < lenSize; k++) n = (n << 8) | b[p + k];
      p += lenSize;
      if (n <= 0 || p >= end) break;
      if ((b[p] & 0x1f) === 5) { idr = true; break; }
      p += n;
    }
    if (idr || i === 0) syncs.push(i + 1);
  }
  return syncs;
}

function buildProgressive(b, avc1Bytes, width, height, timescale, sizes, durations, offsets, fallbackSeconds, syncs) {
  const totalMedia = durations.reduce((a, c) => a + c, 0);
  const seconds = totalMedia > 0 ? totalMedia / timescale : (Number(fallbackSeconds) || 0);
  if (!(seconds > 0)) return null;
  const movieTs = 1000;
  const movieDuration = Math.round(seconds * movieTs);
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last.delta === d) last.count++;
    else runs.push({ count: 1, delta: d });
  }
  // Only worth writing stss when some samples are NOT keyframes.
  const needStss = Array.isArray(syncs) && syncs.length > 0 && syncs.length < sizes.length;
  const stblKids = [stsd(avc1Bytes), stts(runs)];
  if (needStss) stblKids.push(stss(syncs));
  stblKids.push(stsc(sizes.length), stsz(sizes), stco(0));

  const ftypBytes = ftyp();
  const moovBytes = makeBox('moov', mvhd(movieTs, movieDuration),
    makeBox('trak',
      tkhd(width, height, movieDuration),
      makeBox('mdia',
        mdhd(timescale, totalMedia),
        hdlr(),
        makeBox('minf', vmhd(), dinf(),
          makeBox('stbl', ...stblKids)))));

  // stco is the last 4 bytes of moov → patch it once the mdat position is known.
  const stcoAt = moovBytes.length - 4;
  const mdatStart = ftypBytes.length + moovBytes.length + 8;  // ftyp + moov + mdat header
  moovBytes[stcoAt] = (mdatStart >>> 24) & 255;
  moovBytes[stcoAt + 1] = (mdatStart >>> 16) & 255;
  moovBytes[stcoAt + 2] = (mdatStart >>> 8) & 255;
  moovBytes[stcoAt + 3] = mdatStart & 255;

  let total = 0;
  for (const s of sizes) total += s;
  const out = new Uint8Array(mdatStart + total);
  let o = 0;
  out.set(ftypBytes, o); o += ftypBytes.length;
  out.set(moovBytes, o); o += moovBytes.length;
  out[o] = ((8 + total) >>> 24) & 255; out[o + 1] = ((8 + total) >>> 16) & 255;
  out[o + 2] = ((8 + total) >>> 8) & 255; out[o + 3] = (8 + total) & 255;
  out[o + 4] = 109; out[o + 5] = 100; out[o + 6] = 97; out[o + 7] = 116;   // 'mdat'
  o += 8;
  for (let i = 0; i < sizes.length; i++) {
    out.set(b.subarray(offsets[i], offsets[i] + sizes[i]), o);
    o += sizes[i];
  }
  return new Blob([out], { type: 'video/mp4' });
}

// Non-fragmented input: overwrite the duration fields (mvhd / tkhd / mdhd).
function patchDurations(b, mediaTimescale, fallbackSeconds) {
  try {
    const out = new Uint8Array(b);
    const moov = first(readBoxes(out, 0, out.length), 'moov');
    if (!moov) return null;
    const mvhdBox = child(out, moov, 'mvhd');
    const trakBox = child(out, moov, 'trak');
    const tkhdBox = child(out, trakBox, 'tkhd');
    const mdhdBox = child(out, child(out, trakBox, 'mdia'), 'mdhd');
    const secs = Number(fallbackSeconds) || 0;
    if (!(secs > 0)) return null;
    let written = false;
    let movieTs = 1000;
    if (mvhdBox) {
      const v = out[mvhdBox.payload];
      const ts = v === 1 ? U32(out, mvhdBox.payload + 20) : U32(out, mvhdBox.payload + 12);
      const at = v === 1 ? mvhdBox.payload + 28 : mvhdBox.payload + 16;
      if (ts) { movieTs = ts; out.set(u32(Math.round(secs * ts)), at); written = true; }
    }
    if (mdhdBox && mediaTimescale) {
      const v = out[mdhdBox.payload];
      const at = v === 1 ? mdhdBox.payload + 32 : mdhdBox.payload + 16;
      if (at + 4 <= mdhdBox.end) { out.set(u32(Math.round(secs * mediaTimescale)), at); written = true; }
    }
    if (tkhdBox) {
      const v = out[tkhdBox.payload];
      const at = v === 1 ? tkhdBox.payload + 28 : tkhdBox.payload + 20;
      if (at + 4 <= tkhdBox.end) { out.set(u32(Math.round(secs * movieTs)), at); written = true; }
    }
    return written ? new Blob([out], { type: 'video/mp4' }) : null;
  } catch (_) {
    return null;
  }
}

export default remuxRecordedMp4;
