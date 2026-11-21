import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import net from 'net';
import path from 'path';
import multer from 'multer';
import mammoth from 'mammoth';
import { createServer as createViteServer } from 'vite';
import {
  createAdminToken,
  extractBearerToken,
  sanitizeBootstrapForPublic,
  verifyAdminPassword,
  verifyAdminToken,
} from './adminAuth.ts';
import { queryIppPrinter, sendIppPrintJob } from './src/utils/ipp.ts';
import {
  isPlaceholderWordHtml,
  MAMMOTH_STYLE_MAP,
  parseWordDocumentBytes,
} from './src/utils/docParser.ts';
import type {
  BootstrapPayload,
  DeviceType,
  ExamSubmission,
  HistoryLogEntry,
  PaperSize,
  PrinterConnectionMode,
  PrinterDevice,
  TelemetrySource,
  UsbHardwareInfo,
} from './src/types.ts';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const SCHEMA_VERSION = 4;

function ensureDirsSync() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

ensureDirsSync();

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function calcSheetsPerCopy(pageCount: number, duplex: boolean): number {
  const safe = Math.max(1, Math.round(pageCount));
  return duplex ? Math.ceil(safe / 2) : safe;
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

function loadStore(): BootstrapPayload {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as BootstrapPayload;
      if (parsed.schemaVersion === SCHEMA_VERSION) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Recreating clean store:', err);
  }
  const initial = createEmptyStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(initial, null, 2));
  return initial;
}

let store: BootstrapPayload = loadStore();
let writeChain: Promise<void> = Promise.resolve();

function persistStore() {
  const snapshot = JSON.stringify(store, null, 2);
  writeChain = writeChain
    .then(() => fsp.writeFile(STORE_PATH, snapshot, 'utf-8'))
    .catch((err) => console.error('Failed saving store:', err));
}

function appendLog(entry: Omit<HistoryLogEntry, 'id' | 'timestamp'>) {
  const full: HistoryLogEntry = {
    id: uid('log'),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  store.logs.unshift(full);
  if (store.logs.length > 500) store.logs.length = 500;
  return full;
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

async function reparseLegacyWordSubmissions() {
  let changed = false;
  for (const sub of store.submissions) {
    if (sub.fileType !== 'word' || !sub.fileUrl || !isPlaceholderWordHtml(sub.renderedHtml)) {
      continue;
    }
    const localFile = path.join(UPLOAD_DIR, path.basename(sub.fileUrl));
    if (!fs.existsSync(localFile)) continue;
    try {
      const buf = await fsp.readFile(localFile);
      const parsed = await parseWordBuffer(buf, sub.fileName || sub.title);
      if (parsed.html && !isPlaceholderWordHtml(parsed.html)) {
        sub.renderedHtml = parsed.html;
        sub.pageCount = Math.max(1, Math.min(300, parsed.pageCount || sub.pageCount || 1));
        changed = true;
      }
    } catch {
      // ignore unreadable legacy file
    }
  }
  if (changed) persistStore();
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
    } catch (err) {
      return [];
    }
  }

  // macOS / Linux CUPS
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

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
});

async function startServer() {
  const app = express();
  const ADMIN_SESSION_SECRET =
    process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex');

  function isAdminRequest(req: Request): boolean {
    const token = extractBearerToken(req.headers.authorization);
    return verifyAdminToken(token, ADMIN_SESSION_SECRET);
  }

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!isAdminRequest(req)) {
      return res.status(401).json({ error: 'Admin authentication required.' });
    }
    next();
  }

  const extraOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isAllowed =
      !origin ||
      origin === 'https://damariadocs.com' ||
      origin === 'https://www.damariadocs.com' ||
      /^https:\/\/[a-z0-9-]+\.netlify\.app$/i.test(origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
      extraOrigins.includes(origin);

    if (origin && isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use('/api/uploads', requireAdmin, express.static(UPLOAD_DIR));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.post('/api/admin/login', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!verifyAdminPassword(password)) {
      return res.status(401).json({ error: 'Incorrect admin password.' });
    }
    const session = createAdminToken(ADMIN_SESSION_SECRET);
    return res.json({ ok: true, ...session });
  });

  app.post('/api/admin/logout', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/admin/session', (req, res) => {
    res.json({ authenticated: isAdminRequest(req) });
  });

  app.get('/api/bootstrap', async (req, res) => {
    const admin = isAdminRequest(req);
    if (admin) {
      await reparseLegacyWordSubmissions();
    }
    const payload: BootstrapPayload = {
      ...store,
      publicDomain: 'https://damariadocs.com',
      liveAppUrl: process.env.APP_URL || '',
    };
    res.json(admin ? payload : sanitizeBootstrapForPublic(payload));
  });

  app.get('/api/bridge/script', requireAdmin, (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="damaria-docs-bridge.mjs"');
    res.send(generateBridgeScript());
  });

  // Upload PDF or Word file
  app.post('/api/submissions', upload.single('documentFile'), async (req, res) => {
    try {
      const body = req.body;
      const senderName = String(body.senderName || '').trim();
      if (!senderName) return res.status(400).json({ error: 'Please enter your name.' });
      if (!req.file) return res.status(400).json({ error: 'Please select a PDF or Word file.' });

      const fileName = req.file.originalname;
      const rawTitle = String(body.title || '').trim();
      const title = rawTitle || fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');

      const requestedCopies = Math.max(1, Math.min(5000, Number(body.requestedCopies) || 1));
      const duplex = body.duplex === true || body.duplex === 'true';
      const colorMode = body.colorMode === 'color' ? 'color' : 'bw';
      const staple = body.staple === true || body.staple === 'true';
      const paperSize = (['A4', 'Letter', 'Legal'].includes(body.paperSize)
        ? body.paperSize
        : 'A4') as PaperSize;

      const lowerName = fileName.toLowerCase();
      const fileType: ExamSubmission['fileType'] =
        lowerName.endsWith('.pdf') || req.file.mimetype === 'application/pdf'
          ? 'pdf'
          : lowerName.endsWith('.docx') ||
              lowerName.endsWith('.doc') ||
              req.file.mimetype.includes('word')
            ? 'word'
            : 'other';

      let renderedHtml = '';
      let estimatedPages = Number(body.pageCount) || 0;

      if (lowerName.endsWith('.docx') || lowerName.endsWith('.doc') || fileType === 'word') {
        try {
          const buf = await fsp.readFile(req.file.path);
          const parsed = await parseWordBuffer(buf, fileName);
          renderedHtml = parsed.html;
          if (!estimatedPages) {
            estimatedPages = parsed.pageCount;
          }
        } catch {
          renderedHtml = `<p>Word document <strong>${escapeHtml(fileName)}</strong> uploaded.</p>`;
        }
      } else if (lowerName.endsWith('.txt')) {
        const txt = await fsp.readFile(req.file.path, 'utf-8');
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
        fileMime: req.file.mimetype,
        fileSizeBytes: req.file.size,
        fileUrl: `/api/uploads/${req.file.filename}`,
        renderedHtml,
        pageCount,
        requestedCopies,
        printedCopies: 0,
        sheetsConsumed: 0,
        paperSize,
        duplex,
        colorMode,
        staple,
        notes: String(body.notes || '').trim(),
        status: 'waiting',
        assignedPrinterId: store.printers[0]?.id ?? null,
        printMode: null,
        submittedAt: new Date().toISOString(),
        completedAt: null,
      };

      store.submissions.unshift(submission);
      appendLog({
        actorName: senderName,
        action: 'DOCUMENT_SENT',
        examTitle: title,
        senderName,
        details: `Sent ${fileName} (${requestedCopies} copies, ${pageCount}p, ${paperSize}).`,
      });
      persistStore();
      res.status(201).json(submission);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Upload failed.' });
    }
  });

  // Delete document (Admin only)
  app.delete('/api/submissions/:id', requireAdmin, async (req, res) => {
    const idx = store.submissions.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Document not found.' });

    const [removed] = store.submissions.splice(idx, 1);
    if (removed.fileUrl) {
      const localPath = path.resolve(UPLOAD_DIR, path.basename(removed.fileUrl));
      if (localPath.startsWith(UPLOAD_DIR + path.sep)) {
        try {
          if (fs.existsSync(localPath)) await fsp.unlink(localPath);
        } catch (err) {
          console.error('Failed unlinking file:', err);
        }
      }
    }

    appendLog({
      actorName: 'Admin Print Desk',
      action: 'DOCUMENT_DELETED',
      examTitle: removed.title,
      senderName: removed.senderName,
      details: `Deleted "${removed.title}" (${removed.fileName || 'file'}).`,
    });
    persistStore();
    res.json({ deleted: true, id: removed.id });
  });

  // Download file (Admin only)
  app.get('/api/submissions/:id/download', requireAdmin, (req, res) => {
    const job = store.submissions.find((s) => s.id === req.params.id);
    if (!job || !job.fileUrl) return res.status(404).json({ error: 'File not found.' });
    const localFile = path.resolve(UPLOAD_DIR, path.basename(job.fileUrl));
    if (!localFile.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(localFile)) {
      return res.status(404).json({ error: 'File missing.' });
    }
    return res.download(localFile, job.fileName || path.basename(localFile));
  });

  // Connect Printer or Photocopier (Admin only)
  app.post('/api/printers', requireAdmin, async (req, res) => {
    const {
      name,
      deviceType,
      location,
      connectionMode,
      endpoint,
      isColor,
      traySheets,
      usbInfo,
      hardwareState,
      inkBlack,
      paperState,
    } = req.body as {
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

    const mode: PrinterConnectionMode = connectionMode === 'manual' ? 'manual' : 'digital';
    const dType: DeviceType = deviceType === 'photocopier' ? 'photocopier' : 'printer';
    const cleanName = String(name || '').trim() || (dType === 'photocopier' ? 'Photocopier' : 'Printer');
    const cleanEndpoint = String(endpoint || '').trim();
    const loadedSheets = traySheets !== undefined && traySheets !== null && Number(traySheets) >= 0
      ? Number(traySheets)
      : null;

    let printer: PrinterDevice;

    if (mode === 'digital') {
      const probe = await probeDigitalMachine(cleanEndpoint);
      printer = {
        id: uid('prt'),
        name: cleanName,
        deviceType: dType,
        location: String(location || 'Print Room').trim(),
        connectionMode: 'digital',
        endpoint: cleanEndpoint,
        status: probe.connected ? 'connected-digital' : 'offline',
        hardwareState: probe.hardwareState,
        connectionMessage: probe.message,
        telemetrySource: probe.telemetrySource,
        lastCheckedAt: new Date().toISOString(),
        isColor: Boolean(isColor),
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
        imageUrl: isColor
          ? '/src/assets/images/printer_ecotank_color_1794773700020.jpg'
          : '/src/assets/images/printer_enterprise_laser_1794773699477.jpg',
      };
    } else {
      const existingByUsb = usbInfo?.vendorId && usbInfo?.productId
        ? store.printers.find(
            (p) => p.usbInfo?.vendorId === usbInfo.vendorId && p.usbInfo?.productId === usbInfo.productId
          )
        : undefined;

      if (existingByUsb) {
        existingByUsb.name = cleanName;
        existingByUsb.deviceType = dType;
        existingByUsb.status = 'connected-manual';
        existingByUsb.hardwareState = hardwareState || 'USB Port Connected';
        existingByUsb.connectionMessage = `USB Port Connected (${usbInfo?.portLabel || ''})`;
        existingByUsb.usbInfo = usbInfo;
        existingByUsb.lastCheckedAt = new Date().toISOString();
        if (inkBlack !== undefined && inkBlack !== null) existingByUsb.ink.black = inkBlack;
        if (paperState) existingByUsb.paperState = paperState;
        appendLog({
          actorName: 'USB Port Monitor',
          action: 'PRINTER_CONNECTED',
          printerName: existingByUsb.name,
          printMode: 'manual',
          details: `Detected USB device ${existingByUsb.name} (${usbInfo?.portLabel || ''}).`,
        });
        persistStore();
        return res.status(200).json(existingByUsb);
      }

      printer = {
        id: uid('prt'),
        name: cleanName,
        deviceType: dType,
        location: String(location || 'Print Room').trim(),
        connectionMode: 'manual',
        endpoint: cleanEndpoint || usbInfo?.portLabel || 'Local USB / OS Print Spooler',
        status: 'connected-manual',
        hardwareState: hardwareState || (usbInfo ? 'USB Port Connected' : 'Local OS Spooler Ready'),
        connectionMessage: usbInfo?.vendorId
          ? `USB Port Recognized (${usbInfo.portLabel || ''})`
          : 'Connected via Manual / Local OS Print Spooler',
        telemetrySource: inkBlack !== undefined && inkBlack !== null ? 'pjl' : 'none',
        lastCheckedAt: new Date().toISOString(),
        usbInfo,
        isColor: Boolean(isColor),
        ink: {
          black: inkBlack ?? null,
          cyan: null,
          magenta: null,
          yellow: null,
        },
        supplyNote:
          inkBlack !== undefined && inkBlack !== null
            ? 'Live USB PJL supply reading'
            : 'Driver hides ink % · Check physical machine panel',
        traySheets: loadedSheets,
        trayCapacity: loadedSheets ? Math.max(500, loadedSheets) : null,
        paperState: paperState || (loadedSheets !== null ? `${loadedSheets} sheets loaded` : 'Ready (tray count not exposed by USB driver)'),
        totalSheetsPrinted: 0,
        imageUrl: isColor
          ? '/src/assets/images/printer_ecotank_color_1794773700020.jpg'
          : '/src/assets/images/printer_enterprise_laser_1794773699477.jpg',
      };
    }

    store.printers.push(printer);
    appendLog({
      actorName: 'Admin Print Desk',
      action: printer.status === 'offline' ? 'PRINTER_OFFLINE' : 'PRINTER_CONNECTED',
      printerName: printer.name,
      printMode: mode,
      details: `${printer.name} (${dType}): ${printer.connectionMessage}`,
    });
    persistStore();
    res.status(201).json(printer);
  });

  // Sync currently paired USB devices on browser startup (Admin only)
  app.post('/api/printers/usb-sync', requireAdmin, (req, res) => {
    const { pairedDevices } = req.body as {
      pairedDevices: Array<{ vendorId: number; productId: number; name?: string }>;
    };
    if (!Array.isArray(pairedDevices)) return res.json({ updated: 0 });
    let updated = 0;
    for (const printer of store.printers) {
      if (!printer.usbInfo?.vendorId || !printer.usbInfo?.productId) continue;
      const isPlugged = pairedDevices.some(
        (d) => d.vendorId === printer.usbInfo?.vendorId && d.productId === printer.usbInfo?.productId
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
    if (updated > 0) persistStore();
    res.json({ updated });
  });

  // Sync live USB hotplug event (Admin only)
  app.post('/api/printers/usb-event', requireAdmin, (req, res) => {
    const { event, vendorId, productId, productName, manufacturer } = req.body as {
      event: 'connect' | 'disconnect';
      vendorId: number;
      productId: number;
      productName?: string;
      manufacturer?: string;
    };

    const existing = store.printers.find(
      (p) => p.usbInfo?.vendorId === vendorId && p.usbInfo?.productId === productId
    );

    if (!existing) {
      return res.json({ matched: false });
    }

    if (event === 'disconnect') {
      existing.status = 'offline';
      existing.hardwareState = 'USB Cable Unplugged';
      existing.connectionMessage = 'USB port disconnected from computer.';
      existing.lastCheckedAt = new Date().toISOString();
      appendLog({
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
      appendLog({
        actorName: 'USB Port Monitor',
        action: 'PRINTER_CONNECTED',
        printerName: existing.name,
        printMode: 'manual',
        details: `Detected USB cable plugged in (${manufacturer || ''} ${productName || ''}).`,
      });
    }

    persistStore();
    res.json({ matched: true, printer: existing });
  });

  // Sync machines reported by Local Print Bridge (Admin only)
  app.post('/api/printers/sync-bridge', requireAdmin, (req, res) => {
    const { machines } = req.body as {
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
    if (!Array.isArray(machines)) return res.status(400).json({ error: 'Invalid bridge payload.' });

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
          supplyNote: m.inkBlack !== null ? 'Live OS Bridge reading' : `Machine status: ${m.statusText}`,
          traySheets: null,
          trayCapacity: null,
          paperState: m.paperState,
          totalSheetsPrinted: 0,
          imageUrl: '/src/assets/images/printer_enterprise_laser_1794773699477.jpg',
        };
        store.printers.push(existing);
        appendLog({
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
          appendLog({
            actorName: 'Local Print Bridge',
            action: m.online ? 'PRINTER_CONNECTED' : 'PRINTER_OFFLINE',
            printerName: existing.name,
            printMode: 'manual',
            details: `${existing.name} status changed to ${m.statusText}.`,
          });
        }
      }
    }

    persistStore();
    res.json({ printers: store.printers });
  });

  // Verify digital or manual connection (Admin only)
  app.post('/api/printers/:id/verify', requireAdmin, async (req, res) => {
    const printer = store.printers.find((p) => p.id === req.params.id);
    if (!printer) return res.status(404).json({ error: 'Machine not found.' });

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
      appendLog({
        actorName: 'Admin Print Desk',
        action: probe.connected ? 'PRINTER_CONNECTED' : 'PRINTER_OFFLINE',
        printerName: printer.name,
        printMode: 'digital',
        details: probe.message,
      });
    } else {
      printer.lastCheckedAt = new Date().toISOString();
    }

    persistStore();
    res.json(printer);
  });

  // Update physical tray count or switch mode (Admin only)
  app.patch('/api/printers/:id', requireAdmin, async (req, res) => {
    const printer = store.printers.find((p) => p.id === req.params.id);
    if (!printer) return res.status(404).json({ error: 'Machine not found.' });

    const { connectionMode, endpoint, setTraySheets, status } = req.body;
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
      appendLog({
        actorName: 'Admin Print Desk',
        action: 'PAPER_UPDATED',
        printerName: printer.name,
        details: `Updated ${printer.name} loaded paper tray to ${sheets} sheets.`,
      });
    }

    persistStore();
    res.json(printer);
  });

  app.delete('/api/printers/:id', requireAdmin, (req, res) => {
    const idx = store.printers.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Machine not found.' });
    const [removed] = store.printers.splice(idx, 1);
    appendLog({
      actorName: 'Admin Print Desk',
      action: 'PRINTER_REMOVED',
      printerName: removed.name,
      details: `Removed ${removed.name}.`,
    });
    persistStore();
    res.json({ deleted: true });
  });

  // Execute real print (Admin only)
  app.post('/api/submissions/:id/print', requireAdmin, async (req, res) => {
    const job = store.submissions.find((s) => s.id === req.params.id);
    if (!job) return res.status(404).json({ error: 'Document not found.' });

    const { printerId, copies, bridgeAlreadySent } = req.body as {
      printerId?: string;
      copies?: number;
      bridgeAlreadySent?: boolean;
    };

    const printCopies = Math.max(1, Number(copies || job.requestedCopies));
    const sheetsPerCopy = calcSheetsPerCopy(job.pageCount, job.duplex);
    const sheetsNeeded = printCopies * sheetsPerCopy;

    if (printerId === 'browser-default') {
      job.requestedCopies = printCopies;
      job.printedCopies += printCopies;
      job.sheetsConsumed += sheetsNeeded;
      job.assignedPrinterId = 'browser-default';
      job.printMode = 'manual';
      job.status = 'printed';
      job.completedAt = new Date().toISOString();

      appendLog({
        actorName: 'Admin Print Desk',
        action: 'PRINT_COMPLETED',
        examTitle: job.title,
        senderName: job.senderName,
        printerName: 'This Device (Browser Print)',
        printMode: 'manual',
        copiesProduced: printCopies,
        sheetsUsed: sheetsNeeded,
        details: `Printed ${printCopies} copies (${sheetsNeeded} ${job.paperSize} sheets) via This Device.`,
      });
      persistStore();
      return res.json({ job, printer: null });
    }

    const printer = store.printers.find((p) => p.id === printerId);
    if (!printer) {
      return res.status(400).json({ error: 'Select a valid printer or use This Device.' });
    }
    if (printer.status === 'offline') {
      return res.status(400).json({ error: `${printer.name} is offline (${printer.connectionMessage}).` });
    }

    if (printer.traySheets !== null && printer.traySheets < sheetsNeeded) {
      return res.status(400).json({
        error: `${printer.name} has ${printer.traySheets} sheets loaded, but ${sheetsNeeded} sheets are needed.`,
      });
    }

    if (printer.connectionMode === 'digital' && !bridgeAlreadySent) {
      if (job.fileType === 'word') {
        return res.status(400).json({
          error: 'Network IPP/TCP printers only accept PDF or images directly. Print Word documents using Browser Print.',
        });
      }

      let fileBuffer: Buffer;
      const localFile = job.fileUrl ? path.join(UPLOAD_DIR, path.basename(job.fileUrl)) : '';
      if (localFile && fs.existsSync(localFile)) {
        fileBuffer = await fsp.readFile(localFile);
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
        appendLog({
          actorName: 'Admin Print Desk',
          action: 'PRINT_FAILED',
          examTitle: job.title,
          senderName: job.senderName,
          printerName: printer.name,
          printMode: 'digital',
          details: tx.message,
        });
        persistStore();
        return res.status(502).json({ error: tx.message });
      }
    }

    // Deduct tray sheets only if tray count is tracked
    if (printer.traySheets !== null) {
      printer.traySheets = Math.max(0, printer.traySheets - sheetsNeeded);
      printer.paperState = `${printer.traySheets} sheets in tray`;
    }
    printer.totalSheetsPrinted += sheetsNeeded;

    // Deduct ink only if machine actually reported an ink percentage
    if (printer.ink.black !== null) {
      printer.ink.black = Math.max(0, Number((printer.ink.black - sheetsNeeded * 0.02).toFixed(2)));
    }

    job.requestedCopies = printCopies;
    job.printedCopies += printCopies;
    job.sheetsConsumed += sheetsNeeded;
    job.assignedPrinterId = printer.id;
    job.printMode = printer.connectionMode;
    job.status = 'printed';
    job.completedAt = new Date().toISOString();

    appendLog({
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
    persistStore();
    res.json({ job, printer });
  });

  app.get('/api/logs/export', requireAdmin, (_req, res) => {
    const header = ['Timestamp', 'Actor', 'Action', 'Document', 'Sender', 'Machine', 'Mode', 'Copies', 'Sheets', 'Details'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = store.logs.map((l) =>
      [l.timestamp, l.actorName, l.action, l.examTitle, l.senderName, l.printerName, l.printMode, l.copiesProduced, l.sheetsUsed, l.details]
        .map(esc)
        .join(',')
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="print-history.csv"');
    res.send([header.join(','), ...rows].join('\n'));
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Damaria Docs server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
