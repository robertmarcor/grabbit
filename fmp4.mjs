// Minimal fragmented-MP4 tools: tell which tracks a file has, and merge a video-only + audio-only fMP4 into one file.
const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const type = (b, o = 0) => String.fromCharCode(...b.subarray(o + 4, o + 8));
const bytes = async (blob, s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer());

export function box(t, ...parts) {
  const b = new Uint8Array(8 + parts.reduce((n, p) => n + p.length, 0));
  dv(b).setUint32(0, b.length);
  for (let i = 0; i < 4; i++) b[4 + i] = t.charCodeAt(i);
  let o = 8;
  for (const p of parts) { b.set(p, o); o += p.length; }
  return b;
}
function header(h) {
  let size = dv(h).getUint32(0), hdr = 8;
  if (size === 1) { size = Number(dv(h).getBigUint64(8)); hdr = 16; }
  return {type:type(h), size, hdr};
}
// Children of a box held in memory (moov/moof are small, so no 64-bit sizes there).
function children(b) {
  const out = [];
  for (let p = 8; p + 8 <= b.length;) {
    const size = dv(b).getUint32(p);
    if (size < 8 || p + size > b.length) break;
    out.push(b.subarray(p, p + size)); p += size;
  }
  return out;
}
const find = (b, path) => path.reduce((x, t) => x && children(x).find(c => type(c) === t), b);
const all = (b, t) => children(b).filter(c => type(c) === t);
const handler = trak => type(find(trak, ['mdia', 'hdlr']), 12); // handler_type sits at byte 16
// Value at a version-dependent offset of a full box: 32-bit in v0, 64-bit in v1.
function field(b, off0, off1, value) {
  const v1 = b[8] === 1, d = dv(b), o = v1 ? off1 : off0;
  if (value === undefined) return v1 ? Number(d.getBigUint64(o)) : d.getUint32(o);
  v1 ? d.setBigUint64(o, BigInt(Math.round(value))) : d.setUint32(o, Math.round(value));
}

export function describeMoov(moov) {
  const kinds = all(moov, 'trak').map(handler);
  return {video:kinds.includes('vide'), audio:kinds.includes('soun'), frag:!!find(moov, ['mvex'])};
}
// read(start, end) -> Uint8Array. Walks top-level box headers until it finds moov.
export async function probe(read) {
  for (let p = 0, i = 0; i < 12; i++) {
    const h = await read(p, p + 16);
    if (h.length < 8) return null;
    const {type:t, size} = header(h);
    if (size < 8) return null;
    if (t === 'moov') return size > 16e6 ? null : describeMoov(await read(p, p + size));
    p += size;
  }
  return null;
}

async function layout(blob) {
  const out = [];
  for (let p = 0; p < blob.size;) {
    const h = await bytes(blob, p, p + 16);
    if (h.length < 8) break;
    const b = {...header(h), start:p};
    if (b.size === 0) b.size = blob.size - p;
    if (b.size < b.hdr) throw new Error('The downloaded file is damaged.');
    out.push(b); p += b.size;
  }
  return out;
}
const u32 = (b, o) => dv(b).getUint32(o);
// Big-endian 32-bit words (no spread: sample tables can hold 100k+ entries).
function words(list) { const b = new Uint8Array(list.length * 4), d = dv(b); list.forEach((n, i) => d.setUint32(i * 4, n >>> 0)); return b; }
const fullBox = (t, verFlags, ...parts) => box(t, words([verFlags]), ...parts);
function runs(values) { const out = []; for (const v of values) { const last = out.at(-1); if (last && last[1] === v) last[0]++; else out.push([1, v]); } return out; }
const ascii = s => new TextEncoder().encode(s);

// Reads every sample (duration, size, flags, position) of a single-track fragmented MP4.
async function open(blob, want) {
  const boxes = await layout(blob), moovBox = boxes.find(b => b.type === 'moov');
  if (!moovBox) throw new Error('Not an MP4 file.');
  const moov = await bytes(blob, moovBox.start, moovBox.start + moovBox.size);
  const trak = all(moov, 'trak'), trex = find(moov, ['mvex', 'trex']);
  if (trak.length !== 1 || handler(trak[0]) !== want || !trex) throw new Error('These files can’t be merged in the browser.');
  const scale = field(find(trak[0], ['mdia', 'mdhd']), 20, 28);
  const t = {moov, trak:trak[0], blob, scale, durs:[], sizes:[], ctts:[], sync:[], chunks:[]};
  let next = 0;
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].type !== 'moof') continue;
    const start = boxes[i].start, moof = await bytes(blob, start, start + boxes[i].size);
    const mdat = boxes[i + 1]?.type === 'mdat' ? boxes[i + 1].start + boxes[i + 1].hdr : start + boxes[i].size;
    for (const traf of all(moof, 'traf')) {
      const tfhd = find(traf, ['tfhd']), tf = u32(tfhd, 8) & 0xffffff;
      if (tf & 1) throw new Error('This MP4 layout (absolute data offsets) isn’t supported.');
      let o = 16;
      const opt = flag => tf & flag ? u32(tfhd, (o += 4) - 4) : undefined;
      opt(2);
      const dDur = opt(8) ?? u32(trex, 20), dSize = opt(0x10) ?? u32(trex, 24), dFlags = opt(0x20) ?? u32(trex, 28);
      const tfdt = find(traf, ['tfdt']);
      let time = tfdt ? field(tfdt, 12, 12) : next, pos = null;
      for (const trun of all(traf, 'trun')) {
        const fl = u32(trun, 8) & 0xffffff, n = u32(trun, 12);
        let p = 16;
        if (fl & 1) { pos = start + dv(trun).getInt32(p); p += 4; } else pos ??= mdat;
        const first = fl & 4 ? u32(trun, (p += 4) - 4) : undefined;
        const chunk = {src:pos, size:0, n, time:time / scale, track:t};
        for (let k = 0; k < n; k++) {
          const dur = fl & 0x100 ? u32(trun, (p += 4) - 4) : dDur;
          const size = fl & 0x200 ? u32(trun, (p += 4) - 4) : dSize;
          const flags = fl & 0x400 ? u32(trun, (p += 4) - 4) : k === 0 && first !== undefined ? first : dFlags;
          if (fl & 0x800) { t.ctts.push(trun[8] === 1 ? dv(trun).getInt32(p) : u32(trun, p)); p += 4; } else t.ctts.push(0);
          t.durs.push(dur); t.sizes.push(size);
          if (!(flags & 0x10000)) t.sync.push(t.sizes.length); // "non-sync" bit clear = keyframe
          chunk.size += size; time += dur;
        }
        pos += chunk.size;
        if (n) t.chunks.push(chunk);
      }
      next = time;
    }
  }
  if (!t.sizes.length) throw new Error('The file has no media samples.');
  return t;
}

// Rebuilds a track as a regular (non-fragmented) MP4 track with full sample tables.
function plainTrak(t, id, movieScale, offsets) {
  const trak = t.trak.slice(), total = t.durs.reduce((a, b) => a + b, 0), movieDur = Math.round(total / t.scale * movieScale);
  const tkhd = find(trak, ['tkhd']), mdhd = find(trak, ['mdia', 'mdhd']), elst = find(trak, ['edts', 'elst']);
  field(tkhd, 20, 28, id);
  field(tkhd, 28, 36, movieDur);
  field(mdhd, 24, 32, total);
  // A zero-length edit means "whole track" in fragmented files; spell the length out.
  if (elst) for (let i = 0, n = u32(elst, 12), size = elst[8] === 1 ? 20 : 12; i < n; i++) {
    if (field(elst, 16 + i * size, 16 + i * size) === 0) field(elst, 16 + i * size, 16 + i * size, movieDur);
  }
  const stbl = find(trak, ['mdia', 'minf', 'stbl']), minf = find(trak, ['mdia', 'minf']), mdia = find(trak, ['mdia']);
  const keep = children(stbl).filter(c => !['stts', 'ctts', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'stss'].includes(type(c)));
  const durRuns = runs(t.durs).flat();
  const tables = [fullBox('stts', 0, words([durRuns.length / 2].concat(durRuns)))];
  if (t.ctts.some(Boolean)) {
    const r = runs(t.ctts).flat();
    tables.push(fullBox('ctts', t.ctts.some(c => c < 0) ? 1 << 24 : 0, words([r.length / 2].concat(r))));
  }
  const perChunk = [];
  t.chunks.forEach((c, i) => { if (perChunk.at(-1)?.[1] !== c.n) perChunk.push([i + 1, c.n, 1]); });
  tables.push(fullBox('stsc', 0, words([perChunk.length].concat(perChunk.flat()))));
  tables.push(fullBox('stsz', 0, words([0, t.sizes.length].concat(t.sizes))));
  if (offsets.some(o => o > 0xffffffff)) {
    const b = new Uint8Array(4 + offsets.length * 8), d = dv(b);
    d.setUint32(0, offsets.length); offsets.forEach((o, i) => d.setBigUint64(4 + i * 8, BigInt(o)));
    tables.push(fullBox('co64', 0, b));
  } else tables.push(fullBox('stco', 0, words([offsets.length].concat(offsets))));
  if (t.sync.length < t.sizes.length) tables.push(fullBox('stss', 0, words([t.sync.length].concat(t.sync))));
  const newStbl = box('stbl', ...keep, ...tables);
  const newMinf = box('minf', ...children(minf).map(c => type(c) === 'stbl' ? newStbl : c));
  const newMdia = box('mdia', ...children(mdia).map(c => type(c) === 'minf' ? newMinf : c));
  return {box:box('trak', ...children(trak).map(c => type(c) === 'mdia' ? newMdia : c)), movieDur};
}

// Joins a video-only and an audio-only fragmented MP4 into one regular MP4 that every player handles.
export async function mergeFmp4(videoBlob, audioBlob) {
  const [v, a] = await Promise.all([open(videoBlob, 'vide'), open(audioBlob, 'soun')]);
  const mvhd = find(v.moov, ['mvhd']).slice(), movieScale = field(mvhd, 20, 28);
  // Interleave chunks by time so playback never jumps far between audio and video.
  const order = [...v.chunks, ...a.chunks].sort((x, y) => x.time - y.time || (x.track === v ? -1 : 1));
  const ftyp = box('ftyp', ascii('isom'), words([0x200]), ascii('isomiso2avc1mp41'));
  const rest = children(v.moov).filter(c => !['mvhd', 'trak', 'mvex'].includes(type(c)));
  const build = (vOff, aOff) => {
    const vt = plainTrak(v, 1, movieScale, vOff), at = plainTrak(a, 2, movieScale, aOff);
    field(mvhd, 24, 32, Math.max(vt.movieDur, at.movieDur));
    dv(mvhd).setUint32(mvhd.length - 4, 3); // next_track_ID
    return box('moov', mvhd, vt.box, at.box, ...rest);
  };
  const dataSize = order.reduce((n, c) => n + c.size, 0);
  const big = ftyp.length + dataSize + 16 + 16e6 > 0xffffffff; // over 4 GB needs 64-bit offsets
  const dry = build(v.chunks.map(() => big ? 2 ** 32 : 0), a.chunks.map(() => big ? 2 ** 32 : 0));
  let pos = ftyp.length + dry.length + 16;
  for (const c of order) { c.out = pos; pos += c.size; }
  const moov = build(v.chunks.map(c => c.out), a.chunks.map(c => c.out));
  if (moov.length !== dry.length) throw new Error('Internal error while building the MP4 index.');
  const mdatHead = new Uint8Array(16), d = dv(mdatHead);
  d.setUint32(0, 1); mdatHead.set(ascii('mdat'), 4); d.setBigUint64(8, BigInt(16 + dataSize));
  return new Blob([ftyp, moov, mdatHead, ...order.map(c => c.track.blob.slice(c.src, c.src + c.size))], {type:'video/mp4'});
}
