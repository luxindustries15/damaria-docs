// Real IPP 2.0 (Internet Printing Protocol) binary request builder & parser
// Used by server.ts to read actual ink/toner levels, paper state, and submit print jobs

export interface IppAttributesResult {
  reachable: boolean;
  printerState: 'idle' | 'processing' | 'stopped' | 'unknown';
  stateReasons: string[];
  modelName?: string;
  inkBlack: number | null;
  inkCyan: number | null;
  inkMagenta: number | null;
  inkYellow: number | null;
  supplyNote: string;
  paperState: string;
  message: string;
}

function encodeAttr(tag: number, name: string, value: Buffer | string): Buffer {
  const nameBuf = Buffer.from(name, 'utf-8');
  const valBuf = typeof value === 'string' ? Buffer.from(value, 'utf-8') : value;
  const out = Buffer.alloc(1 + 2 + nameBuf.length + 2 + valBuf.length);
  let offset = 0;
  out.writeUInt8(tag, offset++);
  out.writeUInt16BE(nameBuf.length, offset);
  offset += 2;
  nameBuf.copy(out, offset);
  offset += nameBuf.length;
  out.writeUInt16BE(valBuf.length, offset);
  offset += 2;
  valBuf.copy(out, offset);
  return out;
}

function buildGetAttributesRequest(printerUri: string): Buffer {
  const header = Buffer.from([
    0x02, 0x00, // IPP 2.0
    0x00, 0x0b, // Get-Printer-Attributes
    0x00, 0x00, 0x00, 0x01, // Request ID 1
    0x01, // Operation attributes tag
  ]);
  const attrs = [
    encodeAttr(0x47, 'attributes-charset', 'utf-8'),
    encodeAttr(0x48, 'attributes-natural-language', 'en'),
    encodeAttr(0x45, 'printer-uri', printerUri),
    encodeAttr(0x44, 'requested-attributes', 'printer-state'),
    encodeAttr(0x44, '', 'printer-state-reasons'),
    encodeAttr(0x44, '', 'printer-make-and-model'),
    encodeAttr(0x44, '', 'marker-names'),
    encodeAttr(0x44, '', 'marker-levels'),
    encodeAttr(0x44, '', 'marker-types'),
    encodeAttr(0x44, '', 'media-ready'),
    Buffer.from([0x03]), // End of attributes tag
  ];
  return Buffer.concat([header, ...attrs]);
}

function parseIppResponse(buf: Buffer): Omit<IppAttributesResult, 'reachable' | 'message'> {
  const result: Omit<IppAttributesResult, 'reachable' | 'message'> = {
    printerState: 'unknown',
    stateReasons: [],
    inkBlack: null,
    inkCyan: null,
    inkMagenta: null,
    inkYellow: null,
    supplyNote: 'Driver did not return ink percentages',
    paperState: 'Status ready (tray count not exposed by IPP)',
  };

  if (buf.length < 9) return result;

  let offset = 8; // skip version, status, requestId
  let currentName = '';
  const markerNames: string[] = [];
  const markerLevels: number[] = [];

  while (offset < buf.length) {
    const tag = buf.readUInt8(offset++);
    if (tag === 0x03) break; // end-of-attributes
    if (tag <= 0x0f) continue; // delimiter group tag

    if (offset + 2 > buf.length) break;
    const nameLen = buf.readUInt16BE(offset);
    offset += 2;
    if (offset + nameLen > buf.length) break;
    const name = buf.toString('utf-8', offset, offset + nameLen);
    offset += nameLen;
    if (name.length > 0) currentName = name;

    if (offset + 2 > buf.length) break;
    const valLen = buf.readUInt16BE(offset);
    offset += 2;
    if (offset + valLen > buf.length) break;
    const valBuf = buf.subarray(offset, offset + valLen);
    offset += valLen;

    if (currentName === 'printer-state' && valLen === 4) {
      const code = valBuf.readInt32BE(0);
      result.printerState = code === 3 ? 'idle' : code === 4 ? 'processing' : code === 5 ? 'stopped' : 'unknown';
    } else if (currentName === 'printer-state-reasons') {
      result.stateReasons.push(valBuf.toString('utf-8'));
    } else if (currentName === 'printer-make-and-model') {
      result.modelName = valBuf.toString('utf-8');
    } else if (currentName === 'marker-names') {
      markerNames.push(valBuf.toString('utf-8').toLowerCase());
    } else if (currentName === 'marker-levels' && valLen === 4) {
      markerLevels.push(valBuf.readInt32BE(0));
    }
  }

  for (let i = 0; i < markerLevels.length; i++) {
    const lvl = markerLevels[i];
    if (lvl < 0 || lvl > 100) continue;
    const label = markerNames[i] || '';
    if (label.includes('cyan')) result.inkCyan = lvl;
    else if (label.includes('magenta')) result.inkMagenta = lvl;
    else if (label.includes('yellow')) result.inkYellow = lvl;
    else if (label.includes('black') || label.includes('toner') || i === 0) {
      result.inkBlack = lvl;
    }
  }

  const reasons = result.stateReasons.filter((r) => r !== 'none');
  if (reasons.some((r) => r.includes('media-empty') || r.includes('paper-out'))) {
    result.paperState = 'Out of Paper (Machine Alert)';
  } else if (reasons.some((r) => r.includes('media-low'))) {
    result.paperState = 'Paper Low (Machine Alert)';
  } else if (reasons.some((r) => r.includes('media-jam'))) {
    result.paperState = 'Paper Jam Reported';
  }

  if (result.inkBlack !== null) {
    result.supplyNote = 'Live IPP supply telemetry';
  } else if (reasons.some((r) => r.includes('toner-low') || r.includes('marker-supply-low'))) {
    result.supplyNote = 'Low toner/ink alert reported by machine';
  } else if (reasons.some((r) => r.includes('toner-empty'))) {
    result.supplyNote = 'Toner/ink empty reported by machine';
  }

  return result;
}

export async function queryIppPrinter(endpointUrl: string): Promise<IppAttributesResult> {
  const httpUrl = endpointUrl.replace(/^ipp:\/\//i, 'http://').replace(/^ipps:\/\//i, 'https://');
  const ippUri = httpUrl.replace(/^http:\/\//i, 'ipp://').replace(/^https:\/\//i, 'ipps://');
  const payload = buildGetAttributesRequest(ippUri);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ipp',
      },
      body: new Uint8Array(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const arrBuf = await res.arrayBuffer();
    const parsed = parseIppResponse(Buffer.from(arrBuf));
    return {
      reachable: res.ok,
      ...parsed,
      message: res.ok
        ? `Connected via IPP (${parsed.printerState}${parsed.stateReasons.length ? ` · ${parsed.stateReasons.join(', ')}` : ''})`
        : `IPP HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      reachable: false,
      printerState: 'unknown',
      stateReasons: [],
      inkBlack: null,
      inkCyan: null,
      inkMagenta: null,
      inkYellow: null,
      supplyNote: 'Unavailable',
      paperState: 'Unavailable',
      message: `Unreachable: ${(err as Error).message}`,
    };
  }
}

export async function sendIppPrintJob(
  endpointUrl: string,
  documentBuffer: Buffer,
  jobName: string,
  copies: number,
  duplex: boolean,
  mimeType: string
): Promise<{ ok: boolean; message: string }> {
  const httpUrl = endpointUrl.replace(/^ipp:\/\//i, 'http://').replace(/^ipps:\/\//i, 'https://');
  const ippUri = httpUrl.replace(/^http:\/\//i, 'ipp://').replace(/^https:\/\//i, 'ipps://');

  const copiesBuf = Buffer.alloc(4);
  copiesBuf.writeInt32BE(Math.max(1, copies), 0);

  const header = Buffer.from([
    0x02, 0x00, // IPP 2.0
    0x00, 0x02, // Print-Job
    0x00, 0x00, 0x00, 0x02,
    0x01, // Operation attributes
  ]);

  const opAttrs = [
    encodeAttr(0x47, 'attributes-charset', 'utf-8'),
    encodeAttr(0x48, 'attributes-natural-language', 'en'),
    encodeAttr(0x45, 'printer-uri', ippUri),
    encodeAttr(0x42, 'requesting-user-name', 'DamariaDocs-Admin'),
    encodeAttr(0x42, 'job-name', jobName.slice(0, 120)),
    encodeAttr(0x49, 'document-format', mimeType || 'application/octet-stream'),
    Buffer.from([0x02]), // Job attributes group
    encodeAttr(0x21, 'copies', copiesBuf),
    encodeAttr(0x44, 'sides', duplex ? 'two-sided-long-edge' : 'one-sided'),
    Buffer.from([0x03]), // End of attributes
  ];

  const body = Buffer.concat([header, ...opAttrs, documentBuffer]);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ipp' },
      body: new Uint8Array(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const arrBuf = await res.arrayBuffer();
    const respBuf = Buffer.from(arrBuf);
    if (!res.ok) {
      return { ok: false, message: `IPP Print-Job rejected with HTTP ${res.status}.` };
    }
    if (respBuf.length >= 4) {
      const ippStatus = respBuf.readUInt16BE(2);
      if (ippStatus >= 0x0400) {
        return {
          ok: false,
          message: `Printer rejected IPP job (status 0x${ippStatus.toString(16).padStart(4, '0')}). Use Browser Print instead.`,
        };
      }
    }
    return { ok: true, message: `Sent IPP Print-Job (${copies} copies) directly to photocopier/printer.` };
  } catch (err) {
    return { ok: false, message: `IPP transmission failed: ${(err as Error).message}` };
  }
}
