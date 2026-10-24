export function httpUrl(value) {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}
// YouTube is off limits (Chrome Web Store policy), including embedded players and its video CDN.
export function isYouTube(url) {
  try { return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com)$/i.test(new URL(url).hostname); } catch { return false; }
}
// 'hls' for playlists, 'http' for direct video/audio files, null for everything else (incl. stream segments).
export function mediaKind(url, type = '') {
  let path; try { path = new URL(url).pathname; } catch { return null; }
  if (/\.m3u8$/i.test(path) || /mpegurl/i.test(type)) return 'hls';
  if (/\.(ts|m4s|aac)$/i.test(path) || /mp2t|iso\.segment|audio\/aac/i.test(type)) return null;
  if (/\.(mp4|m4v|webm|mov|mkv|mp3|m4a|ogg|oga|opus|wav|flac)$/i.test(path) || /^(video|audio)\//i.test(type)) return 'http';
  return null;
}
export function extOf(url) {
  try { return /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname)?.[1].toLowerCase() || 'mp4'; } catch { return 'mp4'; }
}
export function baseName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()).replace(/\.[^.]*$/, ''); } catch { return ''; }
}
// The file's own name from its URL, unless it's generic ("index", "master") or an ID/hash.
export function realName(url) {
  const name = baseName(url);
  if (/^(index|master|playlist|chunklist|manifest|video|audio|media|stream|file|download|play|init|main|source|output|default)$/i.test(name)) return '';
  if (!/\p{L}{3}/u.test(name) || (/^[\w-]{16,}$/.test(name) && /\d/.test(name))) return '';
  return name;
}
// Server-given name from a Content-Disposition header, without extension.
export function dispositionName(header = '') {
  const m = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header) || /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  try { return m ? decodeURIComponent(m[1].trim()).replace(/\.[^.]*$/, '') : ''; } catch { return m[1].trim().replace(/\.[^.]*$/, ''); }
}
// Page title without the site's name, e.g. "Pokéflix - Some Movie" on pokeflix.tv -> "Some Movie".
export function cleanTitle(title, pageUrl) {
  const plain = s => s.normalize('NFD').replace(/[^a-z0-9]/gi, '').toLowerCase();
  let site = ''; try { site = plain(new URL(pageUrl).hostname.replace(/^www\./, '').split('.')[0]); } catch {}
  const parts = (title || '').split(/\s+[-|–—•:]\s+/);
  const isSite = p => site.length > 2 && (plain(p) === site || plain(p).startsWith(site) && plain(p).length <= site.length + 6);
  if (parts.length > 1 && isSite(parts[0])) parts.shift();
  if (parts.length > 1 && isSite(parts.at(-1))) parts.pop();
  return parts.join(' - ').trim();
}
export function safeName(name, ext) {
  name = (name || 'video').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 150);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = 'video';
  return name.toLowerCase().endsWith('.' + ext) ? name : `${name}.${ext}`;
}
export function responseMedia(d) {
  if (d.tabId < 0 || d.method !== 'GET' || d.statusCode < 200 || d.statusCode >= 300) return null;
  const headers = Object.fromEntries((d.responseHeaders || []).map(h => [h.name.toLowerCase(), h.value || '']));
  if ([d.url, d.initiator, d.documentUrl].some(u => u && isYouTube(u))) return null;
  const url = httpUrl(d.url), kind = url && mediaKind(url, headers['content-type']);
  if (!kind) return null;
  const total = /\/(\d+)$/.exec(headers['content-range'] || '')?.[1];
  const size = Number(total || (d.statusCode === 206 ? 0 : headers['content-length'])) || 0;
  // shortcut: small XHR-loaded media is almost always a stream segment, not a whole file.
  if (kind === 'http' && d.type === 'xmlhttprequest' && size < 5e6) return null;
  return {url, kind, size, filename:dispositionName(headers['content-disposition'])};
}
export function parseM3u8(text, base) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist.');
  const abs = u => new URL(u, base).href;
  const attrs = s => Object.fromEntries([...s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(([, k, v]) => [k, v.replace(/^"|"$/g, '')]));
  const out = {variants: [], audio: [], segments: [], duration: 0, map: null};
  let stream = null, dur = 0, key = null, seq = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) stream = attrs(line.slice(18));
    else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) out.audio.push({url: abs(a.URI), group: a['GROUP-ID'], name: a.NAME || a.LANGUAGE || 'audio', default: a.DEFAULT === 'YES'});
    }
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) { const a = attrs(line.slice(11)); key = a.METHOD === 'NONE' ? null : {method: a.METHOD, url: a.URI && abs(a.URI), iv: a.IV}; }
    else if (line.startsWith('#EXT-X-MAP:')) out.map = abs(attrs(line.slice(11)).URI);
    else if (line.startsWith('#EXT-X-BYTERANGE')) throw new Error('Byte-range HLS playlists are not supported.');
    else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8)) || 0;
    else if (!line.startsWith('#')) {
      if (stream) out.variants.push({url: abs(line), bandwidth: Number(stream.BANDWIDTH) || 0, height: Number(stream.RESOLUTION?.split('x')[1]) || 0, audio: stream.AUDIO});
      else { out.duration += dur; out.segments.push({url: abs(line), key, seq: seq + out.segments.length}); }
      stream = null; dur = 0;
    }
  }
  out.variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return out;
}
