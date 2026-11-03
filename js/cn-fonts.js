/* UV Studio — Chinese atlas panel (CN firmware add-on).
 *
 * Flashes the two Chinese font atlases used by the F4HWN Labs / FusionRW Chinese
 * firmware into the radio's external SPI flash (PY25Q16, 2 MiB):
 *
 *   0x162000  cn_font.bin   "FCN1"  UI atlas: 312 glyphs (218 CJK + 94 ASCII)
 *   0x180000  name_font.bin "FCN2"  channel-name atlas: GB2312, 6,647 glyphs
 *
 * The raw external-flash commands (0x0738/0x073A/0x073C/0x073E) only exist in
 * firmware built with ENABLE_FEAT_F4HWN_EXT_FLASH_RW (Labs, FusionRW). On a plain
 * Fusion build the support probe fails and the panel says so.
 *
 * Pure helpers are exported for the Node tests; the DOM wiring only runs in a page.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.UVStudioCnFonts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UI_BASE = 0x162000;
  const NAME_BASE = 0x180000;
  const HEADER_SIZE = 64;
  const GLYPH_SIZE = 32;
  const SECTOR = 0x1000;
  const FLASH_CHUNK = 128;
  const MAGIC_FCN1 = 0x314E4346;   // "FCN1"
  const MAGIC_FCN2 = 0x324E4346;   // "FCN2"

  // CRC-32 (IEEE 802.3, same polynomial and initial value as Python's zlib.crc32).
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function hex(value, digits = 8) {
    return '0x' + value.toString(16).toUpperCase().padStart(digits, '0');
  }

  // Parse and fully validate an atlas image. Returns
  // { kind, base, magic, version, count, bytes, glyphCrc } or throws with a reason.
  function parseAtlas(buffer) {
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (data.length < HEADER_SIZE) throw new Error('file too short for an atlas header (need 64 B)');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = view.getUint32(0, true);

    if (magic === MAGIC_FCN1) {
      const version = view.getUint16(4, true);
      const count = view.getUint16(6, true);
      const columns = data[8];
      const pages = data[9];
      const glyphSize = data[10];
      const glyphCrc = view.getUint32(12, true);
      if (version !== 1) throw new Error(`unknown FCN1 version ${version}`);
      if (columns !== 16 || pages !== 2 || glyphSize !== GLYPH_SIZE) {
        throw new Error(`unexpected FCN1 geometry ${columns}x${pages} pages, ${glyphSize} B/glyph`);
      }
      const expected = HEADER_SIZE + count * GLYPH_SIZE;
      if (data.length !== expected) throw new Error(`FCN1 size ${data.length} B, header says ${expected} B`);
      const actualCrc = crc32(data.subarray(HEADER_SIZE));
      if (actualCrc !== glyphCrc) {
        throw new Error(`FCN1 glyph CRC ${hex(actualCrc)} does not match the header ${hex(glyphCrc)}`);
      }
      return { kind: 'ui', base: UI_BASE, magic, version, count, bytes: data.length, glyphCrc };
    }

    if (magic === MAGIC_FCN2) {
      const version = view.getUint16(4, true);
      const count = view.getUint16(6, true);
      const indexEntry = view.getUint16(8, true);
      const columns = data[10];
      const pages = data[11];
      const glyphSize = data[12];
      const indexOffset = view.getUint32(16, true);
      const glyphOffset = view.getUint32(20, true);
      const indexCrc = view.getUint32(24, true);
      const glyphCrc = view.getUint32(28, true);
      if (version !== 1) throw new Error(`unknown FCN2 version ${version}`);
      if (indexEntry !== 4) throw new Error(`unexpected FCN2 index entry size ${indexEntry}`);
      if (columns !== 16 || pages !== 2 || glyphSize !== GLYPH_SIZE) {
        throw new Error(`unexpected FCN2 geometry ${columns}x${pages} pages, ${glyphSize} B/glyph`);
      }
      if (indexOffset !== HEADER_SIZE) throw new Error(`FCN2 index offset ${indexOffset} != 64`);
      if (glyphOffset !== indexOffset + count * indexEntry) {
        throw new Error(`FCN2 glyph offset ${glyphOffset} does not follow the index`);
      }
      const expected = glyphOffset + count * GLYPH_SIZE;
      if (data.length !== expected) throw new Error(`FCN2 size ${data.length} B, header says ${expected} B`);
      const actualIndexCrc = crc32(data.subarray(indexOffset, glyphOffset));
      if (actualIndexCrc !== indexCrc) {
        throw new Error(`FCN2 index CRC ${hex(actualIndexCrc)} does not match the header ${hex(indexCrc)}`);
      }
      const actualGlyphCrc = crc32(data.subarray(glyphOffset));
      if (actualGlyphCrc !== glyphCrc) {
        throw new Error(`FCN2 glyph CRC ${hex(actualGlyphCrc)} does not match the header ${hex(glyphCrc)}`);
      }
      return { kind: 'name', base: NAME_BASE, magic, version, count, bytes: data.length, glyphCrc };
    }

    throw new Error(`not a Chinese atlas (magic ${hex(magic)} is neither FCN1 nor FCN2)`);
  }

  function baseForKind(kind) {
    if (kind === 'ui') return UI_BASE;
    if (kind === 'name') return NAME_BASE;
    throw new Error(`unknown atlas kind "${kind}"`);
  }

  function sectorCount(bytes) {
    return Math.ceil(bytes / SECTOR);
  }

  // Split the image into 4 KiB sectors; the last one is short.
  function planSectors(base, length) {
    if (base % SECTOR !== 0) throw new Error('atlas base must be 4 KiB aligned');
    const sectors = [];
    for (let offset = 0; offset < length; offset += SECTOR) {
      sectors.push({ address: base + offset, bytes: Math.min(SECTOR, length - offset) });
    }
    return sectors;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  async function readChunked(op, address, length) {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += FLASH_CHUNK) {
      const size = Math.min(FLASH_CHUNK, length - offset);
      out.set(await op.read(address + offset, size), offset);
    }
    return out;
  }

  // Erase / write / verify one atlas image. `onProgress(fraction)` is called per sector.
  async function flashAtlas(op, atlas, onProgress = () => {}) {
    if (!atlas || !atlas.kind || !atlas.data) throw new Error('no atlas image to write');
    const data = atlas.data;
    const base = atlas.base ?? baseForKind(atlas.kind);
    const sectors = planSectors(base, data.length);
    const log = op.log || (() => {});

    log(`atlas ${atlas.kind}: ${data.length} B at ${hex(base)} (${sectors.length} sector(s))`, 'info');

    for (let s = 0; s < sectors.length; s++) {
      const sector = sectors[s];
      const address = sector.address;
      const expected = data.subarray(s * SECTOR, s * SECTOR + sector.bytes);

      let unchanged = false;
      try {
        unchanged = sameBytes(await readChunked(op, address, sector.bytes), expected);
      } catch {
        unchanged = false;   // unreadable (blank chip / timeout): erase anyway
      }
      if (unchanged) {
        log(`sector ${hex(address)} already matches, skipped`, 'info');
        onProgress((s + 1) / sectors.length);
        continue;
      }

      await op.erase(address);
      for (let offset = 0; offset < sector.bytes; offset += FLASH_CHUNK) {
        const size = Math.min(FLASH_CHUNK, sector.bytes - offset);
        await op.write(address + offset, expected.subarray(offset, offset + size));
      }

      // Read back every byte: a dropped write or a locked chip still answers the
      // command, so verifying the contents is the only reliable check.
      const back = await readChunked(op, address, sector.bytes);
      if (!sameBytes(back, expected)) {
        let bad = 0;
        while (bad < expected.length && back[bad] === expected[bad]) bad++;
        throw new Error(`verify failed at ${hex(address + bad)} (sector ${s + 1}/${sectors.length})`);
      }

      if (op.crcSupported) {
        const crc = await op.crc32(address, sector.bytes);
        const want = crc32(expected);
        if ((crc >>> 0) !== want) {
          throw new Error(`sector CRC mismatch at ${hex(address)}: ${hex(crc)} != ${hex(want)}`);
        }
      }
      onProgress((s + 1) / sectors.length);
      log(`sector ${s + 1}/${sectors.length} written and verified (${hex(address)})`, 'info');
    }
    log(`atlas ${atlas.kind} written successfully`, 'success');
    return true;
  }

  // Read the headers currently stored on the radio, for the panel's status line.
  async function readAtlasHeaders(op) {
    const out = {};
    for (const [kind, base] of [['ui', UI_BASE], ['name', NAME_BASE]]) {
      try {
        const head = await op.read(base, HEADER_SIZE);
        const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
        const magic = view.getUint32(0, true);
        if (magic === MAGIC_FCN1 || magic === MAGIC_FCN2) {
          out[kind] = {
            present: true,
            magic: magic === MAGIC_FCN1 ? 'FCN1' : 'FCN2',
            version: view.getUint16(4, true),
            count: view.getUint16(6, true)
          };
        } else if (magic === 0xFFFFFFFF) {
          out[kind] = { present: false, blank: true };
        } else {
          out[kind] = { present: false, error: `unknown magic ${hex(magic)}` };
        }
      } catch (e) {
        out[kind] = { present: false, error: e?.message ?? String(e) };
      }
    }
    return out;
  }

  return {
    UI_BASE, NAME_BASE, HEADER_SIZE, GLYPH_SIZE, SECTOR, FLASH_CHUNK, MAGIC_FCN1, MAGIC_FCN2,
    crc32, parseAtlas, baseForKind, sectorCount, planSectors, flashAtlas, readAtlasHeaders
  };
});

/* ---- page wiring (browser only) ---------------------------------------- */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  (function () {
    'use strict';
    const C = window.UVStudioCnFonts;
    const $ = id => document.getElementById(id);
    const t = (key, ...args) => (window.uvStudioI18n ? window.uvStudioI18n.t(key, ...args) : key);
    const loaded = { ui: null, name: null };

    function summarize(atlas) {
      if (!atlas) return '—';
      return t('cnFontsSummary',
        atlas.kind === 'ui' ? 'FCN1' : 'FCN2',
        atlas.count.toLocaleString(),
        atlas.bytes.toLocaleString(),
        `${C.baseForKind(atlas.kind).toString(16).toUpperCase().padStart(8, '0')}h`);
    }

    function refresh() {
      $('cnFontsUiSummary').textContent = summarize(loaded.ui);
      $('cnFontsNameSummary').textContent = summarize(loaded.name);
      $('cnFontsWriteBtn').disabled = !(loaded.ui || loaded.name);
    }

    function setFileName(kind, file) {
      const nameId = kind === 'ui' ? 'cnFontsUiFileName' : 'cnFontsNameFileName';
      const labelId = kind === 'ui' ? 'cnFontsUiFileLabel' : 'cnFontsNameFileLabel';
      const nameEl = $(nameId);
      const labelEl = $(labelId);
      if (nameEl) nameEl.textContent = file ? file.name : t('fileNoFile');
      if (labelEl) labelEl.classList.toggle('has-file', Boolean(file));
    }

    async function loadFile(kind, file) {
      if (!file) { loaded[kind] = null; setFileName(kind, null); refresh(); return; }
      setFileName(kind, file);
      const buf = new Uint8Array(await file.arrayBuffer());
      try {
        const atlas = Object.assign(C.parseAtlas(buf), { data: buf });
        if (atlas.kind !== kind) throw new Error(t(kind === 'ui' ? 'cnFontsWrongUi' : 'cnFontsWrongName'));
        loaded[kind] = atlas;
        window.UVStudioFlash?.log?.(`${file.name}: ${summarize(atlas)}`, 'info');
      } catch (e) {
        loaded[kind] = null;
        window.UVStudioFlash?.log?.(`${file.name}: ${e.message}`, 'error');
      }
      refresh();
    }

    async function runCheck() {
      await window.UVStudioFlash.runExternalFlashOperation('cnFontsCheck', false, async op => {
        const state = await C.readAtlasHeaders(op);
        for (const kind of ['ui', 'name']) {
          const s = state[kind];
          const label = kind === 'ui' ? t('cnFontsUiAtlas') : t('cnFontsNameAtlas');
          if (s.present) op.log(`${label}: ${s.magic} v${s.version}, ${s.count} glyphs`, 'success');
          else if (s.blank) op.log(`${label}: ${t('cnFontsBlank')}`, 'info');
          else op.log(`${label}: ${s.error}`, 'error');
        }
      });
    }

    async function runWrite() {
      const list = [loaded.ui, loaded.name].filter(Boolean);
      if (!list.length) return;
      const ok = await window.UVStudioFlash.runExternalFlashOperation('cnFontsWrite', false, async op => {
        for (let i = 0; i < list.length; i++) {
          const atlas = list[i];
          const share = 100 / list.length;
          const base = i * share;
          op.progress(base);
          await C.flashAtlas(op, atlas, fraction => op.progress(base + fraction * share));
        }
        const state = await C.readAtlasHeaders(op);
        for (const kind of ['ui', 'name']) {
          if (!state[kind].present) throw new Error(t('cnFontsVerifyHeader', kind));
        }
        op.log(t('cnFontsDone'), 'success');
        op.log(t('cnFontsRebootHint'), 'info');
      });
      if (!ok) window.UVStudioFlash?.log?.(t('cnFontsFailed'), 'error');
    }

    function init() {
      if (!$('cnFontsWriteBtn')) return;
      $('cnFontsCheckBtn').addEventListener('click', () => { runCheck(); });
      $('cnFontsWriteBtn').addEventListener('click', () => { runWrite(); });
      $('cnFontsUiFile').addEventListener('change', e => loadFile('ui', e.target.files[0]));
      $('cnFontsNameFile').addEventListener('change', e => loadFile('name', e.target.files[0]));
      refresh();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  })();
}
