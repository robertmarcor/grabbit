import {parseM3u8, safeName} from './core.mjs';
import {crc32, zip} from './zip.mjs';
import {mergeFmp4} from './fmp4.mjs';
// Downloads HLS streams and video+audio pairs, joins them, and hands the file to Chrome's downloads.
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (m.type === 'hls-start') { job(m.job, hls); reply({}); }
  if (m.type === 'merge-start') { job(m.job, pair); reply({}); }
  if (m.type === 'zip-start') { job(m.job, bundle); reply({}); }
  if (m.type === 'revoke') URL.revokeObjectURL(m.blobUrl);
});
const report = (key, job) => chrome.runtime.sendMessage({type:'hls-progress', key, job});

async function job(j, fn) {
  let pct = -1;
  const progress = p => { const now = Math.floor(p * 100); if (now !== pct) { pct = now; report(j.key, {progress:now / 100}); } };
  try { await fn(j, progress); report(j.key, {state:'done', progress:1}); }
  catch (e) { report(j.key, {state:'error', error:e.message}); }
}
async function save(blob, name, ext) {
  const blobUrl = URL.createObjectURL(blob);
  const r = await chrome.runtime.sendMessage({type:'hls-save', blobUrl, name, ext});
  if (r?.error) throw new Error(r.error);
}

async function hls({url, audioUrl, name}, progress) {
  const top = parseM3u8(new TextDecoder().decode(await fetchBytes(url)), url);
  if (top.variants.length) { // master playlist: best quality plus its audio track
    const v = top.variants[0], tracks = top.audio.filter(a => a.group === v.audio);
    audioUrl ||= (tracks.find(a => a.default) || tracks[0])?.url;
    url = v.url;
  }
  const files = [url, audioUrl].filter(Boolean), out = [];
  for (const [i, u] of files.entries()) out.push(await grab(u, p => progress((i + p) / files.length * .97)));
  if (out.length === 2 && out[0].ext === 'mp4' && out[1].ext === 'mp4') {
    try { return await save(await mergeFmp4(out[0].blob, out[1].blob), name, 'mp4'); } catch {} // fall back to two files
  }
  await save(out[0].blob, name, out[0].ext);
  if (out[1]) await save(out[1].blob, name + ' (audio)', out[1].ext);
}

async function grab(url, onProgress) {
  const pl = parseM3u8(new TextDecoder().decode(await fetchBytes(url)), url);
  if (!pl.segments.length) throw new Error('The stream playlist has no segments.');
  const parts = new Array(pl.segments.length), keys = new Map();
  let next = 0, done = 0;
  async function worker() {
    while (next < pl.segments.length) {
      const i = next++, s = pl.segments[i];
      const data = s.key ? await decrypt(await fetchBytes(s.url), s, keys) : await fetchBytes(s.url);
      parts[i] = new Blob([data]); // Blobs can live on disk, so long movies don't fill memory
      onProgress(++done / pl.segments.length);
    }
  }
  await Promise.all(Array.from({length:6}, worker));
  if (pl.map) parts.unshift(new Blob([await fetchBytes(pl.map)]));
  const head = new Uint8Array(await parts[0].slice(0, 12).arrayBuffer()), box = String.fromCharCode(...head.slice(4, 8));
  // TS segments are kept as .ts (plays in VLC / Windows Media Player); fMP4 segments join into a real .mp4.
  const ext = head[0] === 0x47 ? 'ts' : /ftyp|styp|moof|moov/.test(box) ? 'mp4'
    : String.fromCharCode(...head.slice(0, 3)) === 'ID3' || (head[0] === 0xff && (head[1] & 0xf0) === 0xf0) ? 'aac' : 'ts';
  return {blob:new Blob(parts, {type:ext === 'ts' ? 'video/mp2t' : ext === 'aac' ? 'audio/aac' : 'video/mp4'}), ext};
}

async function pair({videoUrl, audioUrl, name}, progress) {
  const loaded = [0, 0], totals = [0, 0];
  const [video, audio] = await Promise.all([videoUrl, audioUrl].map((u, i) => fetchBlob(u, (n, total) => {
    loaded[i] = n; totals[i] = total;
    if (totals[0] && totals[1]) progress((loaded[0] + loaded[1]) / (totals[0] + totals[1]) * .97);
  })));
  await save(await mergeFmp4(video, audio), name, 'mp4');
}

// Downloads the files one by one and saves them as a single .zip.
async function bundle({files, name}, progress) {
  const out = [];
  for (const [i, f] of files.entries()) {
    let crc = 0;
    const blob = await fetchBlob(f.url, (n, total) => total && progress((i + n / total) / files.length * .97), chunk => { crc = crc32(chunk, crc); });
    // Unknown extension: take it from the server's content type (image/jpeg -> jpg).
    const ext = f.ext || {jpeg:'jpg', 'svg+xml':'svg', 'x-icon':'ico', mpeg:'mp3'}[blob.type.split('/')[1]?.split(';')[0]] || blob.type.split('/')[1]?.split(/[;+]/)[0] || 'bin';
    out.push({name:safeName(f.name, ext), blob, crc});
    progress((i + 1) / files.length * .97);
  }
  await save(zip(out), name, 'zip');
}

// shortcut: a dropped connection fails the whole file (no resume); fine for normal connections.
async function fetchBlob(url, onProgress, onChunk) {
  const r = await fetch(url, {credentials:'include'});
  if (!r.ok) throw new Error(`Server refused the file (HTTP ${r.status}).`);
  const total = Number(r.headers.get('content-length')) || 0, reader = r.body.getReader(), parts = [];
  let chunks = [], n = 0, pending = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length; pending += value.length;
    onChunk?.(value);
    if (pending > 32e6) { parts.push(new Blob(chunks)); chunks = []; pending = 0; }
    onProgress(n, total);
  }
  parts.push(new Blob(chunks));
  return new Blob(parts, {type:r.headers.get('content-type') || ''});
}

async function fetchBytes(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, {credentials:'include'});
      if (!r.ok) throw new Error(`Server refused a stream part (HTTP ${r.status}).`);
      return await r.arrayBuffer();
    } catch (e) { if (i >= tries) throw e; await new Promise(res => setTimeout(res, 1000 * i)); }
  }
}

async function decrypt(data, s, keys) {
  if (s.key.method !== 'AES-128') throw new Error(`This stream uses ${s.key.method} protection (DRM), which can't be saved.`);
  if (!keys.has(s.key.url)) keys.set(s.key.url, fetchBytes(s.key.url).then(k => crypto.subtle.importKey('raw', k, 'AES-CBC', false, ['decrypt'])));
  const iv = new Uint8Array(16);
  if (s.key.iv) { const hex = s.key.iv.replace(/^0x/i, '').padStart(32, '0'); for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16); }
  else new DataView(iv.buffer).setUint32(12, s.seq);
  return crypto.subtle.decrypt({name:'AES-CBC', iv}, await keys.get(s.key.url), data);
}
