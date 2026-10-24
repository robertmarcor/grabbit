// Minimal ZIP writer. Files are stored, not compressed: images, video and fonts are already compressed.
const table = Array.from({length:256}, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
// Pass the previous result as `crc` to continue over the next chunk.
export function crc32(bytes, crc = 0) {
  crc = ~crc;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}
// files: [{name, blob, crc}] -> one .zip Blob.
export function zip(files, date = new Date()) {
  const time = date.getHours() << 11 | date.getMinutes() << 5 | date.getSeconds() >> 1;
  const day = (date.getFullYear() - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate();
  const parts = [], central = [], used = new Set();
  let offset = 0;
  for (const f of files) {
    let name = f.name;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = f.name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
    used.add(name.toLowerCase());
    const bytes = new TextEncoder().encode(name);
    if (offset + f.blob.size > 0xfffffffe) throw new Error('ZIP files are limited to 4 GB. Select fewer files.');
    const head = (sig, extra) => {
      const b = new Uint8Array(extra + bytes.length), d = new DataView(b.buffer);
      d.setUint32(0, sig, true);
      return {b, d};
    };
    const local = head(0x04034b50, 30);
    // version 2.0, UTF-8 names, stored, time, date, crc, sizes, name length
    [[4, 20], [6, 0x800], [8, 0], [10, time], [12, day], [26, bytes.length]].forEach(([o, v]) => local.d.setUint16(o, v, true));
    [[14, f.crc], [18, f.blob.size], [22, f.blob.size]].forEach(([o, v]) => local.d.setUint32(o, v, true));
    local.b.set(bytes, 30);
    const dir = head(0x02014b50, 46);
    [[4, 20], [6, 20], [8, 0x800], [10, 0], [12, time], [14, day], [28, bytes.length]].forEach(([o, v]) => dir.d.setUint16(o, v, true));
    [[16, f.crc], [20, f.blob.size], [24, f.blob.size], [42, offset]].forEach(([o, v]) => dir.d.setUint32(o, v, true));
    dir.b.set(bytes, 46);
    parts.push(local.b, f.blob);
    central.push(dir.b);
    offset += local.b.length + f.blob.size;
  }
  const size = central.reduce((n, b) => n + b.length, 0), end = new Uint8Array(22), d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, files.length, true); d.setUint16(10, files.length, true);
  d.setUint32(12, size, true); d.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], {type:'application/zip'});
}
