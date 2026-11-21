import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import mammoth from 'mammoth';
import {
  createAdminToken,
  extractBearerToken,
  sanitizeBootstrapForPublic,
  verifyAdminPassword,
  verifyAdminToken,
} from '../../adminAuth';
import { queryIppPrinter, sendIppPrintJob } from '../../src/utils/ipp';
import {
  isPlaceholderWordHtml,
  MAMMOTH_STYLE_MAP,
  parseWordDocumentBytes,
} from '../../src/utils/docParser';
import type {
  AppNotification,
  BootstrapPayload,
  DeviceType,
  ExamSubmission,
  HistoryLogEntry,
  PaperSize,
  PrinterConnectionMode,
  PrinterDevice,
  TelemetrySource,
  UsbHardwareInfo,
} from '../../src/types';

const SCHEMA_VERSION = 4;
const BLOB_STORE_NAME = 'damaria-docs';
const TMP_ROOT = '/tmp/damaria-docs-netlify';
const TMP_STORE_PATH = path.join(TMP_ROOT, 'store.json');
const TMP_UPLOADS_DIR = path.join(TMP_ROOT, 'uploads');

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function calcSheetsPerCopy(pageCount: number, duplex: boolean): number {
  const safe = Math.max(1, Math.round(pageCount));
  return duplex ? Math.ceil(safe / 2) : safe;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function parseWordBuffer(buf: Buffer, fileName: string) {
  return parseWordDocumentBytes(new Uint8Array(buf), fileName, async (rawBytes) => {
    const res = await mammoth.convertToHtml(
      { buffer: Buffer.from(rawBytes) },
      { styleMap: MAMMOTH_STYLE_MAP }
    );
    return res.value || null;
  });
}

function createEmptyStore(): BootstrapPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    schoolName: 'Damaria Docs',
    printers: [],
    submissions: [],
    logs: [],
    notifications: [],
  };
}

const TMP_SECRET_PATH = path.join(TMP_ROOT, 'session.secret');

function corsHeaders(req?: Request): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (!req) return base;
  const origin = req.headers.get('origin');
  if (!origin) return base;

  const reqOrigin = new URL(req.url).origin;
  const extraOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const isAllowed =
    origin === reqOrigin ||
    origin === 'https://damariadocs.com' ||
    origin === 'https://www.damariadocs.com' ||
    /^https:\/\/[a-z0-9-]+\.netlify\.app$/i.test(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
    extraOrigins.includes(origin);

  if (isAllowed) {
    base['Access-Control-Allow-Origin'] = origin;
    base['Vary'] = 'Origin';
  }
  return base;
}

function jsonResponse(data: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(req),
    },
  });
}

async function getSessionSecret(): Promise<string> {
  const envSecret = process.env.ADMIN_SESSION_SECRET;
  if (envSecret && envSecret.length >= 16) return envSecret;

  const blobs = getBlobStoreSafe();
  if (blobs) {
    try {
      const existing = await blobs.get('_system/admin_session_secret', { type: 'text' });
      if (existing && typeof existing === 'string' && existing.length >= 32) {
        return existing;
      }
      const created = crypto.randomBytes(32).toString('hex');
      await blobs.set('_system/admin_session_secret', created);
      return created;
    } catch {
      // fall through to /tmp secret
    }
  }

  try {
    if (fs.existsSync(TMP_SECRET_PATH)) {
      const existing = (await fsp.readFile(TMP_SECRET_PATH, 'utf-8')).trim();
      if (existing.length >= 32) return existing;
    }
    await fsp.mkdir(TMP_ROOT, { recursive: true });
    const created = crypto.randomBytes(32).toString('hex');
    await fsp.writeFile(TMP_SECRET_PATH, created, 'utf-8');
    return created;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

function getBlobStoreSafe() {
  try {
    return getStore({ name: BLOB_STORE_NAME, consistency: 'strong' });
  } catch {
    return null;
  }
}

async function loadStore(): Promise<BootstrapPayload> {
  const blobs = getBlobStoreSafe();
  if (blobs) {
    try {
      const parsed = (await blobs.get('store.json', { type: 'json' })) as BootstrapPayload | null;
      if (parsed && parsed.schemaVersion === SCHEMA_VERSION) {
        if (!Array.isArray(parsed.notifications)) parsed.notifications = [];
        return parsed;
      }
    } catch {
      // fall through to tmp fallback or fresh store
    }
  }

  try {
    if (fs.existsSync(TMP_STORE_PATH)) {
      const raw = await fsp.readFile(TMP_STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as BootstrapPayload;
      if (parsed.schemaVersion === SCHEMA_VERSION) {
        if (!Array.isArray(parsed.notifications)) parsed.notifications = [];
        return parsed;
      }
    }
  } catch {
    // ignore
  }

  return createEmptyStore();
}

async function saveStore(store: BootstrapPayload): Promise<void> {
  const blobs = getBlobStoreSafe();
  if (blobs) {
    try {
      await blobs.setJSON('store.json', store);
      return;
    } catch {
      // fall back to /tmp if Netlify Blobs isn't initialized (e.g. local test)
    }
  }

  await fsp.mkdir(TMP_ROOT, { recursive: true });
  await fsp.writeFile(TMP_STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

async function saveUploadedFile(
  fileKey: string,
  buffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<void> {
  const blobs = getBlobStoreSafe();
  if (blobs) {
    try {
      const uint8 = new Uint8Array(buffer);
      await blobs.set(`uploads/${fileKey}`, uint8.buffer, {
        metadata: { mimeType, fileName },
      });
      return;
    } catch {
      // fall back to /tmp
    }
  }

  await fsp.mkdir(TMP_UPLOADS_DIR, { recursive: true });
  await fsp.writeFile(path.join(TMP_UPLOADS_DIR, fileKey), buffer);
}

async function readUploadedFile(
  fileKey: string
): Promise<{ buffer: Buffer; mimeType?: string; fileName?: string } | null> {
  const blobs = getBlobStoreSafe();
  if (blobs) {
    try {
      const res = await blobs.getWithMetadata(`uploads/${fileKey}`, { type: 'arrayBuffer' });
      if (res && res.data) {
        return {
          buffer: Buffer.from(res.data),
          mimeType: typeof res.metadata?.mimeType === 'string' ? res.metadata.mimeType : undefined,
          fileName: typeof res.metadata?.fileName === 'string' ? res.metadata.fileName : undefined,
        };
      }
    } catch {
      // fall back to /tmp
    }
  }

  const localPath = path.join(TMP_UPLOADS_DIR, fileKey);
  if (fs.existsSync(localPath)) {
    const buffer = await fsp.readFile(localPath);
    return { buffer };
  }
  return null;
}

async function deleteUploadedFile(fileKey: string): Promise<void> {
  const blobs = getBlobStoreSafe();
  if (blobs) {
    try {
      await blobs.delete(`uploads/${fileKey}`);
    } catch {
      // ignore
    }
  }

  const localPath = path.join(TMP_UPLOADS_DIR, fileKey);
  if (fs.existsSync(localPath)) {
    try {
      await fsp.unlink(localPath);
    } catch {
      // ignore
    }
  }
}

function appendLog(store: BootstrapPayload, entry: Omit<HistoryLogEntry, 'id' | 'timestamp'>) {
  const full: HistoryLogEntry = {
    id: uid('log'),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  store.logs.unshift(full);
  if (store.logs.length > 500) store.logs.length = 500;
  return full;
}

function appendNotification(
  store: BootstrapPayload,
  entry: Omit<AppNotification, 'id' | 'timestamp'>
) {
  if (!Array.isArray(store.notifications)) {
    store.notifications = [];
  }
  const full: AppNotification = {
    id: uid('ntf'),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  store.notifications.unshift(full);
  if (store.notifications.length > 120) store.notifications.length = 120;
  return full;
}

interface ProbeSummary {
  connected: boolean;
  hardwareState: string;
  telemetrySource: TelemetrySource;
  inkBlack: number | null;
  inkCyan: number | null;
  inkMagenta: number | null;
  inkYellow: number | null;
  supplyNote: string;
  paperState: string;
  message: string;
}

async function probeDigitalMachine(endpoint: string): Promise<ProbeSummary> {
  const trimmed = endpoint.trim();
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('ipp://') ||
    trimmed.startsWith('ipps://')
  ) {
    const ipp = await queryIppPrinter(trimmed);
    return {
      connected: ipp.reachable,
      hardwareState: ipp.reachable ? `IPP ${ipp.printerState}` : 'Offline / Unreachable',
      telemetrySource: ipp.reachable && ipp.inkBlack !== null ? 'ipp' : 'none',
      inkBlack: ipp.inkBlack,
      inkCyan: ipp.inkCyan,
      inkMagenta: ipp.inkMagenta,
      inkYellow: ipp.inkYellow,
      supplyNote: ipp.supplyNote,
      paperState: ipp.paperState,
      message: ipp.message,
    };
  }

  const match = trimmed.match(/^([a-zA-Z0-9.-]+):(\d{2,5})$/);
  if (!match) {
    return {
      connected: false,
      hardwareState: 'Invalid Address',
      telemetrySource: 'none',
      inkBlack: null,
      inkCyan: null,
      inkMagenta: null,
      inkYellow: null,
      supplyNote: 'Enter IP:Port (e.g. 192.168.1.50:9100) or http://.../ipp/print',
      paperState: 'Unknown',
      message: 'Invalid digital address.',
    };
  }

  const host = match[1];
  const port = Number(match[2]);
  const start = Date.now();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let pjlText = '';

    const finish = (connected: boolean, message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();

      let inkBlack: number | null = null;
      const pctMatch = pjlText.match(/(\d{1,3})\s*%/);
      if (pctMatch) {
        const val = Number(pctMatch[1]);
        if (val >= 0 && val <= 100) inkBlack = val;
      }

      const paperState = /OUT OF PAPER|MEDIA EMPTY/i.test(pjlText)
        ? 'Out of Paper (PJL)'
        : /JAM/i.test(pjlText)
          ? 'Paper Jam (PJL)'
          : connected
            ? 'Ready (Raw TCP Port 9100)'
            : 'Unavailable';

      resolve({
        connected,
        hardwareState: connected ? 'TCP Ready' : 'Offline / Unreachable',
        telemetrySource: inkBlack !== null ? 'pjl' : 'none',
        inkBlack,
        inkCyan: null,
        inkMagenta: null,
        inkYellow: null,
        supplyNote:
          inkBlack !== null
            ? 'Live PJL supply reading'
            : connected
              ? 'Raw TCP connected (ink % requires IPP URL)'
              : 'Machine unreachable',
        paperState,
        message,
      });
    };

    socket.setTimeout(2200);
    socket.on('data', (chunk) => {
      pjlText += chunk.toString('utf-8');
    });
    socket.on('connect', () => {
      socket.write('\x1b%-12345X@PJL INFO STATUS\r\n@PJL INFO SUPPLIES\r\n\x1b%-12345X');
      setTimeout(() => {
        finish(true, `Connected via TCP ${host}:${port} (${Date.now() - start}ms)`);
      }, 450);
    });
    socket.on('timeout', () =>
      finish(false, `Timed out connecting to ${host}:${port} from server.`)
    );
    socket.on('error', (err) =>
      finish(false, `Cannot reach ${host}:${port} (${err.message}).`)
    );
    try {
      socket.connect(port, host);
    } catch (err) {
      finish(false, `Socket error: ${(err as Error).message}`);
    }
  });
}

async function sendTcpPrintPayload(
  endpoint: string,
  payload: Buffer,
  copies: number
): Promise<{ ok: boolean; message: string }> {
  const match = endpoint.trim().match(/^([a-zA-Z0-9.-]+):(\d{2,5})$/);
  if (!match) return { ok: false, message: 'Invalid TCP printer address.' };
  const host = match[1];
  const port = Number(match[2]);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, message });
    };
    socket.setTimeout(4000);
    socket.on('connect', () => {
      const pjlHeader = Buffer.from(`\x1b%-12345X@PJL SET COPIES=${copies}\r\n`);
      const pjlFooter = Buffer.from(`\r\n\x1b%-12345X`);
      const full = Buffer.concat([pjlHeader, payload, pjlFooter]);
      socket.write(full, () => {
        socket.end();
        finish(true, `Sent ${full.length} bytes (${copies} copies) to ${host}:${port}.`);
      });
    });
    socket.on('timeout', () => finish(false, `Timed out sending job to ${host}:${port}.`));
    socket.on('error', (err) => finish(false, `Transmission error: ${err.message}`));
    socket.connect(port, host);
  });
}

function generateBridgeScript(): string {
  return `#!/usr/bin/env node
// Damaria Docs Local Printer & Photocopier Bridge (Zero dependencies)
// Run on the print-room computer: node damaria-docs-bridge.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PORT = 4777;
const TMP_DIR = path.join(os.tmpdir(), 'damaria-docs-bridge');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function mapWindowsStatus(code) {
  const map = {
    1: 'Other',
    2: 'Unknown',
    3: 'Ready',
    4: 'Printing',
    5: 'Warmup',
    6: 'Stopped',
    7: 'Offline',
  };
  return map[code] || 'Ready';
}

async function listLocalMachines() {
  const platform = process.platform;
  if (platform === 'win32') {
    const psScript = \`
      Get-CimInstance Win32_Printer | Select-Object Name,PortName,DriverName,PrinterStatus,DetectedErrorState,WorkOffline,Default | ConvertTo-Json -Compress
    \`;
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], { timeout: 5000 });
      const raw = stdout.trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((p) => {
        const port = String(p.PortName || '');
        const isUsb = /USB/i.test(port);
        const offline = Boolean(p.WorkOffline) || Number(p.PrinterStatus) === 7;
        const errCode = Number(p.DetectedErrorState || 0);
        let paperState = 'Ready';
        let inkBlack = null;
        if (errCode === 4 || errCode === 5) paperState = 'Out of Paper';
        if (errCode === 8) paperState = 'Paper Jam';
        if (errCode === 6 || errCode === 7) inkBlack = 10;
        return {
          name: p.Name,
          portName: port,
          driverName: p.DriverName || 'Windows Print Driver',
          isUsb,
          isDefault: Boolean(p.Default),
          online: !offline,
          statusText: offline ? 'Offline' : mapWindowsStatus(Number(p.PrinterStatus)),
          inkBlack,
          paperState,
        };
      });
    } catch {
      return [];
    }
  }

  try {
    const { stdout: pOut } = await execFileAsync('lpstat', ['-p'], { timeout: 4000 });
    let vOut = '';
    try {
      const vRes = await execFileAsync('lpstat', ['-v'], { timeout: 4000 });
      vOut = vRes.stdout;
    } catch {}
    const portMap = {};
    for (const line of vOut.split('\\n')) {
      const m = line.match(/^device for ([^:]+):\\s*(.+)$/);
      if (m) portMap[m[1].trim()] = m[2].trim();
    }
    const machines = [];
    for (const line of pOut.split('\\n')) {
      const m = line.match(/^printer\\s+(\\S+)\\s+(.+)$/);
      if (!m) continue;
      const name = m[1];
      const info = m[2];
      const portName = portMap[name] || 'CUPS Local';
      const offline = /disabled|offline/i.test(info);
      machines.push({
        name,
        portName,
        driverName: 'CUPS',
        isUsb: /usb/i.test(portName),
        isDefault: false,
        online: !offline,
        statusText: info.trim(),
        inkBlack: null,
        paperState: /media-empty|out of paper/i.test(info) ? 'Out of Paper' : 'Ready',
      });
    }
    return machines;
  } catch {
    return [];
  }
}

async function printLocalFile({ printerName, copies, fileName, fileBase64, renderedHtml }) {
  const safeName = (fileName || 'document.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
  let targetPath = path.join(TMP_DIR, Date.now() + '_' + safeName);

  if (fileBase64) {
    fs.writeFileSync(targetPath, Buffer.from(fileBase64, 'base64'));
  } else {
    targetPath = targetPath.replace(/\\.[^.]+$/, '') + '.html';
    fs.writeFileSync(targetPath, '<html><body>' + (renderedHtml || '') + '</body></html>', 'utf-8');
  }

  const count = Math.max(1, Number(copies) || 1);
  if (process.platform === 'win32') {
    for (let i = 0; i < Math.min(count, 50); i++) {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        \`Start-Process -FilePath "\${targetPath}" -Verb PrintTo -ArgumentList "\${printerName}" -WindowStyle Hidden\`,
      ]);
    }
    return { ok: true, message: \`Dispatched \${count} copy print job to \${printerName} via Windows spooler.\` };
  }

  await execFileAsync('lp', ['-d', printerName, '-n', String(count), targetPath]);
  return { ok: true, message: \`Dispatched \${count} copies to \${printerName} via CUPS.\` };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/machines') {
    const machines = await listLocalMachines();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, platform: process.platform, machines }));
    return;
  }

  if (req.method === 'POST' && req.url === '/print') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        const result = await printLocalFile(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Damaria Docs Local Print Bridge running at http://127.0.0.1:' + PORT);
});
`;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const url = new URL(req.url);
  const routePath =
    url.pathname
      .replace(/^\/\.netlify\/functions\/api/, '')
      .replace(/^\/api/, '') || '/';

  // GET /api/health
  if (req.method === 'GET' && routePath === '/health') {
    return jsonResponse(
      { ok: true, runtime: 'netlify', timestamp: new Date().toISOString() },
      200,
      req
    );
  }

  const sessionSecret = await getSessionSecret();
  const isAdmin = verifyAdminToken(
    extractBearerToken(req.headers.get('authorization')),
    sessionSecret
  );

  // POST /api/admin/login
  if (req.method === 'POST' && routePath === '/admin/login') {
    try {
      const body = (await req.json()) as { password?: unknown };
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!verifyAdminPassword(password)) {
        return jsonResponse({ error: 'Incorrect admin password.' }, 401, req);
      }
      const session = createAdminToken(sessionSecret);
      return jsonResponse({ ok: true, ...session }, 200, req);
    } catch {
      return jsonResponse({ error: 'Invalid login request.' }, 400, req);
    }
  }

  // POST /api/admin/logout
  if (req.method === 'POST' && routePath === '/admin/logout') {
    return jsonResponse({ ok: true }, 200, req);
  }

  // GET /api/admin/session
  if (req.method === 'GET' && routePath === '/admin/session') {
    return jsonResponse({ authenticated: isAdmin }, 200, req);
  }

  // GET /api/bridge/script (Admin only)
  if (req.method === 'GET' && routePath === '/bridge/script') {
    if (!isAdmin) return jsonResponse({ error: 'Admin authentication required.' }, 401, req);
    return new Response(generateBridgeScript(), {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Disposition': 'attachment; filename="damaria-docs-bridge.mjs"',
        ...corsHeaders(req),
      },
    });
  }

  const store = await loadStore();

  // GET /api/bootstrap
  if (req.method === 'GET' && routePath === '/bootstrap') {
    if (isAdmin) {
      let updatedLegacy = false;
      for (const sub of store.submissions) {
        if (sub.fileType !== 'word' || !sub.fileUrl || !isPlaceholderWordHtml(sub.renderedHtml)) {
          continue;
        }
        const stored = await readUploadedFile(path.basename(sub.fileUrl));
        if (!stored) continue;
        try {
          const parsed = await parseWordBuffer(stored.buffer, sub.fileName || sub.title);
          if (parsed.html && !isPlaceholderWordHtml(parsed.html)) {
            sub.renderedHtml = parsed.html;
            sub.pageCount = Math.max(1, Math.min(300, parsed.pageCount || sub.pageCount || 1));
            updatedLegacy = true;
          }
        } catch {
          // ignore unreadable legacy file
        }
      }
      if (updatedLegacy) await saveStore(store);
    }

    const payload: BootstrapPayload = {
      ...store,
      publicDomain: 'https://damariadocs.com',
      liveAppUrl: process.env.URL || process.env.APP_URL || url.origin,
    };

    return jsonResponse(isAdmin ? payload : sanitizeBootstrapForPublic(payload), 200, req);
  }

  // GET /api/uploads/:fileKey (Admin only)
  const uploadMatch = routePath.match(/^\/uploads\/([^/]+)$/);
  if (req.method === 'GET' && uploadMatch) {
    if (!isAdmin) return jsonResponse({ error: 'Admin authentication required.' }, 401, req);
    const fileKey = path.basename(decodeURIComponent(uploadMatch[1]));
    const file = await readUploadedFile(fileKey);
    if (!file) return jsonResponse({ error: 'File not found.' }, 404, req);
    const bytes = new Uint8Array(file.buffer);
    return new Response(bytes.buffer, {
      status: 200,
      headers: {
        'Content-Type': file.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        ...corsHeaders(req),
      },
    });
  }

  // POST /api/submissions
  if (req.method === 'POST' && routePath === '/submissions') {
    try {
      const form = await req.formData();
      const senderName = String(form.get('senderName') || '').trim();
      const fileEntry = form.get('documentFile');

      if (!senderName) return jsonResponse({ error: 'Please enter your name.' }, 400);
      if (!fileEntry || typeof fileEntry === 'string') {
        return jsonResponse({ error: 'Please select a PDF or Word file.' }, 400);
      }

      const file = fileEntry as File;
      if (file.size > 5.5 * 1024 * 1024) {
        return jsonResponse(
          { error: 'File exceeds the 5.5 MB serverless upload limit. Please compress or split it.' },
          413
        );
      }

      const buf = Buffer.from(await file.arrayBuffer());
      const fileName = file.name || 'document';
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const fileKey = `${Date.now()}_${safeName}`;
      await saveUploadedFile(fileKey, buf, file.type || 'application/octet-stream', fileName);

      const rawTitle = String(form.get('title') || '').trim();
      const title = rawTitle || fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      const requestedCopies = Math.max(1, Math.min(5000, Number(form.get('requestedCopies')) || 1));
      const duplex = form.get('duplex') === 'true';
      const colorMode = form.get('colorMode') === 'color' ? 'color' : 'bw';
      const staple = form.get('staple') === 'true';
      const rawPaper = String(form.get('paperSize') || 'A4');
      const paperSize = (['A4', 'Letter', 'Legal'].includes(rawPaper)
        ? rawPaper
        : 'A4') as PaperSize;

      const lowerName = fileName.toLowerCase();
      const fileType: ExamSubmission['fileType'] =
        lowerName.endsWith('.pdf') || file.type === 'application/pdf'
          ? 'pdf'
          : lowerName.endsWith('.docx') ||
              lowerName.endsWith('.doc') ||
              (file.type || '').includes('word')
            ? 'word'
            : 'other';

      let renderedHtml = '';
      let estimatedPages = Number(form.get('pageCount')) || 0;

      if (lowerName.endsWith('.docx') || lowerName.endsWith('.doc') || fileType === 'word') {
        try {
          const parsed = await parseWordBuffer(buf, fileName);
          renderedHtml = parsed.html;
          if (!estimatedPages) {
            estimatedPages = parsed.pageCount;
          }
        } catch {
          renderedHtml = `<p>Word document <strong>${escapeHtml(fileName)}</strong> uploaded.</p>`;
        }
      } else if (lowerName.endsWith('.txt')) {
        const txt = buf.toString('utf-8');
        renderedHtml = `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(txt)}</pre>`;
        if (!estimatedPages) {
          estimatedPages = Math.max(1, Math.ceil(txt.split(/\s+/).length / 350));
        }
      }

      const pageCount = Math.max(1, Math.min(300, estimatedPages || 1));

      const submission: ExamSubmission = {
        id: uid('sub'),
        senderName,
        title,
        fileType,
        fileName,
        fileMime: file.type || 'application/octet-stream',
        fileSizeBytes: file.size,
        fileUrl: `/api/uploads/${fileKey}`,
        renderedHtml,
        pageCount,
        requestedCopies,
        printedCopies: 0,
        sheetsConsumed: 0,
        paperSize,
        duplex,
        colorMode,
        staple,
        notes: String(form.get('notes') || '').trim(),
        status: 'waiting',
        assignedPrinterId: store.printers[0]?.id ?? null,
        printMode: null,
        submittedAt: new Date().toISOString(),
        completedAt: null,
      };

      store.submissions.unshift(submission);
      appendLog(store, {
        actorName: senderName,
        action: 'DOCUMENT_SENT',
        examTitle: title,
        senderName,
        details: `Sent ${fileName} (${requestedCopies} copies, ${pageCount}p, ${paperSize}).`,
      });
      appendNotification(store, {
        type: 'DOCUMENT_SENT',
        audience: 'all',
        title: 'Document Sent',
        message: `${senderName} sent "${title}" (${requestedCopies} ${requestedCopies === 1 ? 'copy' : 'copies'}, ${paperSize}).`,
        submissionId: submission.id,
        senderName,
      });
      await saveStore(store);
      return jsonResponse(submission, 201);
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: 'Upload failed.' }, 500);
    }
  }

  // All remaining admin actions require valid Admin Bearer token
  if (!isAdmin) {
    return jsonResponse({ error: 'Admin authentication required.' }, 401, req);
  }

  // GET /api/submissions/:id/download
  const downloadMatch = routePath.match(/^\/submissions\/([^/]+)\/download$/);
  if (req.method === 'GET' && downloadMatch) {
    const id = decodeURIComponent(downloadMatch[1]);
    const job = store.submissions.find((s) => s.id === id);
    if (!job || !job.fileUrl) return jsonResponse({ error: 'File not found.' }, 404, req);
    const fileKey = path.basename(job.fileUrl);
    const file = await readUploadedFile(fileKey);
    if (!file) return jsonResponse({ error: 'File missing.' }, 404, req);
    const bytes = new Uint8Array(file.buffer);
    const safeDownloadName = (job.fileName || fileKey).replace(/"/g, '');
    return new Response(bytes.buffer, {
      status: 200,
      headers: {
        'Content-Type': job.fileMime || file.mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeDownloadName}"`,
        ...corsHeaders(req),
      },
    });
  }

  // POST /api/submissions/:id/print
  const printMatch = routePath.match(/^\/submissions\/([^/]+)\/print$/);
  if (req.method === 'POST' && printMatch) {
    const id = decodeURIComponent(printMatch[1]);
    const job = store.submissions.find((s) => s.id === id);
    if (!job) return jsonResponse({ error: 'Document not found.' }, 404, req);

    const body = (await req.json()) as {
      printerId?: string;
      copies?: number;
      bridgeAlreadySent?: boolean;
    };

    const printCopies = Math.max(1, Number(body.copies || job.requestedCopies));
    const sheetsPerCopy = calcSheetsPerCopy(job.pageCount, job.duplex);
    const sheetsNeeded = printCopies * sheetsPerCopy;

    if (body.printerId === 'browser-default') {
      const printerLabel = 'This Device (Browser Print)';
      job.requestedCopies = printCopies;
      job.printedCopies += printCopies;
      job.sheetsConsumed += sheetsNeeded;
      job.assignedPrinterId = 'browser-default';
      job.assignedPrinterName = printerLabel;
      job.printMode = 'manual';
      job.status = 'printed';
      job.completedAt = new Date().toISOString();

      appendLog(store, {
        actorName: 'Admin Print Desk',
        action: 'PRINT_COMPLETED',
        examTitle: job.title,
        senderName: job.senderName,
        printerName: printerLabel,
        printMode: 'manual',
        copiesProduced: printCopies,
        sheetsUsed: sheetsNeeded,
        details: `Printed ${printCopies} copies (${sheetsNeeded} ${job.paperSize} sheets) via This Device.`,
      });
      appendNotification(store, {
        type: 'PRINT_COMPLETED',
        audience: 'all',
        title: 'Printing Completed',
        message: `"${job.title}" for ${job.senderName} is done (${printCopies} ${printCopies === 1 ? 'copy' : 'copies'}, ${sheetsNeeded} sheets).`,
        submissionId: job.id,
        senderName: job.senderName,
        printerName: printerLabel,
      });
      await saveStore(store);
      return jsonResponse({ job, printer: null });
    }

    const printer = store.printers.find((p) => p.id === body.printerId);
    if (!printer) return jsonResponse({ error: 'Select a valid printer or use This Device.' }, 400);
    if (printer.status === 'offline') {
      return jsonResponse(
        { error: `${printer.name} is offline (${printer.connectionMessage}).` },
        400
      );
    }

    if (printer.traySheets !== null && printer.traySheets < sheetsNeeded) {
      return jsonResponse(
        {
          error: `${printer.name} has ${printer.traySheets} sheets loaded, but ${sheetsNeeded} sheets are needed.`,
        },
        400
      );
    }

    if (printer.connectionMode === 'digital' && !body.bridgeAlreadySent) {
      if (job.fileType === 'word') {
        return jsonResponse(
          {
            error:
              'Network IPP/TCP printers only accept PDF or images directly. Print Word documents using Browser Print.',
          },
          400
        );
      }

      let fileBuffer: Buffer;
      if (job.fileUrl) {
        const stored = await readUploadedFile(path.basename(job.fileUrl));
        fileBuffer = stored
          ? stored.buffer
          : Buffer.from(job.renderedHtml || job.title, 'utf-8');
      } else {
        fileBuffer = Buffer.from(job.renderedHtml || job.title, 'utf-8');
      }

      const isIppUrl =
        printer.endpoint.startsWith('http://') ||
        printer.endpoint.startsWith('https://') ||
        printer.endpoint.startsWith('ipp://') ||
        printer.endpoint.startsWith('ipps://');

      const tx = isIppUrl
        ? await sendIppPrintJob(
            printer.endpoint,
            fileBuffer,
            job.title,
            printCopies,
            job.duplex,
            job.fileMime || 'application/octet-stream'
          )
        : await sendTcpPrintPayload(printer.endpoint, fileBuffer, printCopies);

      if (!tx.ok) {
        printer.status = 'offline';
        printer.hardwareState = 'Print Transmission Failed';
        printer.connectionMessage = tx.message;
        appendLog(store, {
          actorName: 'Admin Print Desk',
          action: 'PRINT_FAILED',
          examTitle: job.title,
          senderName: job.senderName,
          printerName: printer.name,
          printMode: 'digital',
          details: tx.message,
        });
        appendNotification(store, {
          type: 'PRINT_FAILED',
          audience: 'all',
          title: 'Print Failed',
          message: `Printing "${job.title}" failed on ${printer.name}: ${tx.message}`,
          submissionId: job.id,
          senderName: job.senderName,
          printerName: printer.name,
        });
        await saveStore(store);
        return jsonResponse({ error: tx.message }, 502);
      }
    }

    if (printer.traySheets !== null) {
      printer.traySheets = Math.max(0, printer.traySheets - sheetsNeeded);
      printer.paperState = `${printer.traySheets} sheets in tray`;
    }
    printer.totalSheetsPrinted += sheetsNeeded;

    if (printer.ink.black !== null) {
      printer.ink.black = Math.max(0, Number((printer.ink.black - sheetsNeeded * 0.02).toFixed(2)));
    }

    job.requestedCopies = printCopies;
    job.printedCopies += printCopies;
    job.sheetsConsumed += sheetsNeeded;
    job.assignedPrinterId = printer.id;
    job.assignedPrinterName = printer.name;
    job.printMode = printer.connectionMode;
    job.status = 'printed';
    job.completedAt = new Date().toISOString();

    appendLog(store, {
      actorName: 'Admin Print Desk',
      action: 'PRINT_COMPLETED',
      examTitle: job.title,
      senderName: job.senderName,
      printerName: printer.name,
      printMode: printer.connectionMode,
      copiesProduced: printCopies,
      sheetsUsed: sheetsNeeded,
      details: `Printed ${printCopies} copies (${sheetsNeeded} ${job.paperSize} sheets) on ${printer.name}.`,
    });
    appendNotification(store, {
      type: 'PRINT_COMPLETED',
      audience: 'all',
      title: 'Printing Completed',
      message: `"${job.title}" for ${job.senderName} is done (${printCopies} ${printCopies === 1 ? 'copy' : 'copies'} on ${printer.name}).`,
      submissionId: job.id,
      senderName: job.senderName,
      printerName: printer.name,
    });
    await saveStore(store);
    return jsonResponse({ job, printer });
  }

  // DELETE /api/submissions/:id
  const deleteSubMatch = routePath.match(/^\/submissions\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteSubMatch) {
    const id = decodeURIComponent(deleteSubMatch[1]);
    const idx = store.submissions.findIndex((s) => s.id === id);
    if (idx === -1) return jsonResponse({ error: 'Document not found.' }, 404);

    const [removed] = store.submissions.splice(idx, 1);
    if (removed.fileUrl) {
      await deleteUploadedFile(path.basename(removed.fileUrl));
    }

    appendLog(store, {
      actorName: 'Admin Print Desk',
      action: 'DOCUMENT_DELETED',
      examTitle: removed.title,
      senderName: removed.senderName,
      details: `Deleted "${removed.title}" (${removed.fileName || 'file'}).`,
    });
    appendNotification(store, {
      type: 'DOCUMENT_DELETED',
      audience: 'all',
      title: 'Document Deleted',
      message: `Removed "${removed.title}" sent by ${removed.senderName}.`,
      submissionId: removed.id,
      senderName: removed.senderName,
    });
    await saveStore(store);
    return jsonResponse({ deleted: true, id: removed.id });
  }

  // POST /api/printers
  if (req.method === 'POST' && routePath === '/printers') {
    const body = (await req.json()) as {
      name?: string;
      deviceType?: DeviceType;
      location?: string;
      connectionMode?: PrinterConnectionMode;
      endpoint?: string;
      isColor?: boolean;
      traySheets?: number | null;
      usbInfo?: UsbHardwareInfo;
      hardwareState?: string;
      inkBlack?: number | null;
      paperState?: string;
    };

    const mode: PrinterConnectionMode = body.connectionMode === 'manual' ? 'manual' : 'digital';
    const dType: DeviceType = body.deviceType === 'photocopier' ? 'photocopier' : 'printer';
    const cleanName =
      String(body.name || '').trim() || (dType === 'photocopier' ? 'Photocopier' : 'Printer');
    const cleanEndpoint = String(body.endpoint || '').trim();
    const loadedSheets =
      body.traySheets !== undefined && body.traySheets !== null && Number(body.traySheets) >= 0
        ? Number(body.traySheets)
        : null;

    let printer: PrinterDevice;

    if (mode === 'digital') {
      const probe = await probeDigitalMachine(cleanEndpoint);
      printer = {
        id: uid('prt'),
        name: cleanName,
        deviceType: dType,
        location: String(body.location || 'Print Room').trim(),
        connectionMode: 'digital',
        endpoint: cleanEndpoint,
        status: probe.connected ? 'connected-digital' : 'offline',
        hardwareState: probe.hardwareState,
        connectionMessage: probe.message,
        telemetrySource: probe.telemetrySource,
        lastCheckedAt: new Date().toISOString(),
        isColor: Boolean(body.isColor),
        ink: {
          black: probe.inkBlack,
          cyan: probe.inkCyan,
          magenta: probe.inkMagenta,
          yellow: probe.inkYellow,
        },
        supplyNote: probe.supplyNote,
        traySheets: loadedSheets,
        trayCapacity: loadedSheets ? Math.max(500, loadedSheets) : null,
        paperState: probe.paperState,
        totalSheetsPrinted: 0,
        imageUrl: body.isColor
          ? '/src/assets/images/printer_ecotank_color_1794773700020.jpg'
          : '/src/assets/images/printer_enterprise_laser_1794773699477.jpg',
      };
    } else {
      const existingByUsb =
        body.usbInfo?.vendorId && body.usbInfo?.productId
          ? store.printers.find(
              (p) =>
                p.usbInfo?.vendorId === body.usbInfo?.vendorId &&
                p.usbInfo?.productId === body.usbInfo?.productId
            )
          : undefined;

      if (existingByUsb) {
        existingByUsb.name = cleanName;
        existingByUsb.deviceType = dType;
        existingByUsb.status = 'connected-manual';
        existingByUsb.hardwareState = body.hardwareState || 'USB Port Connected';
        existingByUsb.connectionMessage = `USB Port Connected (${body.usbInfo?.portLabel || ''})`;
        existingByUsb.usbInfo = body.usbInfo;
        existingByUsb.lastCheckedAt = new Date().toISOString();
        if (body.inkBlack !== undefined && body.inkBlack !== null) {
          existingByUsb.ink.black = body.inkBlack;
        }
        if (body.paperState) existingByUsb.paperState = body.paperState;
        appendLog(store, {
          actorName: 'USB Port Monitor',
          action: 'PRINTER_CONNECTED',
          printerName: existingByUsb.name,
          printMode: 'manual',
          details: `Detected USB device ${existingByUsb.name} (${body.usbInfo?.portLabel || ''}).`,
        });
        await saveStore(store);
        return jsonResponse(existingByUsb, 200);
      }

      printer = {
        id: uid('prt'),
        name: cleanName,
        deviceType: dType,
        location: String(body.location || 'Print Room').trim(),
        connectionMode: 'manual',
        endpoint: cleanEndpoint || body.usbInfo?.portLabel || 'Local USB / OS Print Spooler',
        status: 'connected-manual',
        hardwareState:
          body.hardwareState || (body.usbInfo ? 'USB Port Connected' : 'Local OS Spooler Ready'),
        connectionMessage: body.usbInfo?.vendorId
          ? `USB Port Recognized (${body.usbInfo.portLabel || ''})`
          : 'Connected via Manual / Local OS Print Spooler',
        telemetrySource:
          body.inkBlack !== undefined && body.inkBlack !== null ? 'pjl' : 'none',
        lastCheckedAt: new Date().toISOString(),
        usbInfo: body.usbInfo,
        isColor: Boolean(body.isColor),
        ink: {
          black: body.inkBlack ?? null,
          cyan: null,
          magenta: null,
          yellow: null,
        },
        supplyNote:
          body.inkBlack !== undefined && body.inkBlack !== null
            ? 'Live USB PJL supply reading'
            : 'Driver hides ink % · Check physical machine panel',
        traySheets: loadedSheets,
        trayCapacity: loadedSheets ? Math.max(500, loadedSheets) : null,
        paperState:
          body.paperState ||
          (loadedSheets !== null
            ? `${loadedSheets} sheets loaded`
            : 'Ready (tray count not exposed by USB driver)'),
        totalSheetsPrinted: 0,
        imageUrl: body.isColor
          ? '/src/assets/images/printer_ecotank_color_1794773700020.jpg'
          : '/src/assets/images/printer_enterprise_laser_1794773699477.jpg',
      };
    }

    store.printers.push(printer);
    appendLog(store, {
      actorName: 'Admin Print Desk',
      action: printer.status === 'offline' ? 'PRINTER_OFFLINE' : 'PRINTER_CONNECTED',
      printerName: printer.name,
      printMode: mode,
      details: `${printer.name} (${dType}): ${printer.connectionMessage}`,
    });
    appendNotification(store, {
      type: printer.status === 'offline' ? 'PRINTER_OFFLINE' : 'PRINTER_CONNECTED',
      audience: 'admin',
      title: printer.status === 'offline' ? 'Machine Offline' : 'Machine Connected',
      message: `${printer.name}: ${printer.connectionMessage}`,
      printerName: printer.name,
    });
    await saveStore(store);
    return jsonResponse(printer, 201);
  }

  // POST /api/printers/usb-sync
  if (req.method === 'POST' && routePath === '/printers/usb-sync') {
    const { pairedDevices } = (await req.json()) as {
      pairedDevices: Array<{ vendorId: number; productId: number; name?: string }>;
    };
    if (!Array.isArray(pairedDevices)) return jsonResponse({ updated: 0 });
    let updated = 0;
    for (const printer of store.printers) {
      if (!printer.usbInfo?.vendorId || !printer.usbInfo?.productId) continue;
      const isPlugged = pairedDevices.some(
        (d) =>
          d.vendorId === printer.usbInfo?.vendorId && d.productId === printer.usbInfo?.productId
      );
      const nextStatus: PrinterDevice['status'] = isPlugged ? 'connected-manual' : 'offline';
      if (printer.status !== nextStatus) {
        printer.status = nextStatus;
        printer.hardwareState = isPlugged ? 'USB Port Connected' : 'USB Cable Unplugged';
        printer.connectionMessage = isPlugged
          ? `USB Port Active (${printer.usbInfo.portLabel || ''})`
          : 'USB cable unplugged or machine powered off.';
        printer.lastCheckedAt = new Date().toISOString();
        updated++;
      }
    }
    if (updated > 0) await saveStore(store);
    return jsonResponse({ updated });
  }

  // POST /api/printers/usb-event
  if (req.method === 'POST' && routePath === '/printers/usb-event') {
    const { event, vendorId, productId, productName, manufacturer } = (await req.json()) as {
      event: 'connect' | 'disconnect';
      vendorId: number;
      productId: number;
      productName?: string;
      manufacturer?: string;
    };

    const existing = store.printers.find(
      (p) => p.usbInfo?.vendorId === vendorId && p.usbInfo?.productId === productId
    );
    if (!existing) return jsonResponse({ matched: false });

    if (event === 'disconnect') {
      existing.status = 'offline';
      existing.hardwareState = 'USB Cable Unplugged';
      existing.connectionMessage = 'USB port disconnected from computer.';
      existing.lastCheckedAt = new Date().toISOString();
      appendLog(store, {
        actorName: 'USB Port Monitor',
        action: 'PRINTER_OFFLINE',
        printerName: existing.name,
        printMode: 'manual',
        details: `Detected USB cable unplugged (${manufacturer || ''} ${productName || ''}).`,
      });
    } else {
      existing.status = 'connected-manual';
      existing.hardwareState = 'USB Port Connected';
      existing.connectionMessage = `USB port reconnected (VID:${vendorId.toString(16)} PID:${productId.toString(16)})`;
      existing.lastCheckedAt = new Date().toISOString();
      appendLog(store, {
        actorName: 'USB Port Monitor',
        action: 'PRINTER_CONNECTED',
        printerName: existing.name,
        printMode: 'manual',
        details: `Detected USB cable plugged in (${manufacturer || ''} ${productName || ''}).`,
      });
    }

    await saveStore(store);
    return jsonResponse({ matched: true, printer: existing });
  }

  // POST /api/printers/sync-bridge
  if (req.method === 'POST' && routePath === '/printers/sync-bridge') {
    const { machines } = (await req.json()) as {
      machines: Array<{
        name: string;
        portName: string;
        driverName: string;
        isUsb: boolean;
        online: boolean;
        statusText: string;
        inkBlack: number | null;
        paperState: string;
      }>;
    };
    if (!Array.isArray(machines)) return jsonResponse({ error: 'Invalid bridge payload.' }, 400);

    const nowIso = new Date().toISOString();
    for (const m of machines) {
      let existing = store.printers.find((p) => p.name === m.name);
      const newStatus: PrinterDevice['status'] = m.online ? 'connected-manual' : 'offline';

      if (!existing) {
        existing = {
          id: uid('prt'),
          name: m.name,
          deviceType: /copier|mfp|multifunction|ir|ricoh|xerox|kyocera|konica/i.test(m.name)
            ? 'photocopier'
            : 'printer',
          location: 'Local PC Bridge',
          connectionMode: 'manual',
          endpoint: `BRIDGE · ${m.portName}`,
          status: newStatus,
          hardwareState: m.statusText,
          connectionMessage: `${m.isUsb ? 'USB' : 'Local'} port ${m.portName} (${m.statusText})`,
          telemetrySource: 'bridge',
          lastCheckedAt: nowIso,
          usbInfo: m.isUsb ? { portLabel: m.portName } : undefined,
          isColor: /color/i.test(m.name + m.driverName),
          ink: { black: m.inkBlack },
          supplyNote:
            m.inkBlack !== null ? 'Live OS Bridge reading' : `Machine status: ${m.statusText}`,
          traySheets: null,
          trayCapacity: null,
          paperState: m.paperState,
          totalSheetsPrinted: 0,
          imageUrl: '/src/assets/images/printer_enterprise_laser_1794773699477.jpg',
        };
        store.printers.push(existing);
        appendLog(store, {
          actorName: 'Local Print Bridge',
          action: m.online ? 'PRINTER_CONNECTED' : 'PRINTER_OFFLINE',
          printerName: existing.name,
          printMode: 'manual',
          details: `Auto-detected ${existing.name} on ${m.portName} (${m.statusText}).`,
        });
      } else {
        const statusChanged = existing.status !== newStatus;
        existing.status = newStatus;
        existing.hardwareState = m.statusText;
        existing.endpoint = `BRIDGE · ${m.portName}`;
        existing.connectionMessage = `${m.isUsb ? 'USB' : 'Local'} port ${m.portName} (${m.statusText})`;
        existing.telemetrySource = 'bridge';
        existing.lastCheckedAt = nowIso;
        if (m.inkBlack !== null) existing.ink.black = m.inkBlack;
        existing.paperState = m.paperState;
        if (statusChanged) {
          appendLog(store, {
            actorName: 'Local Print Bridge',
            action: m.online ? 'PRINTER_CONNECTED' : 'PRINTER_OFFLINE',
            printerName: existing.name,
            printMode: 'manual',
            details: `${existing.name} status changed to ${m.statusText}.`,
          });
        }
      }
    }

    await saveStore(store);
    return jsonResponse({ printers: store.printers });
  }

  // POST /api/printers/:id/verify
  const verifyMatch = routePath.match(/^\/printers\/([^/]+)\/verify$/);
  if (req.method === 'POST' && verifyMatch) {
    const id = decodeURIComponent(verifyMatch[1]);
    const printer = store.printers.find((p) => p.id === id);
    if (!printer) return jsonResponse({ error: 'Machine not found.' }, 404);

    if (printer.connectionMode === 'digital') {
      const probe = await probeDigitalMachine(printer.endpoint);
      printer.status = probe.connected ? 'connected-digital' : 'offline';
      printer.hardwareState = probe.hardwareState;
      printer.connectionMessage = probe.message;
      printer.telemetrySource = probe.telemetrySource;
      printer.ink.black = probe.inkBlack;
      printer.ink.cyan = probe.inkCyan;
      printer.ink.magenta = probe.inkMagenta;
      printer.ink.yellow = probe.inkYellow;
      printer.supplyNote = probe.supplyNote;
      printer.paperState = probe.paperState;
      printer.lastCheckedAt = new Date().toISOString();
      appendLog(store, {
        actorName: 'Admin Print Desk',
        action: probe.connected ? 'PRINTER_CONNECTED' : 'PRINTER_OFFLINE',
        printerName: printer.name,
        printMode: 'digital',
        details: probe.message,
      });
    } else {
      printer.lastCheckedAt = new Date().toISOString();
    }

    await saveStore(store);
    return jsonResponse(printer);
  }

  // PATCH /api/printers/:id
  const patchPrinterMatch = routePath.match(/^\/printers\/([^/]+)$/);
  if (req.method === 'PATCH' && patchPrinterMatch) {
    const id = decodeURIComponent(patchPrinterMatch[1]);
    const printer = store.printers.find((p) => p.id === id);
    if (!printer) return jsonResponse({ error: 'Machine not found.' }, 404);

    const { connectionMode, endpoint, setTraySheets, status } = (await req.json()) as {
      connectionMode?: PrinterConnectionMode;
      endpoint?: string;
      setTraySheets?: number | null;
      status?: PrinterDevice['status'];
    };

    if (endpoint !== undefined) printer.endpoint = String(endpoint).trim();

    if (connectionMode === 'digital' || connectionMode === 'manual') {
      printer.connectionMode = connectionMode;
      if (connectionMode === 'digital') {
        const probe = await probeDigitalMachine(printer.endpoint);
        printer.status = probe.connected ? 'connected-digital' : 'offline';
        printer.hardwareState = probe.hardwareState;
        printer.connectionMessage = probe.message;
        printer.ink.black = probe.inkBlack;
        printer.supplyNote = probe.supplyNote;
        printer.paperState = probe.paperState;
      } else {
        printer.status = 'connected-manual';
        printer.hardwareState = 'Local OS Spooler Ready';
        printer.connectionMessage = 'Switched to Manual / USB mode';
      }
      printer.lastCheckedAt = new Date().toISOString();
    }

    if (status === 'offline' || status === 'connected-manual') {
      printer.status = status;
      printer.hardwareState = status === 'offline' ? 'Offline' : 'Manual Ready';
    }

    if (setTraySheets !== undefined && setTraySheets !== null) {
      const sheets = Math.max(0, Number(setTraySheets));
      printer.traySheets = sheets;
      printer.trayCapacity = Math.max(printer.trayCapacity || 500, sheets);
      printer.paperState = `${sheets} sheets in tray`;
      appendLog(store, {
        actorName: 'Admin Print Desk',
        action: 'PAPER_UPDATED',
        printerName: printer.name,
        details: `Updated ${printer.name} loaded paper tray to ${sheets} sheets.`,
      });
      appendNotification(store, {
        type: 'PAPER_UPDATED',
        audience: 'admin',
        title: 'Paper Tray Updated',
        message: `${printer.name} tray updated to ${sheets} sheets.`,
        printerName: printer.name,
      });
    }

    await saveStore(store);
    return jsonResponse(printer);
  }

  // DELETE /api/printers/:id
  const deletePrinterMatch = routePath.match(/^\/printers\/([^/]+)$/);
  if (req.method === 'DELETE' && deletePrinterMatch) {
    const id = decodeURIComponent(deletePrinterMatch[1]);
    const idx = store.printers.findIndex((p) => p.id === id);
    if (idx === -1) return jsonResponse({ error: 'Machine not found.' }, 404);
    const [removed] = store.printers.splice(idx, 1);
    appendLog(store, {
      actorName: 'Admin Print Desk',
      action: 'PRINTER_REMOVED',
      printerName: removed.name,
      details: `Removed ${removed.name}.`,
    });
    appendNotification(store, {
      type: 'PRINTER_REMOVED',
      audience: 'admin',
      title: 'Machine Removed',
      message: `Removed ${removed.name} from Machines.`,
      printerName: removed.name,
    });
    await saveStore(store);
    return jsonResponse({ deleted: true });
  }

  // DELETE /api/logs/:id
  const deleteLogMatch = routePath.match(/^\/logs\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteLogMatch) {
    const id = decodeURIComponent(deleteLogMatch[1]);
    const idx = store.logs.findIndex((l) => l.id === id);
    if (idx === -1) return jsonResponse({ error: 'Log entry not found.' }, 404);
    store.logs.splice(idx, 1);
    appendNotification(store, {
      type: 'LOGS_DELETED',
      audience: 'admin',
      title: 'History Log Deleted',
      message: 'Removed 1 entry from Activity Logs.',
    });
    await saveStore(store);
    return jsonResponse({ deleted: true, id });
  }

  // DELETE /api/logs
  if (req.method === 'DELETE' && routePath === '/logs') {
    let ids: string[] | null = null;
    try {
      const body = (await req.json()) as { ids?: unknown };
      if (Array.isArray(body?.ids)) {
        ids = body.ids.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      // empty body -> clear all
    }
    let deletedCount = 0;
    if (ids && ids.length > 0) {
      const idSet = new Set(ids);
      const before = store.logs.length;
      store.logs = store.logs.filter((l) => !idSet.has(l.id));
      deletedCount = before - store.logs.length;
    } else {
      deletedCount = store.logs.length;
      store.logs = [];
    }
    appendNotification(store, {
      type: 'LOGS_DELETED',
      audience: 'admin',
      title: 'Activity Logs Cleared',
      message: `Removed ${deletedCount} ${deletedCount === 1 ? 'entry' : 'entries'} from Activity Logs.`,
    });
    await saveStore(store);
    return jsonResponse({ deletedCount, remaining: store.logs.length });
  }

  // GET /api/logs/export
  if (req.method === 'GET' && routePath === '/logs/export') {
    const header = [
      'Timestamp',
      'Actor',
      'Action',
      'Document',
      'Sender',
      'Machine',
      'Mode',
      'Copies',
      'Sheets',
      'Details',
    ];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = store.logs.map((l) =>
      [
        l.timestamp,
        l.actorName,
        l.action,
        l.examTitle,
        l.senderName,
        l.printerName,
        l.printMode,
        l.copiesProduced,
        l.sheetsUsed,
        l.details,
      ]
        .map(esc)
        .join(',')
    );
    return new Response([header.join(','), ...rows].join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="print-history.csv"',
        ...corsHeaders(req),
      },
    });
  }

  return jsonResponse({ error: `Not found: ${req.method} ${routePath}` }, 404, req);
}

export const config = {
  path: '/api/*',
};
