import {isYouTube} from './core.mjs';
const $ = id => document.getElementById(id);
let tab, media = [], images = [], fonts = [], jobs = {}, thumb = '', cat = 'videos', last = '', shotTried = false;
const choice = new Map(), audioChoice = new Map(), picked = new Set(); // survive re-renders
const EMPTY = {
  videos:'No videos yet. Play the video on the page; streams and video files show up here as they load.',
  audio:'No audio files found on this page.', images:'No images found on this page.', fonts:'No web fonts found on this page.',
};
async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({type, tabId:tab.id, ...extra});
  if (result?.error) throw new Error(result.error);
  return result;
}
const status = text => { $('status').textContent = text; };
const el = (tag, cls = '', text = '') => Object.assign(document.createElement(tag), {className:cls, textContent:text});
const time = s => [s / 3600, s % 3600 / 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');
const size = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 ? Math.round(b / 1048576) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isAudio = m => m.av ? m.av.audio && !m.av.video : /^(mp3|m4a|ogg|oga|opus|wav|flac|aac)$/.test(m.ext);
const sounds = () => media.filter(x => x.av?.audio && !x.av.video && x.av.frag);
const lists = () => ({videos:media.filter(m => !isAudio(m)), audio:media.filter(isAudio), images, fonts});
// "Largest": file size, else stream length, else pixels (full-size images of unknown size rank high).
const weight = x => x.size || (x.duration || 0) * 1e5 || (x.w || 0) * (x.h || 0) || (x.upgraded ? 4e6 : 0);
function visible() {
  const q = $('search').value.trim().toLowerCase(), sort = $('sort').value;
  const order = sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : sort === 'smallest' ? (a, b) => weight(a) - weight(b) : (a, b) => weight(b) - weight(a);
  return lists()[cat].filter(x => !q || `${x.name} ${x.url}`.toLowerCase().includes(q)).sort(order);
}

function render() {
  const shown = visible();
  const state = JSON.stringify([media, images, fonts, jobs, thumb, cat, [...picked], $('search').value, $('sort').value]);
  if (state === last) return;
  last = state;
  const all = lists();
  for (const b of $('tabs').children) {
    b.setAttribute('aria-selected', b.dataset.cat === cat);
    b.querySelector('span').textContent = all[b.dataset.cat].length;
  }
  $('items').replaceChildren(...shown.map(row));
  $('empty').hidden = shown.length > 0;
  $('empty-text').textContent = EMPTY[cat];
  const sel = shown.filter(x => picked.has(x.url)).length;
  $('all').checked = sel > 0 && sel === shown.length;
  $('all').indeterminate = sel > 0 && sel < shown.length;
  $('grab-selected').disabled = !sel;
  $('grab-selected').textContent = sel ? `⤓ Grab ${sel}` : 'Grab selected';
  const z = jobs[`zip:${tab?.id}`], zipping = z?.state === 'downloading';
  $('zip').disabled = !sel || zipping;
  $('zip').textContent = zipping ? `ZIP ${Math.floor(z.progress * 100)}%` : 'ZIP';
  if (z?.state === 'error') status('ZIP failed: ' + z.error);
}

function row(x) {
  const job = jobs[x.url], busy = job?.state === 'downloading';
  const r = el('article', 'item'); r.title = x.url;
  const box = Object.assign(el('input'), {type:'checkbox', checked:picked.has(x.url)});
  box.setAttribute('aria-label', 'Select ' + x.name);
  box.onchange = () => { box.checked ? picked.add(x.url) : picked.delete(x.url); render(); };

  const th = el('div', 'thumb ' + cat);
  const src = cat === 'images' ? x.preview : cat === 'videos' ? thumb : '';
  if (src) th.append(Object.assign(el('img'), {src, alt:'', loading:'lazy', onerror:cat === 'videos' ? useScreenshot : () => { th.textContent = '▣'; }}));
  else th.textContent = {videos:'▶', audio:'♪', images:'▣', fonts:'Aa'}[cat];

  const info = el('div', 'info'), meta = el('div', 'meta');
  meta.append(el('span', 'tag', x.kind === 'hls' ? 'HLS' : (x.ext || '?').toUpperCase()));
  if (x.av?.video && !x.av.audio) meta.append(el('span', 'tag only', 'VIDEO ONLY'));
  const facts = [x.duration && time(x.duration), x.w && x.h && `${x.w}×${x.h}`, x.size && size(x.size), x.upgraded && !x.w && 'full size', host(x.url)];
  meta.append(facts.filter(Boolean).join(' · '));
  info.append(el('div', 'name', x.name), meta);

  let pick = el('span');
  if (x.variants?.length) {
    pick = el('select'); pick.setAttribute('aria-label', 'Quality');
    for (const v of x.variants) pick.append(new Option(v.height ? v.height + 'p' : Math.round(v.bandwidth / 1000) + ' kbps', v.url));
    pick.value = choice.get(x.url) || x.variants[0].url;
    pick.onchange = () => choice.set(x.url, pick.value);
  } else if (x.av?.video && !x.av.audio && x.av.frag && sounds().length) {
    pick = el('select'); pick.setAttribute('aria-label', 'Audio track');
    for (const s of sounds()) pick.append(new Option(`+ Audio${s.size ? ' ' + size(s.size) : ''}`, s.url));
    pick.append(new Option('No audio', ''));
    pick.value = audioChoice.get(x.url) ?? sounds()[0].url;
    pick.onchange = () => audioChoice.set(x.url, pick.value);
  }
  const btn = el('button', 'grab', busy ? `${Math.floor(job.progress * 100)}%` : '⤓ Grab');
  btn.disabled = busy;
  btn.onclick = async () => {
    btn.disabled = true;
    try { await grab(x); status(x.kind === 'hls' || pick.getAttribute('aria-label') === 'Audio track' ? 'Downloading… you can close this popup.' : 'Download started. See Chrome’s downloads.'); }
    catch (e) { status(e.message); btn.disabled = false; }
  };
  r.append(box, th, info, pick, btn);
  if (job) {
    const p = el('div', 'progress'), bar = el('div', 'bar'), fill = el('i');
    fill.style.width = job.progress * 100 + '%'; bar.append(fill); p.append(bar);
    if (!busy) p.append(el('div', 'note ' + job.state, job.state === 'done' ? 'Saved to your Downloads folder' : job.error));
    r.append(p);
  }
  return r;
}

async function grab(x) {
  if (!media.includes(x)) return send('grab-url', {url:x.url, name:x.name});
  const audio = x.av?.video && !x.av.audio && x.av.frag ? audioChoice.get(x.url) ?? sounds()[0]?.url : undefined;
  return send('download', {url:x.url, variant:choice.get(x.url), audio});
}
async function grabSelected() {
  const chosen = visible().filter(x => picked.has(x.url));
  $('grab-selected').disabled = true;
  let failed = 0;
  for (const [i, x] of chosen.entries()) {
    status(`Grabbing ${i + 1} of ${chosen.length}…`);
    try { await grab(x); picked.delete(x.url); } catch { failed++; }
  }
  status(failed ? `${failed} of ${chosen.length} couldn’t be grabbed.` : `Started ${chosen.length} downloads. See Chrome’s downloads.`);
  render();
}

// Plain files go into one .zip; streams and video+audio merges can't, so they're grabbed as separate files.
const needsBuild = x => x.kind === 'hls' || (x.av?.video && !x.av.audio && x.av.frag && (audioChoice.get(x.url) ?? sounds()[0]?.url));
async function zipSelected() {
  const chosen = visible().filter(x => picked.has(x.url)), plain = chosen.filter(x => !needsBuild(x)), built = chosen.filter(needsBuild);
  $('zip').disabled = true;
  try {
    if (plain.length) await send('zip', {files:plain.map(x => ({url:x.url, name:x.name, ext:x.ext}))});
    for (const x of built) await grab(x);
    for (const x of chosen) picked.delete(x.url);
    status(built.length ? `Zipping ${plain.length} files; ${built.length} stream(s) download separately.` : `Zipping ${plain.length} files… you can close this popup.`);
  } catch (e) { status(e.message); }
  render();
}

// Last resort when the page gives no usable picture (or its image won't load here): a screenshot of the tab.
async function useScreenshot() {
  if (shotTried) return;
  shotTried = true;
  try { thumb = await chrome.tabs.captureVisibleTab(tab.windowId, {format:'jpeg', quality:50}); }
  catch (e) { thumb = ''; console.warn('Thumbnail screenshot failed:', e.message); }
  render();
}
async function scan() {
  $('scan').disabled = true;
  try {
    const r = await send('scan');
    ({items:media, images, fonts} = r); thumb = r.thumb || thumb;
    status(media.length + images.length ? 'Pick what to grab.' : 'Nothing yet. Play the video, then press Scan.');
  } catch { status('Can’t scan this page. Open a regular website, reload it and play the video.'); }
  if (!thumb) await useScreenshot(); else render();
  $('scan').disabled = false;
}

$('scan').onclick = scan;
$('clear').onclick = async () => { await send('clear').catch(e => status(e.message)); images = []; fonts = []; picked.clear(); render(); };
for (const b of $('tabs').children) b.onclick = () => { cat = b.dataset.cat; render(); };
$('search').oninput = $('sort').onchange = render;
$('all').onchange = () => { for (const x of visible()) $('all').checked ? picked.add(x.url) : picked.delete(x.url); render(); };
$('grab-selected').onclick = grabSelected;
$('zip').onclick = zipSelected;
for (const id of ['show-terms', 'terms-link']) $(id).onclick = e => { e.preventDefault(); showTerms(true); };
// Terms must be accepted once before the extension does anything.
function showTerms(on) { $('tos').hidden = !on; $('app').hidden = on; }
const {tosAccepted} = await chrome.storage.local.get('tosAccepted');
if (!tosAccepted) {
  showTerms(true);
  await new Promise(done => $('agree').addEventListener('click', done, {once:true}));
  await chrome.storage.local.set({tosAccepted:new Date().toISOString()});
}
$('agree').onclick = () => showTerms(false);
showTerms(false);
try {
  [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if (isYouTube(tab.url)) throw new Error('Grabbit doesn’t work on YouTube (Chrome Web Store policy).');
  ({items:media} = await send('list'));
  ({jobs = {}} = await chrome.storage.session.get('jobs'));
  render();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes[`tab:${tab.id}`]) media = changes[`tab:${tab.id}`].newValue || [];
    if (changes.jobs) jobs = changes.jobs.newValue || {};
    render();
  });
  await scan();
} catch (e) { status(e.message); for (const id of ['scan', 'clear', 'all']) $(id).disabled = true; $('empty').hidden = true; }
