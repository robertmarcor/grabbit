import {isYouTube, httpUrl, mediaKind, extOf, baseName, realName, cleanTitle, safeName, responseMedia, parseM3u8} from './core.mjs';
import {probe} from './fmp4.mjs';
let queue = Promise.resolve();
function serial(fn) { const next = queue.then(fn); queue = next.catch(console.error); return next; }
const key = id => `tab:${id}`;
async function list(id) { return (await chrome.storage.session.get(key(id)))[key(id)] || []; }
async function badge(id, count) {
  try { await chrome.action.setBadgeText({tabId:id, text:count ? String(count) : ''});
    await chrome.action.setBadgeBackgroundColor({tabId:id, color:'#1a9be0'}); } catch {}
}
async function put(id, items) { await chrome.storage.session.set({[key(id)]:items}); await badge(id, items.length); }
// A URL already listed, or a quality/audio playlist of a listed HLS stream.
const known = (items, url) => items.some(x => x.url === url || x.variants?.some(v => v.url === url) || x.audio?.some(a => a.url === url));
async function add(id, fresh) {
  let items = await list(id);
  for (const item of fresh) {
    const old = items.find(x => x.url === item.url);
    if (old) { if (item.size) old.size = item.size; continue; }
    if (known(items, item.url)) continue;
    const children = new Set([...(item.variants || []), ...(item.audio || [])].map(v => v.url));
    items = items.filter(x => !children.has(x.url));
    if (items.length < 150) items.push(item);
  }
  await put(id, items);
}
async function setJob(url, job) {
  const {jobs = {}} = await chrome.storage.session.get('jobs');
  jobs[url] = {...jobs[url], ...job};
  await chrome.storage.session.set({jobs});
}
// Extension requests have no tab; make them look like they come from the video page (hotlink checks).
// shortcut: one shared rule, so two simultaneous downloads from different sites share the last page's Referer.
async function referer(id) {
  let page; try { page = httpUrl((await chrome.tabs.get(id)).url); } catch {}
  if (!page) return;
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[1], addRules:[{id:1, priority:1,
    action:{type:'modifyHeaders', requestHeaders:[{header:'referer', operation:'set', value:page}, {header:'origin', operation:'set', value:new URL(page).origin}]},
    condition:{tabIds:[chrome.tabs.TAB_ID_NONE], resourceTypes:['xmlhttprequest', 'other']}}]});
}
// Reads bytes [start, end) of a remote file without downloading the rest.
async function readRange(url, start, end) {
  const r = await fetch(url, {credentials:'include', headers:{Range:`bytes=${start}-${end - 1}`}});
  if (!r.ok || (start > 0 && r.status !== 206)) throw new Error('No range support.');
  const reader = r.body.getReader(), out = new Uint8Array(end - start);
  let n = 0;
  while (n < out.length) {
    const {done, value} = await reader.read();
    if (done) break;
    const take = value.subarray(0, out.length - n); out.set(take, n); n += take.length;
  }
  reader.cancel().catch(() => {});
  return out.subarray(0, n);
}
async function playlist(url) { return parseM3u8(await (await fetch(url, {credentials:'include'})).text(), url); }
async function describe(id, url, kind, size, filename = '') {
  let title = ''; try { const tab = await chrome.tabs.get(id); title = cleanTitle(tab.title, tab.url); } catch {}
  const item = {url, kind, size, name:filename || realName(url) || title || baseName(url) || 'video', ext:kind === 'hls' ? 'mp4' : extOf(url)};
  if (kind === 'hls') try {
    await referer(id);
    const pl = await playlist(url);
    item.duration = pl.duration;
    if (pl.variants.length) {
      item.variants = pl.variants; item.audio = pl.audio;
      item.duration = (await playlist(pl.variants[0].url)).duration;
    }
  } catch {} // still listed; the download will report the real error
  // Sites that split picture and sound serve two MP4s; find out which one this is.
  if (kind === 'http' && ['mp4', 'm4v', 'm4a', 'mov'].includes(item.ext)) try {
    await referer(id);
    item.av = await probe((s, e) => readRange(url, s, e));
  } catch {}
  return item;
}
async function detect(id, url, kind, size, filename) {
  const items = await list(id);
  if (known(items, url)) { if (size) serial(() => add(id, [{url, size}])); return; }
  const item = await describe(id, url, kind, size, filename);
  await serial(() => add(id, [item]));
}
async function ensureOffscreen() {
  try { await chrome.offscreen.createDocument({url:'offscreen.html', reasons:['BLOBS'], justification:'Join stream segments and video+audio tracks into one file.'}); }
  catch (e) { if (!/single offscreen/i.test(e.message)) throw e; }
}

chrome.webRequest.onBeforeRequest.addListener(d => {
  if (d.tabId >= 0) serial(async () => { await chrome.storage.session.remove(key(d.tabId)); await badge(d.tabId, 0); });
}, {urls:['http://*/*','https://*/*'], types:['main_frame']});
chrome.webRequest.onHeadersReceived.addListener(d => {
  const media = responseMedia(d);
  if (media) detect(d.tabId, media.url, media.kind, media.size, media.filename).catch(console.error);
}, {urls:['http://*/*','https://*/*']}, ['responseHeaders']);
chrome.tabs.onRemoved.addListener(id => serial(() => chrome.storage.session.remove(key(id))));
chrome.downloads.onChanged.addListener(async d => {
  if (!['complete', 'interrupted'].includes(d.state?.current)) return;
  const k = `blob:${d.id}`, {[k]:blobUrl} = await chrome.storage.session.get(k);
  if (!blobUrl) return;
  await chrome.storage.session.remove(k);
  chrome.runtime.sendMessage({type:'revoke', blobUrl}).catch(() => {});
});

async function handle({type, tabId:id, url, variant, audio}) {
  if (type === 'list') return {items:await list(id)};
  if (type === 'remove') { await serial(async () => put(id, (await list(id)).filter(x => x.url !== url))); return {}; }
  if (type === 'scan') {
    if (isYouTube((await chrome.tabs.get(id)).url)) return {items:[], thumb:''};
    const results = await chrome.scripting.executeScript({target:{tabId:id, allFrames:true}, func:scanPage});
    const have = await list(id);
    const urls = [...new Set(results.flatMap(r => r.result?.urls || []))].filter(u => mediaKind(u) && !known(have, u));
    const fresh = await Promise.all(urls.map(u => describe(id, u, mediaKind(u), 0)));
    await serial(() => add(id, fresh));
    const thumbs = results.map(r => r.result?.thumb).filter(Boolean);
    return {items:await list(id), thumb:thumbs.find(t => t.startsWith('data:')) || thumbs[0] || ''};
  }
  if (type === 'download') {
    const item = (await list(id)).find(x => x.url === url);
    if (!item) throw new Error('Video no longer listed. Scan the page again.');
    if (isYouTube(item.url) || isYouTube((await chrome.tabs.get(id)).url)) throw new Error('Grabbit doesn’t work on YouTube (Chrome Web Store policy).');
    await referer(id);
    if (item.kind === 'http' && audio) {
      const track = (await list(id)).find(x => x.url === audio);
      if (!track) throw new Error('Audio file no longer listed. Scan the page again.');
      await ensureOffscreen();
      await serial(() => setJob(item.url, {state:'downloading', progress:0, error:''}));
      await chrome.runtime.sendMessage({type:'merge-start', job:{key:item.url, videoUrl:item.url, audioUrl:track.url, name:item.name}});
      return {};
    }
    if (item.kind === 'http') {
      await chrome.downloads.download({url:item.url, filename:safeName(item.name, item.ext), conflictAction:'uniquify'});
      return {};
    }
    const v = item.variants?.find(x => x.url === variant) || item.variants?.[0];
    const tracks = item.audio?.filter(a => a.group === v?.audio) || [];
    const hlsAudio = tracks.find(a => a.default) || tracks[0];
    await ensureOffscreen();
    await serial(() => setJob(item.url, {state:'downloading', progress:0, error:''}));
    await chrome.runtime.sendMessage({type:'hls-start', job:{key:item.url, url:v?.url || item.url, audioUrl:hlsAudio?.url, name:item.name}});
    return {};
  }
  throw new Error('Unknown action.');
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (m.type === 'hls-progress') { serial(() => setJob(m.key, m.job)); return; }
  if (m.type === 'hls-save') {
    chrome.downloads.download({url:m.blobUrl, filename:safeName(m.name, m.ext), conflictAction:'uniquify'})
      .then(downloadId => chrome.storage.session.set({[`blob:${downloadId}`]:m.blobUrl}))
      .then(() => reply({}), e => reply({error:e.message}));
    return true;
  }
  if (!Number.isInteger(m.tabId)) return;
  handle(m).then(reply, e => reply({error:e.message}));
  return true;
});

// Runs inside the page: lists media URLs and grabs a thumbnail (current video frame, else poster / og:image).
function scanPage() {
  const found = new Set(), videos = [];
  const take = v => { try { const u = new URL(v, document.baseURI);
    if (/^https?:$/.test(u.protocol) && /\.(m3u8|mp4|m4v|webm|mov|mkv|mp3|m4a|ogg|opus|wav|flac)$/i.test(u.pathname)) found.add(u.href); } catch {} };
  function visit(root) {
    for (const el of root.querySelectorAll('video, audio, video source, audio source, a[href], [data-src]')) take(el.currentSrc || el.src || el.href || el.getAttribute('data-src'));
    videos.push(...root.querySelectorAll('video'));
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
  }
  visit(document);
  for (const r of performance.getEntriesByType('resource')) take(r.name);
  let thumb = '';
  const v = videos.filter(v => v.readyState >= 2 && v.videoWidth).sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
  if (v) try {
    const c = document.createElement('canvas'); c.width = 320; c.height = Math.round(320 * v.videoHeight / v.videoWidth);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); thumb = c.toDataURL('image/jpeg', .7);
  } catch {} // cross-origin video taints the canvas
  const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content;
  thumb ||= videos.find(v => v.poster)?.poster || (og ? new URL(og, document.baseURI).href : '');
  return {urls:[...found].slice(0, 150), thumb};
}
