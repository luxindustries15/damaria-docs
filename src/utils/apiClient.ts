import type {
  BootstrapPayload,
  ExamSubmission,
  PrinterConnectionMode,
  PrinterDevice,
} from '../types';
import { apiUrl } from './api';
import {
  browserAddPrinter,
  browserBootstrap,
  browserDeletePrinter,
  browserDeleteSubmission,
  browserDownloadBridgeScript,
  browserDownloadOriginal,
  browserExportLogsCsv,
  browserHandleUsbEvent,
  browserHasLocalData,
  browserRecordPrint,
  browserSubmitDocument,
  browserSyncBridgeMachines,
  browserSyncUsbDevices,
  browserUpdatePrinter,
  browserVerifyPrinter,
  type AddPrinterBody,
} from './browserStore';

export type BackendMode = 'server' | 'browser';

let currentMode: BackendMode = 'server';
let serverChecked = false;

export function getBackendMode(): BackendMode {
  return currentMode;
}

async function fetchJsonWithTimeout(url: string, init?: RequestInit, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('NON_JSON_RESPONSE');
    }
    const json = await res.json();
    if (!res.ok) {
      throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadBootstrap(): Promise<{
  payload: BootstrapPayload;
  mode: BackendMode;
}> {
  const hasLocal = await browserHasLocalData();

  // If we already fell back to browser mode and the user saved local data, stay consistent
  if (serverChecked && currentMode === 'browser' && hasLocal) {
    return { payload: await browserBootstrap(), mode: 'browser' };
  }

  try {
    const json = (await fetchJsonWithTimeout(apiUrl('/api/bootstrap'))) as BootstrapPayload;
    if (typeof json?.schemaVersion === 'number' && Array.isArray(json.submissions)) {
      currentMode = 'server';
      serverChecked = true;
      return { payload: json, mode: 'server' };
    }
    throw new Error('INVALID_BOOTSTRAP_SHAPE');
  } catch {
    currentMode = 'browser';
    serverChecked = true;
    return { payload: await browserBootstrap(), mode: 'browser' };
  }
}

export async function submitDocument(formData: FormData): Promise<ExamSubmission> {
  if (currentMode === 'browser') {
    return browserSubmitDocument(formData);
  }
  try {
    const res = await fetch(apiUrl('/api/submissions'), {
      method: 'POST',
      body: formData,
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('NON_JSON_RESPONSE');
    }
    const json = await res.json();
    if (!res.ok) throw new Error((json as { error?: string }).error || 'Could not send file.');
    return json as ExamSubmission;
  } catch (err) {
    const msg = (err as Error).message;
    if (
      msg === 'NON_JSON_RESPONSE' ||
      msg.includes('Failed to fetch') ||
      msg.includes('NetworkError') ||
      msg.includes('AbortError')
    ) {
      currentMode = 'browser';
      return browserSubmitDocument(formData);
    }
    throw err;
  }
}

export async function deleteSubmission(id: string): Promise<void> {
  if (currentMode === 'browser') {
    return browserDeleteSubmission(id);
  }
  try {
    await fetchJsonWithTimeout(apiUrl(`/api/submissions/${id}`), { method: 'DELETE' });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'NON_JSON_RESPONSE' || msg.includes('Failed to fetch')) {
      currentMode = 'browser';
      return browserDeleteSubmission(id);
    }
    throw err;
  }
}

export async function recordPrint(
  id: string,
  payload: { printerId: string; copies?: number; bridgeAlreadySent?: boolean }
): Promise<{ job: ExamSubmission; printer: PrinterDevice }> {
  if (currentMode === 'browser') {
    return browserRecordPrint(id, payload);
  }
  try {
    return (await fetchJsonWithTimeout(apiUrl(`/api/submissions/${id}/print`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })) as { job: ExamSubmission; printer: PrinterDevice };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'NON_JSON_RESPONSE' || msg.includes('Failed to fetch')) {
      currentMode = 'browser';
      return browserRecordPrint(id, payload);
    }
    throw err;
  }
}

export async function addOrUpdatePrinter(body: AddPrinterBody): Promise<PrinterDevice> {
  if (currentMode === 'browser') {
    return browserAddPrinter(body);
  }
  try {
    return (await fetchJsonWithTimeout(apiUrl('/api/printers'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })) as PrinterDevice;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'NON_JSON_RESPONSE' || msg.includes('Failed to fetch')) {
      currentMode = 'browser';
      return browserAddPrinter(body);
    }
    throw err;
  }
}

export async function verifyPrinter(id: string): Promise<PrinterDevice> {
  if (currentMode === 'browser') {
    return browserVerifyPrinter(id);
  }
  try {
    return (await fetchJsonWithTimeout(apiUrl(`/api/printers/${id}/verify`), {
      method: 'POST',
    })) as PrinterDevice;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'NON_JSON_RESPONSE' || msg.includes('Failed to fetch')) {
      currentMode = 'browser';
      return browserVerifyPrinter(id);
    }
    throw err;
  }
}

export async function updatePrinter(
  id: string,
  patch: {
    connectionMode?: PrinterConnectionMode;
    endpoint?: string;
    setTraySheets?: number | null;
    status?: PrinterDevice['status'];
  }
): Promise<PrinterDevice> {
  if (currentMode === 'browser') {
    return browserUpdatePrinter(id, patch);
  }
  try {
    return (await fetchJsonWithTimeout(apiUrl(`/api/printers/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })) as PrinterDevice;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'NON_JSON_RESPONSE' || msg.includes('Failed to fetch')) {
      currentMode = 'browser';
      return browserUpdatePrinter(id, patch);
    }
    throw err;
  }
}

export async function deletePrinter(id: string): Promise<void> {
  if (currentMode === 'browser') {
    return browserDeletePrinter(id);
  }
  try {
    await fetchJsonWithTimeout(apiUrl(`/api/printers/${id}`), { method: 'DELETE' });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'NON_JSON_RESPONSE' || msg.includes('Failed to fetch')) {
      currentMode = 'browser';
      return browserDeletePrinter(id);
    }
    throw err;
  }
}

export async function syncUsbDevices(
  pairedDevices: Array<{ vendorId: number; productId: number; name?: string }>
): Promise<void> {
  if (currentMode === 'browser') {
    return browserSyncUsbDevices(pairedDevices);
  }
  try {
    await fetchJsonWithTimeout(apiUrl('/api/printers/usb-sync'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairedDevices }),
    });
  } catch {
    await browserSyncUsbDevices(pairedDevices);
  }
}

export async function sendUsbEvent(payload: {
  event: 'connect' | 'disconnect';
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturer?: string;
}): Promise<void> {
  if (currentMode === 'browser') {
    return browserHandleUsbEvent(payload);
  }
  try {
    await fetchJsonWithTimeout(apiUrl('/api/printers/usb-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    await browserHandleUsbEvent(payload);
  }
}

export async function syncBridgeMachines(
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
  if (currentMode === 'browser') {
    return browserSyncBridgeMachines(machines);
  }
  try {
    await fetchJsonWithTimeout(apiUrl('/api/printers/sync-bridge'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machines }),
    });
  } catch {
    await browserSyncBridgeMachines(machines);
  }
}

export async function downloadOriginalSubmission(submission: ExamSubmission): Promise<void> {
  if (currentMode === 'browser' || submission.fileUrl?.startsWith('blob:')) {
    return browserDownloadOriginal(submission);
  }
  const url = apiUrl(`/api/submissions/${submission.id}/download`);
  const a = document.createElement('a');
  a.href = url;
  a.download = submission.fileName || `${submission.title}.bin`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function downloadLogsCsv(): Promise<void> {
  if (currentMode === 'browser') {
    return browserExportLogsCsv();
  }
  const a = document.createElement('a');
  a.href = apiUrl('/api/logs/export');
  a.download = 'print-history.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function downloadBridgeScript(): void {
  if (currentMode === 'browser') {
    browserDownloadBridgeScript();
    return;
  }
  const a = document.createElement('a');
  a.href = apiUrl('/api/bridge/script');
  a.download = 'damaria-docs-bridge.mjs';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
