import test from 'node:test';
import assert from 'node:assert/strict';
import {box, probe, mergeFmp4} from './fmp4.mjs';

const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const full = (t, flags, ...parts) => box(t, u32(flags), ...parts);
const ascii = s => new TextEncoder().encode(s);
function moov(id, handler, scale, movieScale) {
  const mvhd = full('mvhd', 0, u32(0), u32(0), u32(movieScale), u32(0), new Uint8Array(80));
  const tkhd = full('tkhd', 0, u32(0), u32(0), u32(id), u32(0), u32(0), new Uint8Array(60));
  const mdhd = full('mdhd', 0, u32(0), u32(0), u32(scale), u32(0), u32(0));
  const hdlr = full('hdlr', 0, u32(0), ascii(handler), new Uint8Array(13));
  const stbl = box('stbl', full('stsd', 0, u32(0)), full('stts', 0, u32(0)), full('stsc', 0, u32(0)), full('stsz', 0, u32(0), u32(0)), full('stco', 0, u32(0)));
  const elst = full('elst', 0, u32(1), u32(0), u32(0), u32(0x10000));
  return box('moov', mvhd, box('trak', tkhd, box('edts', elst), box('mdia', mdhd, hdlr, box('minf', stbl))),
    box('mvex', full('trex', 0, u32(id), u32(1), u32(0), u32(0), u32(0))));
}
// One fragment with one sample (duration dur, payload = marker) using a relative data offset.
function frag(id, time, dur, marker) {
  const make = off => box('moof', full('mfhd', 0, u32(1)), box('traf', full('tfhd', 0x020000, u32(id)), full('tfdt', 0, u32(time)),
    full('trun', 0x301, u32(1), u32(off), u32(dur), u32(marker.length))));
  return [make(make(0).length + 8), box('mdat', ascii(marker))];
}
const file = (id, handler, scale, movieScale, frags) =>
  new Blob([box('ftyp', ascii('iso6')), moov(id, handler, scale, movieScale), box('sidx', new Uint8Array(8)), ...frags.flatMap(f => frag(id, ...f))]);

const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const name = (b, o = 0) => new TextDecoder().decode(b.subarray(o + 4, o + 8));
const size = (b, p) => view(b).getUint32(p) === 1 ? Number(view(b).getBigUint64(p + 8)) : view(b).getUint32(p);
function kids(b, start = 8) { const out = []; for (let p = start; p + 8 <= b.length; p += size(b, p)) out.push(b.subarray(p, p + size(b, p))); return out; }
const find = (b, path) => path.reduce((x, t) => x && kids(x).find(c => name(c) === t), b);

test('probe tells video-only, audio-only and fragmented apart', async () => {
  const read = blob => async (s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer());
  assert.deepEqual(await probe(read(file(1, 'vide', 1000, 1000, [[0, 1, 'x']]))), {video:true, audio:false, frag:true});
  assert.deepEqual(await probe(read(file(1, 'soun', 48000, 48000, [[0, 1, 'x']]))), {video:false, audio:true, frag:true});
  assert.equal(await probe(read(new Blob([ascii('not an mp4 at all')]))), null);
});

test('mergeFmp4 builds a regular MP4 with both tracks, interleaved by time', async () => {
  const video = file(1, 'vide', 1000, 24000, [[0, 2000, 'V0'], [2000, 2000, 'V1'], [4000, 2000, 'V2']]);   // 0s 2s 4s
  const audio = file(1, 'soun', 48000, 44100, [[0, 48000, 'A0'], [48000, 96000, 'A1'], [144000, 144000, 'A2']]); // 0s 1s 3s
  const out = new Uint8Array(await (await mergeFmp4(video, audio)).arrayBuffer());
  const top = kids(out, 0);
  assert.deepEqual(top.map(b => name(b)), ['ftyp', 'moov', 'mdat']);
  const m = top[1];
  assert.equal(find(m, ['mvex']), undefined);                        // no longer fragmented
  const traks = kids(m).filter(b => name(b) === 'trak');
  assert.deepEqual(traks.map(t => view(find(t, ['tkhd'])).getUint32(20)), [1, 2]);
  const payload = (t, i) => { const stco = find(t, ['mdia', 'minf', 'stbl', 'stco']), o = view(stco).getUint32(16 + i * 4); return new TextDecoder().decode(out.subarray(o, o + 2)); };
  assert.deepEqual([0, 1, 2].map(i => payload(traks[0], i)), ['V0', 'V1', 'V2']);
  assert.deepEqual([0, 1, 2].map(i => payload(traks[1], i)), ['A0', 'A1', 'A2']);
  assert.equal(new TextDecoder().decode(out.subarray(top[0].length + m.length + 16)), 'V0A0A1V1A2V2'); // interleaved
  assert.equal(view(find(m, ['mvhd'])).getUint32(24), 6 * 24000);      // movie duration 6 s
  assert.equal(view(find(traks[1], ['mdia', 'mdhd'])).getUint32(24), 288000); // audio 6 s at 48 kHz
});

test('mergeFmp4 refuses files it cannot join', async () => {
  const video = file(1, 'vide', 1000, 1000, [[0, 1, 'x']]);
  await assert.rejects(mergeFmp4(video, video), /can’t be merged/);
});
