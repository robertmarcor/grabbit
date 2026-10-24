import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32, zip} from './zip.mjs';

const enc = s => new TextEncoder().encode(s);
test('crc32 matches the standard check value, also when fed in chunks', () => {
  assert.equal(crc32(enc('123456789')), 0xcbf43926);
  assert.equal(crc32(enc('56789'), crc32(enc('1234'))), 0xcbf43926);
});

test('zip stores files with unique UTF-8 names', async () => {
  const file = s => ({name:'a.txt', blob:new Blob([s]), crc:crc32(enc(s))});
  const out = new Uint8Array(await zip([file('one'), file('two'), {...file('é'), name:'Pokémon.png'}]).arrayBuffer());
  const text = new TextDecoder().decode(out);
  assert.ok(text.includes('a.txt') && text.includes('a (2).txt') && text.includes('Pokémon.png'));
  const end = new DataView(out.buffer, out.length - 22);
  assert.equal(end.getUint32(0, true), 0x06054b50);
  assert.equal(end.getUint16(10, true), 3);
});
