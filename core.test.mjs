import test from 'node:test';
import assert from 'node:assert/strict';
import {isYouTube, mediaKind, safeName, responseMedia, parseM3u8, realName, dispositionName, cleanTitle} from './core.mjs';

test('mediaKind', () => {
  assert.equal(mediaKind('https://a.com/x/master.m3u8?t=1'), 'hls');
  assert.equal(mediaKind('https://a.com/play', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(mediaKind('https://a.com/movie.mp4'), 'http');
  assert.equal(mediaKind('https://a.com/song.mp3'), 'http');
  assert.equal(mediaKind('https://a.com/seg1.ts', 'video/mp2t'), null);
  assert.equal(mediaKind('https://a.com/page.html', 'text/html'), null);
});

test('YouTube is blocked, including embeds and its CDN', () => {
  for (const u of ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://m.youtube.com/', 'https://www.youtube-nocookie.com/embed/x', 'https://rr1---sn-abc.googlevideo.com/videoplayback?x=1'])
    assert.equal(isYouTube(u), true, u);
  assert.equal(isYouTube('https://notyoutube.com/'), false);
  assert.equal(responseMedia({tabId:1, method:'GET', statusCode:200, type:'media', url:'https://cdn.com/v.mp4', initiator:'https://www.youtube.com', responseHeaders:[]}), null);
});

test('safeName', () => {
  assert.equal(safeName('Movie: Part 1', 'mp4'), 'Movie_ Part 1.mp4');
  assert.equal(safeName('Clip.mp4', 'mp4'), 'Clip.mp4');
  assert.equal(safeName('con', 'ts'), 'video.ts');
});

test('file naming prefers the real file name, else the title without the site name', () => {
  assert.equal(realName('https://cdn.com/movies/Diancie%20and%20the%20Cocoon.mp4'), 'Diancie and the Cocoon');
  assert.equal(realName('https://cdn.com/hls/master.m3u8'), '');
  assert.equal(realName('https://cdn.com/v/3f9a8c7b6d5e4f3a2b1c.mp4'), '');
  assert.equal(realName('https://cdn.com/v/123456.mp4'), '');
  assert.equal(dispositionName('attachment; filename="My Clip.mp4"'), 'My Clip');
  assert.equal(dispositionName("attachment; filename*=UTF-8''Pok%C3%A9mon.mp4"), 'Pokémon');
  assert.equal(cleanTitle('Pokéflix - Pokémon Movie - Diancie and the Cocoon of Destruction', 'https://www.pokeflix.tv/v/1'),
    'Pokémon Movie - Diancie and the Cocoon of Destruction');
  assert.equal(cleanTitle('Some Video | VidSite', 'https://vidsite.com/x'), 'Some Video');
  assert.equal(cleanTitle('Some Video - Part 2', 'https://other.com/x'), 'Some Video - Part 2');
});

test('responseMedia skips small XHR segments but keeps real files', () => {
  const base = {tabId:1, method:'GET', statusCode:200, url:'https://cdn.com/v.mp4'};
  assert.equal(responseMedia({...base, type:'xmlhttprequest', responseHeaders:[{name:'Content-Length', value:'90000'}]}), null);
  assert.deepEqual(responseMedia({...base, type:'media', statusCode:206, responseHeaders:[{name:'content-range', value:'bytes 0-1/1000000000'}]}),
    {url:'https://cdn.com/v.mp4', kind:'http', size:1000000000, filename:''});
});

test('parseM3u8 master', () => {
  const pl = parseM3u8(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"
1080/index.m3u8`, 'https://cdn.com/hls/master.m3u8');
  assert.deepEqual(pl.variants.map(v => v.height), [1080, 360]);
  assert.equal(pl.variants[0].url, 'https://cdn.com/hls/1080/index.m3u8');
  assert.deepEqual(pl.audio, [{url:'https://cdn.com/hls/audio/en.m3u8', group:'aud', name:'English', default:true}]);
});

test('parseM3u8 media with key and map', () => {
  const pl = parseM3u8(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01
#EXTINF:4.0,
s0.m4s
#EXTINF:2.5,
s1.m4s
#EXT-X-ENDLIST`, 'https://cdn.com/v/p.m3u8');
  assert.equal(pl.duration, 6.5);
  assert.equal(pl.map, 'https://cdn.com/v/init.mp4');
  assert.deepEqual(pl.segments.map(s => s.seq), [5, 6]);
  assert.deepEqual(pl.segments[1].key, {method:'AES-128', url:'https://cdn.com/v/key.bin', iv:'0x01'});
  assert.throws(() => parseM3u8('<html>', 'https://x.com/'), /Not an HLS/);
});
