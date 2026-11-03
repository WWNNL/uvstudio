'use strict';

// Tests for the Chinese atlas page (js/cn-fonts.js).
// Uses the real release atlases in ../../../dist so a malformed rebuild is caught here
// before it can ever reach a radio.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const cn = require('../js/cn-fonts.js');

const DIST = path.resolve(__dirname, '..', '..', '..', 'dist');
const UI_FILE = path.join(DIST, 'cn_font.bin');
const NAME_FILE = path.join(DIST, 'name_font.bin');

const uiImage = new Uint8Array(fs.readFileSync(UI_FILE));
const nameImage = new Uint8Array(fs.readFileSync(NAME_FILE));

// A minimal 2 MiB external-flash model wired to the same op API flash.js provides.
function fakeFlash(image) {
  const mem = new Uint8Array(2 * 1024 * 1024);
  mem.fill(0xFF);
  if (image) mem.set(image, 0);
  const stats = { erases: 0, writes: 0, reads: 0, dropWrites: false };
  return {
    mem,
    stats,
    async read(address, length) {
      stats.reads += 1;
      assert.ok(address + length <= mem.length, 'read beyond flash');
      return mem.slice(address, address + length);
    },
    async erase(address) {
      stats.erases += 1;
      assert.equal(address % 0x1000, 0, 'erase is not sector aligned');
      mem.fill(0xFF, address, address + 0x1000);
    },
    async write(address, data) {
      stats.writes += 1;
      assert.ok(data.length <= 128, 'chunk larger than 128 B');
      if (stats.dropWrites) return;              // simulate a write the chip ignored
      mem.set(data, address);
    },
    async crc32(address, length) {
      return cn.crc32(mem.subarray(address, address + length));
    },
    crcSupported: true,
    log() {},
    progress() {}
  };
}

test('parses the real UI atlas (FCN1)', () => {
  const atlas = cn.parseAtlas(uiImage);
  assert.equal(atlas.kind, 'ui');
  assert.equal(atlas.version, 1);
  assert.equal(atlas.count, 312);
  assert.equal(atlas.bytes, uiImage.length);
  assert.equal(atlas.base, 0x162000);
  assert.equal(atlas.glyphCrc, new DataView(uiImage.buffer, uiImage.byteOffset).getUint32(12, true));
});

test('parses the real channel-name atlas (FCN2)', () => {
  const atlas = cn.parseAtlas(nameImage);
  assert.equal(atlas.kind, 'name');
  assert.equal(atlas.version, 1);
  assert.equal(atlas.count, 6647);
  assert.equal(atlas.bytes, nameImage.length);
  assert.equal(atlas.base, 0x180000);
});

test('sector plans cover both images exactly', () => {
  const ui = cn.planSectors(cn.UI_BASE, uiImage.length);
  assert.equal(ui.length, 3);
  assert.equal(ui[0].address, 0x162000);
  assert.equal(ui[0].bytes, 0x1000);
  assert.equal(ui[2].address, 0x164000);
  assert.equal(ui[2].bytes, uiImage.length - 2 * 0x1000);
  assert.equal(ui.reduce((sum, s) => sum + s.bytes, 0), uiImage.length);

  const name = cn.planSectors(cn.NAME_BASE, nameImage.length);
  assert.equal(name.length, 59);
  assert.equal(name[0].address, 0x180000);
  assert.equal(name[58].address, 0x180000 + 58 * 0x1000);
  assert.equal(name.reduce((sum, s) => sum + s.bytes, 0), nameImage.length);
});

test('rejects a tampered UI atlas', () => {
  const bad = Uint8Array.from(uiImage);
  bad[64 + 100] ^= 0xFF;                        // flip a bitmap byte
  assert.throws(() => cn.parseAtlas(bad), /glyph CRC/i);
});

test('rejects a tampered name atlas (index and glyphs are both checksummed)', () => {
  const badIndex = Uint8Array.from(nameImage);
  badIndex[64 + 12] ^= 0x01;
  assert.throws(() => cn.parseAtlas(badIndex), /index CRC/i);

  const badGlyph = Uint8Array.from(nameImage);
  badGlyph[badGlyph.length - 5] ^= 0x01;
  assert.throws(() => cn.parseAtlas(badGlyph), /glyph CRC/i);
});

test('rejects wrong sizes, geometry and magic', () => {
  assert.throws(() => cn.parseAtlas(uiImage.subarray(0, 1000)), /size/i);
  assert.throws(() => cn.parseAtlas(uiImage.subarray(0, 32)), /too short/i);

  const badGeometry = Uint8Array.from(uiImage);
  badGeometry[8] = 12;                          // columns must be 16
  assert.throws(() => cn.parseAtlas(badGeometry), /geometry/i);

  const badMagic = new Uint8Array(64);
  assert.throws(() => cn.parseAtlas(badMagic), /neither FCN1 nor FCN2/i);
});

test('writes the UI atlas into erased flash and verifies every byte', async () => {
  const radio = fakeFlash();
  const atlas = Object.assign(cn.parseAtlas(uiImage), { data: uiImage });
  await cn.flashAtlas(radio, atlas);

  assert.equal(radio.stats.erases, 3);
  assert.equal(radio.stats.writes, Math.ceil(uiImage.length / cn.FLASH_CHUNK));
  assert.deepEqual(radio.mem.slice(cn.UI_BASE, cn.UI_BASE + uiImage.length), uiImage);
  // Everything outside the atlas must stay untouched.
  assert.equal(radio.mem[cn.UI_BASE - 1], 0xFF);
  assert.equal(radio.mem[cn.UI_BASE + 3 * 0x1000], 0xFF);
});

test('skips sectors that already hold the right bytes', async () => {
  const radio = fakeFlash();
  const atlas = Object.assign(cn.parseAtlas(uiImage), { data: uiImage });
  await cn.flashAtlas(radio, atlas);
  const erases = radio.stats.erases;
  const writes = radio.stats.writes;
  await cn.flashAtlas(radio, atlas);            // second run: nothing to do
  assert.equal(radio.stats.erases, erases);
  assert.equal(radio.stats.writes, writes);
});

test('detects a write the chip silently dropped', async () => {
  const radio = fakeFlash();
  radio.stats.dropWrites = true;
  const atlas = Object.assign(cn.parseAtlas(uiImage), { data: uiImage });
  await assert.rejects(() => cn.flashAtlas(radio, atlas), /verify failed at 0x00162000/);
});

test('writes the channel-name atlas to 0x180000 in 59 sectors', async () => {
  const radio = fakeFlash();
  const atlas = Object.assign(cn.parseAtlas(nameImage), { data: nameImage });
  await cn.flashAtlas(radio, atlas);

  assert.equal(radio.stats.erases, 59);
  assert.deepEqual(radio.mem.slice(cn.NAME_BASE, cn.NAME_BASE + nameImage.length), nameImage);
  assert.equal(radio.mem[cn.NAME_BASE - 1], 0xFF);
  // The UI atlas base must be untouched by a name-atlas write.
  assert.equal(radio.mem[cn.UI_BASE], 0xFF);
});

test('reads atlas headers from the radio, including blank and unknown magic', async () => {
  const radio = fakeFlash();

  const blank = await cn.readAtlasHeaders(radio);
  assert.deepEqual(blank.ui, { present: false, blank: true });

  radio.mem.set(uiImage.slice(0, 64), cn.UI_BASE);
  radio.mem.set(nameImage.slice(0, 64), cn.NAME_BASE);
  const both = await cn.readAtlasHeaders(radio);
  assert.equal(both.ui.present, true);
  assert.equal(both.ui.magic, 'FCN1');
  assert.equal(both.ui.count, 312);
  assert.equal(both.name.present, true);
  assert.equal(both.name.magic, 'FCN2');
  assert.equal(both.name.count, 6647);

  radio.mem[cn.NAME_BASE + 1] = 0x00;           // break the FCN2 magic
  const broken = await cn.readAtlasHeaders(radio);
  assert.equal(broken.name.present, false);
  assert.match(broken.name.error, /magic/i);
});
