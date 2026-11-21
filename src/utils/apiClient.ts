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
  browserClearLogs,
  browserDeleteLog,
  browserDeletePrinter,
  browserDeleteSubmission,
  browserDownloadBridgeScript,
  browserDownloadOriginal,
  browserExportLogsCsv,
  browserHandleUsbEvent,
  browserHasLocalData,
  browserLoginAdmin,
  browserLogoutAdmin,
  browserRecordPrint,
  browserSubmitDocument,
  browserSyncBridgeMachines,
  browserSyncUsbDevices,
  browserUpdatePrinter,
  browserVerifyPrinter,
  isBrowserAdminAuthenticated,
  triggerBrowserDownload,
  type AddPrinterBody,
} from './browserStore';

export type BackendMode = 'server' | 'browser';

let currentMode: BackendMode = 'server';
let serverChecked = false;
let adminToken: string | null = null;
let adminExpiresAt = 0;

export function getBackendMode(): BackendMode {
  return currentMode;
}

export function isAdminLoggedIn(): boolean {
  if (currentMode === 'browser') {
    return isBrowserAdminAuthenticated();
  }
  return Boolean(adminToken && Date.now() < adminExpiresAt);
}

export function getAdminAuthHeaders(): Record<string, string> {
  if (adminToken && Date.now() < adminExpiresAt) {
    return { Authorization: `Bearer ${adminToken}` };
  }
  return {};
}

export function getAdminSessionToken(): string | null {
  if (adminToken && Date.now() < adminExpiresAt) {
    return adminToken;
  }
  return null;
}

function clearMemorySession() {
  adminToken = null;
  adminExpiresAt = 0;
  browserLogoutAdmin();
}

function isFallbackNetworkError(err: unknown): boolean {
  const msg = (err as Error)?.message || '';
  return (
    msg === 'NON_JSON_RESPONSE' ||
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('AbortError')
  );
}

async function fetchJsonWithTimeout(url: string, init?: RequestInit, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const mergedHeaders = new Headers(init?.headers || {});
    const authHeaders = getAdminAuthHeaders();
    if (authHeaders.Authorization && !mergedHeaders.has('Authorization')) {
      mergedHeaders.set('Authorization', authHeaders.Authorization);
    }

    const res = await fetch(url, { ...init, headers: mergedHeaders, signal: controller.signal });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('NON_JSON_RESPONSE');
    }
    const json = await res.json();
    if (res.status === 401) {
      clearMemorySession();
      throw new Error((json as { error?: string }).error || 'Admin authentication required.');
    }
    if (!res.ok) {
      throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function loginAdmin(password: string): Promise<void> {
  if (currentMode === 'browser') {
    await browserLoginAdmin(password);
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(apiUrl('/api/admin/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('NON_JSON_RESPONSE');
    }
    const json = (await res.json()) as { token?: string; expiresAt?: number; error?: string };
    if (!res.ok) {
      throw new Error(json.error || 'Incorrect admin password.');
    }
    if (!json.token || !json.expiresAt) {
      throw new Error('Invalid authentication response.');
    }
    adminToken = json.token;
    adminExpiresAt = json.expiresAt;
  } catch (err) {
    if (isFallbackNetworkError(err)) {
      currentMode = 'browser';
      serverChecked = true;
      await browserLoginAdmin(password);
      return;
    }
    throw err;
  }
}

export async function logoutAdmin(): Promise<void> {
  clearMemorySession();
  if (currentMode === 'server') {
    await fetch(apiUrl('/api/admin/logout'), { method: 'POST' }).catch(() => undefined);
  }
}

export async function loadBootstrap(): Promise<{
  payload: BootstrapPayload;
  mode: BackendMode;
}> {
  const hasLocal = await browserHasLocalData();

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
    if (isFallbackNetworkError(err)) {
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
    if (isFallbackNetworkError(err)) {
      currentMode = 'browser';
      return browserDeleteSubmission(id);
    }
    throw err;
  }
}

export async function recordPrint(
  id: string,
  payload: { printerId: string; copies?: number; bridgeAlreadySent?: boolean }
): Promise<{ job: ExamSubmission; printer: PrinterDevice | null }> {
  if (currentMode === 'browser') {
    return browserRecordPrint(id, payload);
  }
  try {
    return (await fetchJsonWithTimeout(apiUrl(`/api/submissions/${id}/print`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })) as { job: ExamSubmission; printer: PrinterDevice | null };
  } catch (err) {
    if (isFallbackNetworkError(err)) {
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
    if (isFallbackNetworkError(err)) {
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
    if (isFallbackNetworkError(err)) {
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
    if (isFallbackNetworkError(err)) {
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
    if (isFallbackNetworkError(err)) {
      currentMode = 'browser';
      return browserDeletePrinter(id);
    }
    throw err;
  }
}

export async function syncUsbDevices(
  pairedDevices: Array<{ vendorId: number; productId: number; name?: string }>
): Promise<void> {
  if (!isAdminLoggedIn()) return;
  if (currentMode === 'browser') {
    return browserSyncUsbDevices(pairedDevices);
  }
  try {
    await fetchJsonWithTimeout(apiUrl('/api/printers/usb-sync'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairedDevices }),
    });
  } catch (err) {
    if (isFallbackNetworkError(err)) {
      await browserSyncUsbDevices(pairedDevices);
    }
  }
}

export async function sendUsbEvent(payload: {
  event: 'connect' | 'disconnect';
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturer?: string;
}): Promise<void> {
  if (!isAdminLoggedIn()) return;
  if (currentMode === 'browser') {
    return browserHandleUsbEvent(payload);
  }
  try {
    await fetchJsonWithTimeout(apiUrl('/api/printers/usb-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (isFallbackNetworkError(err)) {
      await browserHandleUsbEvent(payload);
    }
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
  if (!isAdminLoggedIn()) return;
  if (currentMode === 'browser') {
    return browserSyncBridgeMachines(machines);
  }
  try {
    await fetchJsonWithTimeout(apiUrl('/api/printers/sync-bridge'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machines }),
    });
  } catch (err) {
    if (isFallbackNetworkError(err)) {
      await browserSyncBridgeMachines(machines);
    }
  }
}

export async function downloadOriginalSubmission(submission: ExamSubmission): Promise<void> {
  if (currentMode === 'browser' || submission.fileUrl?.startsWith('blob:')) {
    return browserDownloadOriginal(submission);
  }
  const res = await fetch(apiUrl(`/api/submissions/${submission.id}/download`), {
    headers: getAdminAuthHeaders(),
  });
  if (res.status === 401) {
    clearMemorySession();
    throw new Error('Admin authentication required.');
  }
  if (!res.ok) {
    throw new Error('Could not download original file.');
  }
  const blob = await res.blob();
  triggerBrowserDownload(blob, submission.fileName || `${submission.title}.bin`);
}

export async function deleteHistoryLog(id: string): Promise<void> {
  if (currentMode === 'browser') {
    return browserDeleteLog(id);
  }
  try {
    await fetchJsonWithTimeout(apiUrl(`/api/logs/${encodeURIComponent(id)}`), { method: 'DELETE' });
  } catch (err) {
    if (isFallbackNetworkError(err)) {
      currentMode = 'browser';
      return browserDeleteLog(id);
    }
    throw err;
  }
}

export async function clearHistoryLogs(ids?: string[]): Promise<{ deletedCount: number }> {
  if (currentMode === 'browser') {
    return browserClearLogs(ids);
  }
  try {
    return (await fetchJsonWithTimeout(apiUrl('/api/logs'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
    })) as { deletedCount: number };
  } catch (err) {
    if (isFallbackNetworkError(err)) {
      currentMode = 'browser';
      return browserClearLogs(ids);
    }
    throw err;
  }
}

export async function downloadLogsCsv(): Promise<void> {
  if (currentMode === 'browser') {
    return browserExportLogsCsv();
  }
  const res = await fetch(apiUrl('/api/logs/export'), {
    headers: getAdminAuthHeaders(),
  });
  if (res.status === 401) {
    clearMemorySession();
    throw new Error('Admin authentication required.');
  }
  if (!res.ok) {
    throw new Error('Could not export logs.');
  }
  const blob = await res.blob();
  triggerBrowserDownload(blob, 'print-history.csv');
}

export async function downloadBridgeScript(): Promise<void> {
  if (currentMode === 'browser') {
    browserDownloadBridgeScript();
    return;
  }
  const res = await fetch(apiUrl('/api/bridge/script'), {
    headers: getAdminAuthHeaders(),
  });
  if (res.status === 401) {
    clearMemorySession();
    throw new Error('Admin authentication required.');
  }
  if (!res.ok) {
    throw new Error('Could not download bridge script.');
  }
  const blob = await res.blob();
  triggerBrowserDownload(blob, 'damaria-docs-bridge.mjs');
}
