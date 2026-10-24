import {isYouTube} from './core.mjs';
const $ = id => document.getElementById(id);
let tab, items = [], jobs = {}, thumb = '', last = '', shotTried = false;
const choice = new Map(), audioChoice = new Map(); // picks per item, survive re-renders
async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({type, tabId:tab.id, ...extra});
  if (result?.error) throw new Error(result.error);
  return result;
}
const status = text => { $('status').textContent = text; };
const el = (tag, cls = '', text = '') => Object.assign(document.createElement(tag), {className:cls, textContent:text});
const time = s => [s / 3600, s % 3600 / 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');
const size = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + 'GB' : Math.max(1, Math.round(b / 1048576)) + 'MB';

function render() {
  const state = JSON.stringify([items, jobs, thumb]);
  if (state === last) return;
  last = state;
  $('count').textContent = items.length;
  $('empty').hidden = items.length > 0;
  $('items').replaceChildren(...items.map(card));
}
function card(item) {
  const sounds = items.filter(x => x.av?.audio && !x.av.video && x.av.frag);
  const job = jobs[item.url], busy = job?.state === 'downloading';
  const thumbBox = el('div', 'thumb');
  if (thumb) thumbBox.append(Object.assign(el('img'), {src:thumb, alt:'', onerror:useScreenshot}));
  const info = item.duration ? '⏱ ' + time(item.duration) : item.size ? size(item.size) : '';
  if (info) thumbBox.append(el('span', 'chip', info));

  const top = el('div', 'top'); top.title = item.url;
  const remove = el('button', 'x', '×'); remove.setAttribute('aria-label', 'Remove from list');
  remove.onclick = () => send('remove', {url:item.url}).catch(e => status(e.message));
  const label = item.av?.video && !item.av.audio ? 'VIDEO ONLY' : item.av?.audio && !item.av.video ? 'AUDIO' : '';
  top.append(el('span', 'tag', item.kind === 'hls' ? 'HLS' : 'HTTP'), el('span', 'name', item.name), remove);
  if (label) top.firstChild.after(el('span', 'tag only', label));

  const row = el('div', 'row');
  if (item.variants?.length) {
    const pick = el('select'); pick.setAttribute('aria-label', 'Quality');
    for (const v of item.variants) pick.append(new Option(v.height ? v.height + 'p' : Math.round(v.bandwidth / 1000) + ' kbps', v.url));
    pick.value = choice.get(item.url) || item.variants[0].url;
    pick.onchange = () => choice.set(item.url, pick.value);
    row.append(pick);
  } else if (item.av?.video && !item.av.audio && item.av.frag && sounds.length) {
    const pick = el('select'); pick.setAttribute('aria-label', 'Audio track');
    for (const s of sounds) pick.append(new Option(`+ Audio${s.size ? ' ' + size(s.size) : ''}`, s.url));
    pick.append(new Option('No audio', ''));
    pick.value = audioChoice.get(item.url) ?? sounds[0].url;
    pick.onchange = () => audioChoice.set(item.url, pick.value);
    row.append(pick);
  } else row.append(el('span', 'fmt', item.kind === 'hls' ? 'STREAM' : item.ext.toUpperCase()));
  const dl = el('button', 'dl', busy ? `${Math.floor(job.progress * 100)}%` : '⤓ Download');
  dl.disabled = busy;
  dl.onclick = async () => {
    dl.disabled = true;
    try {
      const audio = row.querySelector('select[aria-label="Audio track"]')?.value;
      await send('download', {url:item.url, variant:choice.get(item.url), audio});
      status(item.kind === 'hls' || audio ? 'Downloading stream… you can close this popup.' : 'Download started. See Chrome’s downloads.');
    } catch (e) { status(e.message); dl.disabled = false; }
  };
  row.append(dl);

  const body = el('div', 'body'); body.append(top, row);
  if (job) {
    const bar = el('div', 'bar'), fill = el('i'); fill.style.width = job.progress * 100 + '%'; bar.append(fill);
    body.append(bar);
    if (!busy) body.append(el('div', 'note ' + job.state, job.state === 'done' ? 'Saved to your Downloads folder' : job.error));
  }
  const c = el('article', 'card'); c.append(thumbBox, body);
  return c;
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
    const r = await send('scan'); items = r.items; thumb = r.thumb || thumb;
    status(items.length ? 'Pick a file to download.' : 'Nothing yet. Play the video, then reopen or press Scan.');
  } catch { status('Can’t scan this page. Open a regular website, reload it and play the video.'); }
  if (!thumb) await useScreenshot(); else render();
  $('scan').disabled = false;
}
$('scan').addEventListener('click', scan);
$('show-terms').addEventListener('click', e => { e.preventDefault(); showTerms(true); });
// Terms must be accepted once before the extension does anything.
function showTerms(on) { $('tos').hidden = !on; document.querySelector('main').hidden = on; document.querySelector('footer').hidden = on; $('terms-note').hidden = on; }
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
  ({items} = await send('list'));
  ({jobs = {}} = await chrome.storage.session.get('jobs'));
  render();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes[`tab:${tab.id}`]) items = changes[`tab:${tab.id}`].newValue || [];
    if (changes.jobs) jobs = changes.jobs.newValue || {};
    render();
  });
  await scan();
} catch (e) { status(e.message); $('scan').disabled = true; $('empty').hidden = true; }
