// Universal pure-TypeScript Word (.doc / .docx / .rtf / .html / .txt) document parser
// Works identically in Node.js (server.ts), Netlify Functions, and Browser (IndexedDB fallback)

export interface ParsedDocumentResult {
  html: string;
  pageCount: number;
}

export const MAMMOTH_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => p.doc-subtitle:fresh",
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  'u => u',
];

export function isPlaceholderWordHtml(html?: string | null): boolean {
  if (!html || !html.trim()) return true;
  return (
    html.includes('Use Download Original to open in Word') ||
    html.includes('save as .docx/.pdf for direct browser printing')
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function estimatePagesFromHtml(html: string): number {
  const pageBreaks = (html.match(/doc-page-break/g) || []).length;
  const textOnly = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = textOnly ? textOnly.split(' ').length : 0;
  return Math.max(1, pageBreaks + 1, Math.ceil(wordCount / 360));
}

// Windows-1252 0x80..0x9F mapping for ANSI Word pieces & RTF hex escapes
const WIN1252_EXTRA: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

function decodeWin1252Byte(b: number): string {
  if (b >= 0x80 && b <= 0x9f && WIN1252_EXTRA[b]) {
    return String.fromCharCode(WIN1252_EXTRA[b]);
  }
  return String.fromCharCode(b);
}

function decodeWin1252(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += decodeWin1252Byte(bytes[i]);
  }
  return out;
}

function decodeUtf16Le(bytes: Uint8Array): string {
  const len = bytes.length - (bytes.length % 2);
  let out = '';
  for (let i = 0; i < len; i += 2) {
    out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return out;
}

// ============================================================================
// 1. RTF (.doc exported as RTF) -> Clean HTML
// ============================================================================
function rtfToHtml(rtf: string): string {
  interface RtfState {
    b: boolean;
    i: boolean;
    ul: boolean;
    fs: number;
    align: 'left' | 'center' | 'right' | 'justify';
    skip: boolean;
  }

  const stack: RtfState[] = [];
  let state: RtfState = { b: false, i: false, ul: false, fs: 24, align: 'left', skip: false };

  const skipDestinations = new Set([
    'fonttbl',
    'colortbl',
    'stylesheet',
    'info',
    'pict',
    'object',
    'header',
    'footer',
    'headerl',
    'headerr',
    'headerf',
    'footerl',
    'footerr',
    'footerf',
    'themedata',
    'colorschememapping',
    'latentstyles',
    'datastore',
    'xmlnstbl',
    'listtable',
    'listoverridetable',
    'revtbl',
    'rsidtbl',
  ]);

  let currentParaRuns: Array<{ text: string; b: boolean; i: boolean; ul: boolean; fs: number }> = [];
  const blocks: Array<{ type: 'p'; align: string; runs: typeof currentParaRuns } | { type: 'hr' }> = [];
  let pendingText = '';
  let ucSkipCount = 1;
  let skipChars = 0;

  const flushPending = () => {
    if (!pendingText) return;
    currentParaRuns.push({
      text: pendingText,
      b: state.b,
      i: state.i,
      ul: state.ul,
      fs: state.fs,
    });
    pendingText = '';
  };

  const flushParagraph = () => {
    flushPending();
    blocks.push({ type: 'p', align: state.align, runs: currentParaRuns });
    currentParaRuns = [];
  };

  let idx = 0;
  const len = rtf.length;

  while (idx < len) {
    const ch = rtf[idx];

    if (ch === '{') {
      flushPending();
      stack.push({ ...state });
      idx++;
      // Check for \* ignorable destination
      if (rtf[idx] === '\\' && rtf[idx + 1] === '*') {
        state.skip = true;
        idx += 2;
      }
      continue;
    }

    if (ch === '}') {
      flushPending();
      state = stack.pop() || { b: false, i: false, ul: false, fs: 24, align: 'left', skip: false };
      idx++;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      idx++;
      continue;
    }

    if (ch === '\\') {
      idx++;
      if (idx >= len) break;
      const next = rtf[idx];

      if (next === '\\' || next === '{' || next === '}') {
        if (!state.skip && skipChars === 0) pendingText += next;
        if (skipChars > 0) skipChars--;
        idx++;
        continue;
      }

      if (next === "'") {
        const hex = rtf.slice(idx + 1, idx + 3);
        const code = parseInt(hex, 16);
        if (!Number.isNaN(code) && !state.skip && skipChars === 0) {
          pendingText += decodeWin1252Byte(code);
        }
        if (skipChars > 0) skipChars--;
        idx += 3;
        continue;
      }

      if (next === '~') {
        if (!state.skip) pendingText += '\u00a0';
        idx++;
        continue;
      }
      if (next === '-' || next === '_') {
        if (!state.skip) pendingText += '-';
        idx++;
        continue;
      }

      // Parse control word
      const wordMatch = rtf.slice(idx).match(/^([a-zA-Z]+)(-?\d+)? ?/);
      if (!wordMatch) {
        idx++;
        continue;
      }
      const word = wordMatch[1];
      const param = wordMatch[2] !== undefined ? Number(wordMatch[2]) : null;
      idx += wordMatch[0].length;

      if (skipDestinations.has(word)) {
        state.skip = true;
        continue;
      }
      if (state.skip) continue;

      if (word === 'uc' && param !== null) {
        ucSkipCount = Math.max(0, param);
      } else if (word === 'u' && param !== null) {
        const code = param < 0 ? 65536 + param : param;
        pendingText += String.fromCharCode(code);
        skipChars = ucSkipCount;
      } else if (word === 'par') {
        flushParagraph();
      } else if (word === 'line') {
        pendingText += '\n';
      } else if (word === 'tab') {
        pendingText += '    ';
      } else if (word === 'page') {
        flushParagraph();
        blocks.push({ type: 'hr' });
      } else if (word === 'b') {
        flushPending();
        state.b = param !== 0;
      } else if (word === 'i') {
        flushPending();
        state.i = param !== 0;
      } else if (word === 'ul') {
        flushPending();
        state.ul = param !== 0;
      } else if (word === 'ulnone') {
        flushPending();
        state.ul = false;
      } else if (word === 'fs' && param !== null) {
        flushPending();
        state.fs = param;
      } else if (word === 'qc') {
        state.align = 'center';
      } else if (word === 'qr') {
        state.align = 'right';
      } else if (word === 'ql') {
        state.align = 'left';
      } else if (word === 'qj') {
        state.align = 'justify';
      } else if (word === 'pard') {
        flushPending();
        state.align = 'left';
      } else if (word === 'plain') {
        flushPending();
        state.b = false;
        state.i = false;
        state.ul = false;
        state.fs = 24;
      }
      continue;
    }

    if (!state.skip) {
      if (skipChars > 0) {
        skipChars--;
      } else {
        pendingText += ch;
      }
    }
    idx++;
  }

  flushPending();
  if (currentParaRuns.length > 0) {
    blocks.push({ type: 'p', align: state.align, runs: currentParaRuns });
  }

  return blocks
    .map((block) => {
      if (block.type === 'hr') {
        return '<div class="doc-page-break"></div>';
      }
      if (block.runs.length === 0) {
        return '<p>&nbsp;</p>';
      }
      const inner = block.runs
        .map((r) => {
          let frag = escapeHtml(r.text).replace(/\n/g, '<br/>');
          if (r.ul) frag = `<u>${frag}</u>`;
          if (r.i) frag = `<em>${frag}</em>`;
          if (r.b) frag = `<strong>${frag}</strong>`;
          if (r.fs >= 32) {
            frag = `<span style="font-size:${Math.round(r.fs / 2)}pt">${frag}</span>`;
          }
          return frag;
        })
        .join('');
      const style = block.align !== 'left' ? ` style="text-align:${block.align}"` : '';
      return `<p${style}>${inner || '&nbsp;'}</p>`;
    })
    .join('\n');
}

// ============================================================================
// 2. HTML / MHTML / WordprocessingML (.doc exported as HTML/XML)
// ============================================================================
function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function sanitizeExtractedHtml(rawHtml: string): string {
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let html = bodyMatch ? bodyMatch[1] : rawHtml;

  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?o:[^>]*>/gi, '')
    .replace(/<\/?v:[^>]*>/gi, '')
    .replace(/<\/?w:[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim();

  return html;
}

function extractWordXmlHtml(xml: string): string {
  const paragraphs: string[] = [];
  const pMatches = xml.match(/<w:p[\s\S]*?<\/w:p>/gi) || [];
  for (const p of pMatches) {
    const texts = Array.from(p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)).map((m) => m[1]);
    const joined = texts.join('').trim();
    if (joined) {
      paragraphs.push(`<p>${joined}</p>`);
    }
  }
  return paragraphs.join('\n');
}

// ============================================================================
// 3. Genuine Microsoft Word 97-2003 Binary (.doc OLE2 / CFBF + Piece Table)
// ============================================================================
interface CfbDirEntry {
  name: string;
  type: number;
  startSector: number;
  size: number;
}

function parseOle2Streams(bytes: Uint8Array): Map<string, Uint8Array> | null {
  if (bytes.length < 512) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Check OLE2 magic D0 CF 11 E0 A1 B1 1A E1
  if (
    bytes[0] !== 0xd0 ||
    bytes[1] !== 0xcf ||
    bytes[2] !== 0x11 ||
    bytes[3] !== 0xe0 ||
    bytes[4] !== 0xa1 ||
    bytes[5] !== 0xb1 ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0xe1
  ) {
    return null;
  }

  const sectorShift = view.getUint16(0x1e, true);
  const miniSectorShift = view.getUint16(0x20, true);
  const sectorSize = 1 << (sectorShift || 9);
  const miniSectorSize = 1 << (miniSectorShift || 6);
  const numFatSectors = view.getUint32(0x2c, true);
  const firstDirSector = view.getUint32(0x30, true);
  const miniStreamCutoff = view.getUint32(0x38, true) || 4096;
  const firstMiniFatSector = view.getUint32(0x3c, true);
  const firstDifatSector = view.getUint32(0x44, true);
  const numDifatSectors = view.getUint32(0x48, true);

  const ENDOFCHAIN = 0xfffffffe;
  const FREESECT = 0xffffffff;

  const sectorOffset = (sec: number) => (sec + 1) * sectorSize;

  // Gather FAT sector numbers from DIFAT (first 109 in header + extra DIFAT chain)
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
    const s = view.getUint32(0x4c + i * 4, true);
    if (s !== FREESECT && s !== ENDOFCHAIN) fatSectors.push(s);
  }

  let difatSec = firstDifatSector;
  for (let d = 0; d < numDifatSectors && difatSec !== FREESECT && difatSec !== ENDOFCHAIN; d++) {
    const off = sectorOffset(difatSec);
    if (off + sectorSize > bytes.length) break;
    const entriesPerSec = sectorSize / 4 - 1;
    for (let i = 0; i < entriesPerSec && fatSectors.length < numFatSectors; i++) {
      const s = view.getUint32(off + i * 4, true);
      if (s !== FREESECT && s !== ENDOFCHAIN) fatSectors.push(s);
    }
    difatSec = view.getUint32(off + entriesPerSec * 4, true);
  }

  // Build FAT table
  const fat: number[] = [];
  for (const s of fatSectors) {
    const off = sectorOffset(s);
    if (off + sectorSize > bytes.length) continue;
    for (let i = 0; i < sectorSize; i += 4) {
      fat.push(view.getUint32(off + i, true));
    }
  }

  const readFatChain = (startSector: number, maxSize?: number): Uint8Array => {
    const chunks: Uint8Array[] = [];
    const seen = new Set<number>();
    let sec = startSector;
    let total = 0;
    const limit = maxSize ?? bytes.length;

    while (sec !== ENDOFCHAIN && sec !== FREESECT && sec < fat.length && !seen.has(sec)) {
      seen.add(sec);
      const off = sectorOffset(sec);
      if (off >= bytes.length) break;
      const take = Math.min(sectorSize, bytes.length - off, Math.max(0, limit - total));
      if (take <= 0) break;
      chunks.push(bytes.subarray(off, off + take));
      total += take;
      if (total >= limit) break;
      sec = fat[sec];
    }

    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  };

  // Read Directory Entries
  const dirBytes = readFatChain(firstDirSector);
  const dirView = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries: CfbDirEntry[] = [];

  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = dirView.getUint16(off + 0x40, true);
    const type = dirBytes[off + 0x42];
    if (type === 0 || nameLen < 2 || nameLen > 64) continue;
    const name = decodeUtf16Le(dirBytes.subarray(off, off + nameLen - 2));
    const startSector = dirView.getUint32(off + 0x74, true);
    const size = dirView.getUint32(off + 0x78, true);
    entries.push({ name, type, startSector, size });
  }

  const root = entries.find((e) => e.type === 5) || entries[0];
  const miniStream =
    root && root.startSector !== FREESECT && root.size > 0
      ? readFatChain(root.startSector, root.size)
      : new Uint8Array(0);

  // Build MiniFAT
  const miniFat: number[] = [];
  if (firstMiniFatSector !== FREESECT && firstMiniFatSector !== ENDOFCHAIN) {
    const miniFatBytes = readFatChain(firstMiniFatSector);
    const mfView = new DataView(
      miniFatBytes.buffer,
      miniFatBytes.byteOffset,
      miniFatBytes.byteLength
    );
    for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) {
      miniFat.push(mfView.getUint32(i, true));
    }
  }

  const readMiniChain = (startSector: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    const seen = new Set<number>();
    let sec = startSector;
    let written = 0;
    while (sec !== ENDOFCHAIN && sec !== FREESECT && sec < miniFat.length && !seen.has(sec)) {
      seen.add(sec);
      const off = sec * miniSectorSize;
      if (off >= miniStream.length) break;
      const take = Math.min(miniSectorSize, miniStream.length - off, size - written);
      if (take <= 0) break;
      out.set(miniStream.subarray(off, off + take), written);
      written += take;
      if (written >= size) break;
      sec = miniFat[sec];
    }
    return out;
  };

  const streams = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.type !== 2 || entry.size === 0) continue;
    const data =
      entry.size < miniStreamCutoff && miniStream.length > 0 && miniFat.length > 0
        ? readMiniChain(entry.startSector, entry.size)
        : readFatChain(entry.startSector, entry.size);
    streams.set(entry.name, data);
  }
  return streams;
}

function cleanWordFieldCodes(raw: string): string {
  // Replace Word field spans: \x13 <instruction> \x14 <displayText> \x15  -> <displayText>
  // Or \x13 <instruction> \x15 (no \x14) -> ''
  let out = '';
  let depth = 0;
  let inResult = false;
  const resultStack: boolean[] = [];

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\x13') {
      resultStack.push(inResult);
      depth++;
      inResult = false;
    } else if (ch === '\x14') {
      if (depth > 0) inResult = true;
    } else if (ch === '\x15') {
      if (depth > 0) {
        depth--;
        inResult = resultStack.pop() ?? false;
      }
    } else if (depth === 0 || inResult) {
      out += ch;
    }
  }
  return out;
}

function wordRawTextToHtml(rawText: string): string {
  const cleaned = cleanWordFieldCodes(rawText)
    .replace(/\r\n/g, '\r')
    .replace(/\n/g, '\r')
    .replace(/[\x00\x01\x02\x05\x08\x0e\x0f\x10-\x12\x16-\x1f]/g, '');

  const htmlParts: string[] = [];
  let inTable = false;
  let currentRowCells: string[] = [];
  let currentCellLines: string[] = [];
  let currentText = '';

  const flushTable = () => {
    if (!inTable) return;
    htmlParts.push('</tbody></table>');
    inTable = false;
  };

  const formatCellHtml = (lines: string[]) => {
    const nonEmpty = lines.map((l) => escapeHtml(l.trim())).filter(Boolean);
    return nonEmpty.length > 0 ? nonEmpty.join('<br/>') : '&nbsp;';
  };

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (ch === '\x07') {
      // End of cell, OR if currentText and currentCellLines are empty right after a cell end, end of row!
      if (currentText === '' && currentCellLines.length === 0 && currentRowCells.length > 0) {
        if (!inTable) {
          htmlParts.push('<table><tbody>');
          inTable = true;
        }
        htmlParts.push(
          `<tr>${currentRowCells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`
        );
        currentRowCells = [];
      } else {
        currentCellLines.push(currentText);
        currentRowCells.push(formatCellHtml(currentCellLines));
        currentCellLines = [];
        currentText = '';
      }
      continue;
    }

    if (ch === '\x0c') {
      // Page break
      flushTable();
      if (currentText.trim()) {
        htmlParts.push(`<p>${escapeHtml(currentText.trim())}</p>`);
      }
      currentText = '';
      htmlParts.push('<div class="doc-page-break"></div>');
      continue;
    }

    if (ch === '\x0b') {
      // Soft line break inside paragraph or cell
      currentText += '\n';
      continue;
    }

    if (ch === '\r') {
      if (currentRowCells.length > 0) {
        currentCellLines.push(currentText);
        currentText = '';
      } else {
        flushTable();
        const trimmed = currentText.trim();
        if (!trimmed) {
          htmlParts.push('<p>&nbsp;</p>');
        } else {
          const lineHtml = escapeHtml(trimmed).replace(/\n/g, '<br/>');
          htmlParts.push(`<p>${lineHtml}</p>`);
        }
        currentText = '';
      }
      continue;
    }

    currentText += ch;
  }

  if (currentRowCells.length > 0) {
    if (!inTable) {
      htmlParts.push('<table><tbody>');
      inTable = true;
    }
    htmlParts.push(`<tr>${currentRowCells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`);
  }
  flushTable();

  if (currentText.trim()) {
    htmlParts.push(`<p>${escapeHtml(currentText.trim()).replace(/\n/g, '<br/>')}</p>`);
  }

  return htmlParts.join('\n').trim();
}

function extractBinaryOle2Doc(bytes: Uint8Array): string | null {
  const streams = parseOle2Streams(bytes);
  if (!streams) return null;

  const wordDoc = streams.get('WordDocument');
  if (!wordDoc || wordDoc.length < 64) return null;

  const fibView = new DataView(wordDoc.buffer, wordDoc.byteOffset, wordDoc.byteLength);
  const nFib = fibView.getUint16(0x02, true);
  const flags = fibView.getUint16(0x0a, true);

  // Encrypted Word document
  if ((flags & 0x0100) !== 0) {
    return '<p><strong>Password-protected Word (.doc) file.</strong> Remove the password in Word or export as PDF to preview and print.</p>';
  }

  const useTable1 = (flags & 0x0200) !== 0;
  const tableStream = streams.get(useTable1 ? '1Table' : '0Table') || streams.get('1Table') || streams.get('0Table');

  const ccpText = wordDoc.length >= 0x50 ? fibView.getUint32(0x4c, true) : 0;

  // Word 97-2003 Piece Table extraction
  if (nFib >= 0x00c0 && tableStream && wordDoc.length >= 0x1aa) {
    const fcClx = fibView.getUint32(0x01a2, true);
    const lcbClx = fibView.getUint32(0x01a6, true);

    if (lcbClx > 0 && fcClx + lcbClx <= tableStream.length) {
      const clx = tableStream.subarray(fcClx, fcClx + lcbClx);
      const clxView = new DataView(clx.buffer, clx.byteOffset, clx.byteLength);
      let pos = 0;

      while (pos < clx.length && clx[pos] === 0x01) {
        if (pos + 3 > clx.length) break;
        const cb = clxView.getUint16(pos + 1, true);
        pos += 3 + cb;
      }

      if (pos + 5 <= clx.length && clx[pos] === 0x02) {
        const lcb = clxView.getUint32(pos + 1, true);
        const plcStart = pos + 5;
        if (lcb >= 16 && plcStart + lcb <= clx.length) {
          const pieceCount = Math.floor((lcb - 4) / 12);
          const plcView = new DataView(clx.buffer, clx.byteOffset + plcStart, lcb);

          let fullText = '';
          for (let i = 0; i < pieceCount; i++) {
            const cpStart = plcView.getUint32(i * 4, true);
            const cpEnd = plcView.getUint32((i + 1) * 4, true);
            const charCount = cpEnd - cpStart;
            if (charCount <= 0) continue;

            const pcdOffset = (pieceCount + 1) * 4 + i * 8;
            const fcRaw = plcView.getUint32(pcdOffset + 2, true);
            const isAnsi = (fcRaw & 0x40000000) !== 0;
            const rawOffset = fcRaw & 0x3fffffff;

            if (isAnsi) {
              const byteStart = Math.floor(rawOffset / 2);
              const slice = wordDoc.subarray(byteStart, Math.min(wordDoc.length, byteStart + charCount));
              fullText += decodeWin1252(slice);
            } else {
              const byteStart = rawOffset;
              const slice = wordDoc.subarray(
                byteStart,
                Math.min(wordDoc.length, byteStart + charCount * 2)
              );
              fullText += decodeUtf16Le(slice);
            }
          }

          if (fullText.length > 0) {
            const mainBody = ccpText > 0 && ccpText <= fullText.length ? fullText.slice(0, ccpText) : fullText;
            const html = wordRawTextToHtml(mainBody);
            if (html) return html;
          }
        }
      }
    }
  }

  // Fallback for Word 6.0 / Word 95 or simple non-piece-table WordDocument streams
  const fcMin = wordDoc.length >= 0x20 ? fibView.getUint32(0x18, true) : 0;
  const fcMac = wordDoc.length >= 0x20 ? fibView.getUint32(0x1c, true) : 0;
  if (fcMac > fcMin && fcMac <= wordDoc.length) {
    const rawAnsi = decodeWin1252(wordDoc.subarray(fcMin, fcMac));
    const html = wordRawTextToHtml(rawAnsi);
    if (html) return html;
  }

  return null;
}

// ============================================================================
// Public Entry Point
// ============================================================================
export async function parseWordDocumentBytes(
  bytes: Uint8Array,
  fileName: string,
  convertDocxFn?: (bytes: Uint8Array) => Promise<string | null>
): Promise<ParsedDocumentResult> {
  if (bytes.length === 0) {
    return {
      html: `<p>Empty file <strong>${escapeHtml(fileName)}</strong>.</p>`,
      pageCount: 1,
    };
  }

  // 1. Check ZIP header (PK\x03\x04) — either .docx or renamed .doc
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    if (convertDocxFn) {
      try {
        const docxHtml = await convertDocxFn(bytes);
        if (docxHtml && docxHtml.trim()) {
          return {
            html: docxHtml,
            pageCount: estimatePagesFromHtml(docxHtml),
          };
        }
      } catch {
        // fall through
      }
    }
  }

  // 2. Check OLE2 Binary Word (.doc)
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    const oleHtml = extractBinaryOle2Doc(bytes);
    if (oleHtml && oleHtml.trim()) {
      return {
        html: oleHtml,
        pageCount: estimatePagesFromHtml(oleHtml),
      };
    }
  }

  // 3. Check text-based formats saved with .doc extension (RTF, MHTML, HTML, Word XML, Plain text)
  const headText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048)).replace(/^\uFEFF/, '').trimStart();
  const fullText = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');

  if (headText.startsWith('{\\rtf')) {
    const html = rtfToHtml(fullText);
    if (html.trim()) {
      return { html, pageCount: estimatePagesFromHtml(html) };
    }
  }

  if (/^MIME-Version:/i.test(headText)) {
    const htmlPartMatch = fullText.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|$)/i);
    if (htmlPartMatch) {
      const decoded = decodeQuotedPrintable(htmlPartMatch[1]);
      const sanitized = sanitizeExtractedHtml(decoded);
      if (sanitized) {
        return { html: sanitized, pageCount: estimatePagesFromHtml(sanitized) };
      }
    }
  }

  if (/^<\?xml/i.test(headText) && /<w:t[\s>]/i.test(fullText)) {
    const xmlHtml = extractWordXmlHtml(fullText);
    if (xmlHtml) {
      return { html: xmlHtml, pageCount: estimatePagesFromHtml(xmlHtml) };
    }
  }

  if (/^<(?:!doctype|html|body|div|p|table|h[1-6]|meta)\b/i.test(headText) || /<body[^>]*>/i.test(headText)) {
    const sanitized = sanitizeExtractedHtml(fullText);
    if (sanitized) {
      return { html: sanitized, pageCount: estimatePagesFromHtml(sanitized) };
    }
  }

  // Fallback plain text if file only contains printable text
  if (!fileName.toLowerCase().endsWith('.doc') || /^[\t\r\n\x20-\x7e\u00a0-\uffff]+$/.test(headText.slice(0, 200))) {
    const html = `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(fullText)}</pre>`;
    return { html, pageCount: estimatePagesFromHtml(html) };
  }

  return {
    html: `<p>Could not decode legacy binary content in <strong>${escapeHtml(fileName)}</strong>. Use Download Original to inspect in Word.</p>`,
    pageCount: 1,
  };
}
