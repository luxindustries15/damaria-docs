import type {
  BootstrapPayload,
  DeviceType,
  ExamSubmission,
  HistoryLogEntry,
  PaperSize,
  PrinterConnectionMode,
  PrinterDevice,
  UsbHardwareInfo,
} from '../types';
import { BRIDGE_SCRIPT_SOURCE } from './bridgeScript';
import { calcSheetsPerCopy } from './format';

const SCHEMA_VERSION = 4;
const DB_NAME = 'damaria_docs_db';
const DB_VERSION = 1;
const STORE_STATE = 'state';
const STORE_FILES = 'files';
const STATE_KEY = 'bootstrap';
const LS_FALLBACK_KEY = 'damaria_docs_store_v4';

interface StoredFileRecord {
  key: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
}

const objectUrlCache = new Map<string, string>();
const memoryFiles = new Map<string, StoredFileRecord>();

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createEmptyStore(): BootstrapPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    schoolName: 'Damaria Docs',
    printers: [],
    submissions: [],
    logs: [],
  };
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

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_STATE)) {
          db.createObjectStore(STORE_STATE);
        }
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGetState(): Promise<BootstrapPayload> {
  const db = await openDb();
  if (db) {
    try {
      const result = await new Promise<BootstrapPayload | undefined>((resolve) => {
        const tx = db.transaction(STORE_STATE, 'readonly');
        const req = tx.objectStore(STORE_STATE).get(STATE_KEY);
        req.onsuccess = () => resolve(req.result as BootstrapPayload | undefined);
        req.onerror = () => resolve(undefined);
      });
      if (result && result.schemaVersion === SCHEMA_VERSION) {
        return result;
      }
    } catch {
      // fall through
    }
  }

  try {
    const raw = localStorage.getItem(LS_FALLBACK_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as BootstrapPayload;
      if (parsed.schemaVersion === SCHEMA_VERSION) return parsed;
    }
  } catch {
    // ignore
  }

  return createEmptyStore();
}

async function idbSaveState(store: BootstrapPayload): Promise<void> {
  try {
    localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(store));
  } catch {
    // ignore storage quota errors
  }

  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_STATE, 'readwrite');
      tx.objectStore(STORE_STATE).put(store, STATE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbSaveFile(record: StoredFileRecord): Promise<void> {
  memoryFiles.set(record.key, record);
  const url = URL.createObjectURL(record.blob);
  const prev = objectUrlCache.get(record.key);
  if (prev && prev !== url) URL.revokeObjectURL(prev);
  objectUrlCache.set(record.key, url);

  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readwrite');
      tx.objectStore(STORE_FILES).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbGetFile(key: string): Promise<StoredFileRecord | null> {
  const mem = memoryFiles.get(key);
  if (mem) return mem;

  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readonly');
      const req = tx.objectStore(STORE_FILES).get(key);
      req.onsuccess = () => {
        const rec = (req.result as StoredFileRecord | undefined) || null;
        if (rec) memoryFiles.set(key, rec);
        resolve(rec);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbDeleteFile(key: string): Promise<void> {
  memoryFiles.delete(key);
  const cached = objectUrlCache.get(key);
  if (cached) {
    URL.revokeObjectURL(cached);
    objectUrlCache.delete(key);
  }

  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readwrite');
      tx.objectStore(STORE_FILES).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function resolveFileUrl(fileKey: string | undefined): Promise<string | null> {
  if (!fileKey) return null;
  const cached = objectUrlCache.get(fileKey);
  if (cached) return cached;
  const rec = await idbGetFile(fileKey);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  objectUrlCache.set(fileKey, url);
  return url;
}

function extractFileKey(fileUrl: string | null): string | null {
  if (!fileUrl) return null;
  if (fileUrl.startsWith('idb://')) return fileUrl.slice('idb://'.length);
  for (const [key, url] of objectUrlCache.entries()) {
    if (url === fileUrl) return key;
  }
  return null;
}

async function convertDocxInBrowser(arrayBuffer: ArrayBuffer): Promise<string | null> {
  try {
    const mod = (await import('mammoth/mammoth.browser.min.js')) as unknown as {
      convertToHtml?: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
      default?: {
        convertToHtml?: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
      };
    };
    const globalMammoth = (
      window as unknown as {
        mammoth?: {
          convertToHtml?: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
        };
      }
    ).mammoth;

    const convertToHtml =
      mod?.convertToHtml || mod?.default?.convertToHtml || globalMammoth?.convertToHtml;
    if (!convertToHtml) return null;
    const res = await convertToHtml({ arrayBuffer });
    return res.value || null;
  } catch {
    return null;
  }
}

export async function browserHasLocalData(): Promise<boolean> {
  const store = await idbGetState();
  return store.submissions.length > 0 || store.printers.length > 0 || store.logs.length > 0;
}

export async function browserBootstrap(): Promise<BootstrapPayload> {
  const store = await idbGetState();
  const hydratedSubmissions = await Promise.all(
    store.submissions.map(async (sub) => {
      if (sub.fileUrl && sub.fileUrl.startsWith('idb://')) {
        const key = sub.fileUrl.slice('idb://'.length);
        const blobUrl = await resolveFileUrl(key);
        return { ...sub, fileUrl: blobUrl };
      }
      return sub;
    })
  );

  return {
    ...store,
    submissions: hydratedSubmissions,
    publicDomain: 'https://damariadocs.com',
    liveAppUrl: typeof window !== 'undefined' ? window.location.origin : 'https://damariadocs.com',
  };
}

export async function browserSubmitDocument(formData: FormData): Promise<ExamSubmission> {
  const senderName = String(formData.get('senderName') || '').trim();
  const file = formData.get('documentFile') as File | null;
  if (!senderName) throw new Error('Please enter your name.');
  if (!file || typeof file === 'string') throw new Error('Please select a PDF or Word file.');

  const fileName = file.name || 'document';
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileKey = `${Date.now()}_${safeName}`;
  await idbSaveFile({
    key: fileKey,
    fileName,
    mimeType: file.type || 'application/octet-stream',
    blob: file,
  });

  const store = await idbGetState();
  const rawTitle = String(formData.get('title') || '').trim();
  const title = rawTitle || fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  const requestedCopies = Math.max(
    1,
    Math.min(5000, Number(formData.get('requestedCopies')) || 1)
  );
  const duplex = formData.get('duplex') === 'true';
  const colorMode = formData.get('colorMode') === 'color' ? 'color' : 'bw';
  const staple = formData.get('staple') === 'true';
  const rawPaper = String(formData.get('paperSize') || 'A4');
  const paperSize = (['A4', 'Letter', 'Legal'].includes(rawPaper) ? rawPaper : 'A4') as PaperSize;

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
  let estimatedPages = Number(formData.get('pageCount')) || 0;

  if (lowerName.endsWith('.docx')) {
    const ab = await file.arrayBuffer();
    const html = await convertDocxInBrowser(ab);
    renderedHtml = html || `<p>Word document <strong>${escapeHtml(fileName)}</strong> uploaded.</p>`;
    const textOnly = renderedHtml.replace(/<[^>]+>/g, ' ').trim();
    if (!estimatedPages) {
      estimatedPages = Math.max(1, Math.ceil(textOnly.split(/\s+/).length / 350));
    }
  } else if (lowerName.endsWith('.doc')) {
    renderedHtml = `<p>Word (.doc) file <strong>${escapeHtml(fileName)}</strong> uploaded. Use Download Original to open in Word, or save as .docx/.pdf for direct browser printing.</p>`;
  } else if (lowerName.endsWith('.txt')) {
    const txt = await file.text();
    renderedHtml = `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(txt)}</pre>`;
    if (!estimatedPages) {
      estimatedPages = Math.max(1, Math.ceil(txt.split(/\s+/).length / 350));
    }
  }

  const pageCount = Math.max(1, Math.min(300, estimatedPages || 1));

  const submissionToSave: ExamSubmission = {
    id: uid('sub'),
    senderName,
    title,
    fileType,
    fileName,
    fileMime: file.type || 'application/octet-stream',
    fileSizeBytes: file.size,
    fileUrl: `idb://${fileKey}`,
    renderedHtml,
    pageCount,
    requestedCopies,
    printedCopies: 0,
    sheetsConsumed: 0,
    paperSize,
    duplex,
    colorMode,
    staple,
    notes: String(formData.get('notes') || '').trim(),
    status: 'waiting',
    assignedPrinterId: store.printers[0]?.id ?? null,
    printMode: null,
    submittedAt: new Date().toISOString(),
    completedAt: null,
  };

  store.submissions.unshift(submissionToSave);
  appendLog(store, {
    actorName: senderName,
    action: 'DOCUMENT_SENT',
    examTitle: title,
    senderName,
    details: `Sent ${fileName} (${requestedCopies} copies, ${pageCount}p, ${paperSize}).`,
  });
  await idbSaveState(store);

  const blobUrl = await resolveFileUrl(fileKey);
  return { ...submissionToSave, fileUrl: blobUrl };
}

export async function browserDeleteSubmission(id: string): Promise<void> {
  const store = await idbGetState();
  const idx = store.submissions.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error('Document not found.');
  const [removed] = store.submissions.splice(idx, 1);
  const key = extractFileKey(removed.fileUrl);
  if (key) await idbDeleteFile(key);

  appendLog(store, {
    actorName: 'Admin Print Desk',
    action: 'DOCUMENT_DELETED',
    examTitle: removed.title,
    senderName: removed.senderName,
    details: `Deleted "${removed.title}" (${removed.fileName || 'file'}).`,
  });
  await idbSaveState(store);
}

export async function browserRecordPrint(
  id: string,
  payload: { printerId: string; copies?: number; bridgeAlreadySent?: boolean }
): Promise<{ job: ExamSubmission; printer: PrinterDevice }> {
  const store = await idbGetState();
  const job = store.submissions.find((s) => s.id === id);
  if (!job) throw new Error('Document not found.');
  const printer = store.printers.find((p) => p.id === payload.printerId);
  if (!printer) throw new Error('Connect a printer or photocopier first.');
  if (printer.status === 'offline') {
    throw new Error(`${printer.name} is offline (${printer.connectionMessage}).`);
  }

  const printCopies = Math.max(1, Number(payload.copies || job.requestedCopies));
  const sheetsNeeded = printCopies * calcSheetsPerCopy(job.pageCount, job.duplex);

  if (printer.traySheets !== null && printer.traySheets < sheetsNeeded) {
    throw new Error(
      `${printer.name} has ${printer.traySheets} sheets loaded, but ${sheetsNeeded} sheets are needed.`
    );
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
  await idbSaveState(store);
  return { job, printer };
}

export interface AddPrinterBody {
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
}

export async function browserAddPrinter(body: AddPrinterBody): Promise<PrinterDevice> {
  const store = await idbGetState();
  const mode: PrinterConnectionMode = body.connectionMode === 'manual' ? 'manual' : 'digital';
  const dType: DeviceType = body.deviceType === 'photocopier' ? 'photocopier' : 'printer';
  const cleanName =
    String(body.name || '').trim() || (dType === 'photocopier' ? 'Photocopier' : 'Printer');
  const cleanEndpoint = String(body.endpoint || '').trim();
  const loadedSheets =
    body.traySheets !== undefined && body.traySheets !== null && Number(body.traySheets) >= 0
      ? Number(body.traySheets)
      : null;

  if (mode === 'manual' && body.usbInfo?.vendorId && body.usbInfo?.productId) {
    const existing = store.printers.find(
      (p) =>
        p.usbInfo?.vendorId === body.usbInfo?.vendorId &&
        p.usbInfo?.productId === body.usbInfo?.productId
    );
    if (existing) {
      existing.name = cleanName;
      existing.deviceType = dType;
      existing.status = 'connected-manual';
      existing.hardwareState = body.hardwareState || 'USB Port Connected';
      existing.connectionMessage = `USB Port Connected (${body.usbInfo?.portLabel || ''})`;
      existing.usbInfo = body.usbInfo;
      existing.lastCheckedAt = new Date().toISOString();
      if (body.inkBlack !== undefined && body.inkBlack !== null) {
        existing.ink.black = body.inkBlack;
      }
      if (body.paperState) existing.paperState = body.paperState;
      appendLog(store, {
        actorName: 'USB Port Monitor',
        action: 'PRINTER_CONNECTED',
        printerName: existing.name,
        printMode: 'manual',
        details: `Detected USB device ${existing.name} (${body.usbInfo?.portLabel || ''}).`,
      });
      await idbSaveState(store);
      return existing;
    }
  }

  const printer: PrinterDevice = {
    id: uid('prt'),
    name: cleanName,
    deviceType: dType,
    location: String(body.location || 'Print Room').trim(),
    connectionMode: mode,
    endpoint: cleanEndpoint || body.usbInfo?.portLabel || 'Local USB / OS Print Spooler',
    status: mode === 'digital' ? 'offline' : 'connected-manual',
    hardwareState:
      mode === 'digital'
        ? 'Requires Server / Local Bridge for Direct TCP/IPP'
        : body.hardwareState || (body.usbInfo ? 'USB Port Connected' : 'Local OS Spooler Ready'),
    connectionMessage:
      mode === 'digital'
        ? 'Direct network IPP/TCP probing requires the Damaria Docs server function or Local Print Bridge.'
        : body.usbInfo?.vendorId
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
    imageUrl: '',
  };

  store.printers.push(printer);
  appendLog(store, {
    actorName: 'Admin Print Desk',
    action: printer.status === 'offline' ? 'PRINTER_OFFLINE' : 'PRINTER_CONNECTED',
    printerName: printer.name,
    printMode: mode,
    details: `${printer.name} (${dType}): ${printer.connectionMessage}`,
  });
  await idbSaveState(store);
  return printer;
}

export async function browserVerifyPrinter(id: string): Promise<PrinterDevice> {
  const store = await idbGetState();
  const printer = store.printers.find((p) => p.id === id);
  if (!printer) throw new Error('Machine not found.');
  printer.lastCheckedAt = new Date().toISOString();
  await idbSaveState(store);
  return printer;
}

export async function browserUpdatePrinter(
  id: string,
  patch: {
    connectionMode?: PrinterConnectionMode;
    endpoint?: string;
    setTraySheets?: number | null;
    status?: PrinterDevice['status'];
  }
): Promise<PrinterDevice> {
  const store = await idbGetState();
  const printer = store.printers.find((p) => p.id === id);
  if (!printer) throw new Error('Machine not found.');

  if (patch.endpoint !== undefined) printer.endpoint = String(patch.endpoint).trim();
  if (patch.connectionMode === 'digital' || patch.connectionMode === 'manual') {
    printer.connectionMode = patch.connectionMode;
    if (patch.connectionMode === 'manual') {
      printer.status = 'connected-manual';
      printer.hardwareState = 'Local OS Spooler Ready';
      printer.connectionMessage = 'Switched to Manual / USB mode';
    } else {
      printer.status = 'offline';
      printer.hardwareState = 'Requires Server / Local Bridge for Direct TCP/IPP';
      printer.connectionMessage =
        'Switch to Manual mode or start the Local Print Bridge for direct browser printing.';
    }
    printer.lastCheckedAt = new Date().toISOString();
  }
  if (patch.status === 'offline' || patch.status === 'connected-manual') {
    printer.status = patch.status;
    printer.hardwareState = patch.status === 'offline' ? 'Offline' : 'Manual Ready';
  }
  if (patch.setTraySheets !== undefined && patch.setTraySheets !== null) {
    const sheets = Math.max(0, Number(patch.setTraySheets));
    printer.traySheets = sheets;
    printer.trayCapacity = Math.max(printer.trayCapacity || 500, sheets);
    printer.paperState = `${sheets} sheets in tray`;
    appendLog(store, {
      actorName: 'Admin Print Desk',
      action: 'PAPER_UPDATED',
      printerName: printer.name,
      details: `Updated ${printer.name} loaded paper tray to ${sheets} sheets.`,
    });
  }

  await idbSaveState(store);
  return printer;
}

export async function browserDeletePrinter(id: string): Promise<void> {
  const store = await idbGetState();
  const idx = store.printers.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error('Machine not found.');
  const [removed] = store.printers.splice(idx, 1);
  appendLog(store, {
    actorName: 'Admin Print Desk',
    action: 'PRINTER_REMOVED',
    printerName: removed.name,
    details: `Removed ${removed.name}.`,
  });
  await idbSaveState(store);
}

export async function browserSyncUsbDevices(
  pairedDevices: Array<{ vendorId: number; productId: number; name?: string }>
): Promise<void> {
  const store = await idbGetState();
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
  if (updated > 0) await idbSaveState(store);
}

export async function browserHandleUsbEvent(payload: {
  event: 'connect' | 'disconnect';
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturer?: string;
}): Promise<void> {
  const store = await idbGetState();
  const existing = store.printers.find(
    (p) => p.usbInfo?.vendorId === payload.vendorId && p.usbInfo?.productId === payload.productId
  );
  if (!existing) return;

  if (payload.event === 'disconnect') {
    existing.status = 'offline';
    existing.hardwareState = 'USB Cable Unplugged';
    existing.connectionMessage = 'USB port disconnected from computer.';
    existing.lastCheckedAt = new Date().toISOString();
    appendLog(store, {
      actorName: 'USB Port Monitor',
      action: 'PRINTER_OFFLINE',
      printerName: existing.name,
      printMode: 'manual',
      details: `Detected USB cable unplugged (${payload.manufacturer || ''} ${payload.productName || ''}).`,
    });
  } else {
    existing.status = 'connected-manual';
    existing.hardwareState = 'USB Port Connected';
    existing.connectionMessage = `USB port reconnected (VID:${payload.vendorId.toString(16)} PID:${payload.productId.toString(16)})`;
    existing.lastCheckedAt = new Date().toISOString();
    appendLog(store, {
      actorName: 'USB Port Monitor',
      action: 'PRINTER_CONNECTED',
      printerName: existing.name,
      printMode: 'manual',
      details: `Detected USB cable plugged in (${payload.manufacturer || ''} ${payload.productName || ''}).`,
    });
  }
  await idbSaveState(store);
}

export async function browserSyncBridgeMachines(
  machines: Array<{
    name: string;
    portName: string;
    driverName: string;
    isUsb: boolean;
    online: boolean;
    statusText: string;
    inkBlack: number | null;
    paperState: string;
  }>
): Promise<void> {
  const store = await idbGetState();
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
        imageUrl: '',
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
  await idbSaveState(store);
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function browserDownloadOriginal(submission: ExamSubmission): Promise<void> {
  if (!submission.fileUrl) return;
  const res = await fetch(submission.fileUrl);
  const blob = await res.blob();
  triggerBrowserDownload(blob, submission.fileName || `${submission.title}.bin`);
}

export async function browserExportLogsCsv(): Promise<void> {
  const store = await idbGetState();
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
  const csv = [header.join(','), ...rows].join('\n');
  triggerBrowserDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'print-history.csv');
}

export function browserDownloadBridgeScript(): void {
  triggerBrowserDownload(
    new Blob([BRIDGE_SCRIPT_SOURCE], { type: 'application/javascript;charset=utf-8' }),
    'damaria-docs-bridge.mjs'
  );
}
