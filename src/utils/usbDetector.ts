import type { UsbHardwareInfo } from '../types';

interface UsbEndpointLike {
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
  endpointNumber: number;
}

interface UsbAlternateLike {
  interfaceClass: number;
  endpoints: UsbEndpointLike[];
}

interface UsbInterfaceLike {
  interfaceNumber: number;
  alternates: UsbAlternateLike[];
}

interface UsbConfigurationLike {
  interfaces: UsbInterfaceLike[];
}

export interface UsbDeviceLike {
  vendorId: number;
  productId: number;
  manufacturerName?: string;
  productName?: string;
  serialNumber?: string;
  configuration?: UsbConfigurationLike | null;
  opened: boolean;
  open: () => Promise<void>;
  close: () => Promise<void>;
  selectConfiguration: (configurationValue: number) => Promise<void>;
  claimInterface: (interfaceNumber: number) => Promise<void>;
  releaseInterface: (interfaceNumber: number) => Promise<void>;
  transferOut: (endpointNumber: number, data: BufferSource) => Promise<unknown>;
  transferIn: (endpointNumber: number, length: number) => Promise<{ data?: DataView }>;
}

interface NavigatorWithUsb extends Navigator {
  usb?: {
    getDevices: () => Promise<UsbDeviceLike[]>;
    requestDevice: (options: { filters: Array<{ classCode?: number }> }) => Promise<UsbDeviceLike>;
    addEventListener: (
      type: 'connect' | 'disconnect',
      listener: (ev: { device: UsbDeviceLike }) => void
    ) => void;
    removeEventListener: (
      type: 'connect' | 'disconnect',
      listener: (ev: { device: UsbDeviceLike }) => void
    ) => void;
  };
}

export interface UsbProbeResult {
  ok: boolean;
  blockedByIframe?: boolean;
  deviceName?: string;
  usbInfo?: UsbHardwareInfo;
  hardwareState?: string;
  inkBlack?: number | null;
  paperState?: string;
  note: string;
}

export function formatUsbDeviceName(device: {
  manufacturerName?: string;
  productName?: string;
  vendorId: number;
  productId: number;
}): string {
  const parts = [device.manufacturerName?.trim(), device.productName?.trim()].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return `USB Device (${device.vendorId.toString(16).toUpperCase().padStart(4, '0')}:${device.productId.toString(16).toUpperCase().padStart(4, '0')})`;
}

export function isWebUsbSupported(): boolean {
  const nav = navigator as NavigatorWithUsb;
  return Boolean(nav.usb);
}

export async function getPairedUsbDevices(): Promise<UsbDeviceLike[]> {
  const nav = navigator as NavigatorWithUsb;
  if (!nav.usb) return [];
  try {
    return await nav.usb.getDevices();
  } catch {
    return [];
  }
}

export function subscribeUsbHotplug(
  onConnect: (device: UsbDeviceLike) => void,
  onDisconnect: (device: UsbDeviceLike) => void
): () => void {
  const nav = navigator as NavigatorWithUsb;
  if (!nav.usb) return () => {};
  const handleConnect = (ev: { device: UsbDeviceLike }) => onConnect(ev.device);
  const handleDisconnect = (ev: { device: UsbDeviceLike }) => onDisconnect(ev.device);
  try {
    nav.usb.addEventListener('connect', handleConnect);
    nav.usb.addEventListener('disconnect', handleDisconnect);
  } catch {
    return () => {};
  }
  return () => {
    try {
      nav.usb?.removeEventListener('connect', handleConnect);
      nav.usb?.removeEventListener('disconnect', handleDisconnect);
    } catch {
      // ignore
    }
  };
}

async function tryReadPjlStatus(device: UsbDeviceLike): Promise<{
  claimed: boolean;
  pjlModelName?: string;
  inkBlack?: number | null;
  paperState?: string;
}> {
  try {
    if (!device.opened) await device.open();
    if (!device.configuration) {
      await device.selectConfiguration(1);
    }
    const interfaces = device.configuration?.interfaces || [];
    const printerIface =
      interfaces.find((i) => i.alternates.some((a) => a.interfaceClass === 7)) || interfaces[0];
    if (!printerIface) return { claimed: false };

    await device.claimInterface(printerIface.interfaceNumber);
    const alt = printerIface.alternates[0];
    const outEp = alt?.endpoints.find((e) => e.direction === 'out');
    const inEp = alt?.endpoints.find((e) => e.direction === 'in');

    let rawStatus = '';
    if (outEp && inEp) {
      const cmd = new TextEncoder().encode(
        '\x1b%-12345X@PJL INFO ID\r\n@PJL INFO STATUS\r\n@PJL INFO SUPPLIES\r\n\x1b%-12345X'
      );
      await device.transferOut(outEp.endpointNumber, cmd);
      const res = await device.transferIn(inEp.endpointNumber, 1024);
      if (res.data) {
        rawStatus = new TextDecoder().decode(res.data.buffer);
      }
    }

    await device.releaseInterface(printerIface.interfaceNumber);
    await device.close();

    let pjlModelName: string | undefined;
    const idMatch = rawStatus.match(/@PJL INFO ID\s*[\r\n]+([^\r\n]+)/i);
    if (idMatch && idMatch[1].trim()) {
      pjlModelName = idMatch[1].replace(/"/g, '').trim();
    }

    let inkBlack: number | null = null;
    const pctMatch = rawStatus.match(/(\d{1,3})\s*%/);
    if (pctMatch) {
      const v = Number(pctMatch[1]);
      if (v >= 0 && v <= 100) inkBlack = v;
    }

    const paperState = /OUT OF PAPER|MEDIA EMPTY|NO PAPER/i.test(rawStatus)
      ? 'Out of Paper (USB PJL)'
      : /PAPER JAM|JAM/i.test(rawStatus)
        ? 'Paper Jam (USB PJL)'
        : rawStatus
          ? 'Ready (USB PJL)'
          : undefined;

    return { claimed: true, pjlModelName, inkBlack, paperState };
  } catch {
    try {
      if (device.opened) await device.close();
    } catch {
      // ignore
    }
    return { claimed: false };
  }
}

export async function detectUsbPort(scanAllPorts = true): Promise<UsbProbeResult> {
  const nav = navigator as NavigatorWithUsb;
  if (!nav.usb) {
    return {
      ok: false,
      note: 'WebUSB is unavailable in this browser. Use Chrome/Edge or run the Local Print Bridge.',
    };
  }

  try {
    const device = await nav.usb.requestDevice({
      filters: scanAllPorts ? [] : [{ classCode: 7 }],
    });

    const pjl = await tryReadPjlStatus(device);
    const label = pjl.pjlModelName || formatUsbDeviceName(device);
    const portLabel = `USB ${device.vendorId.toString(16).toUpperCase().padStart(4, '0')}:${device.productId.toString(16).toUpperCase().padStart(4, '0')}`;

    const usbInfo: UsbHardwareInfo = {
      vendorId: device.vendorId,
      productId: device.productId,
      manufacturer: device.manufacturerName,
      productName: device.productName || pjl.pjlModelName,
      serialNumber: device.serialNumber,
      portLabel,
    };

    return {
      ok: true,
      deviceName: label,
      usbInfo,
      hardwareState: pjl.claimed ? 'USB Direct Ready' : 'USB Port Connected (OS Driver Active)',
      inkBlack: pjl.inkBlack ?? null,
      paperState: pjl.paperState || 'Ready via OS Driver',
      note: `Connected to ${label} (${portLabel}).`,
    };
  } catch (err) {
    const error = err as Error;
    if (error.name === 'SecurityError') {
      return {
        ok: false,
        blockedByIframe: true,
        note: 'USB port access is blocked inside the embedded preview iframe. Open the app in a full browser tab or run the Local Print Bridge.',
      };
    }
    if (error.name === 'NotFoundError') {
      return {
        ok: false,
        note: 'No USB device was selected from the browser port picker.',
      };
    }
    return {
      ok: false,
      note: `USB scan error: ${error.message}`,
    };
  }
}

// Attempt direct raw WebUSB transferOut to a paired USB printer if OS doesn't lock interface
export async function tryRawWebUsbPrint(
  usbInfo: UsbHardwareInfo | undefined,
  fileUrl: string | null,
  fallbackText: string,
  copies: number
): Promise<{ sentRaw: boolean; note: string }> {
  if (!usbInfo?.vendorId || !usbInfo?.productId) {
    return { sentRaw: false, note: 'Using browser print spooler.' };
  }
  const devices = await getPairedUsbDevices();
  const device = devices.find(
    (d) => d.vendorId === usbInfo.vendorId && d.productId === usbInfo.productId
  );
  if (!device) {
    return { sentRaw: false, note: 'USB device not paired in current tab; using browser print spooler.' };
  }

  try {
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const interfaces = device.configuration?.interfaces || [];
    const printerIface =
      interfaces.find((i) => i.alternates.some((a) => a.interfaceClass === 7)) || interfaces[0];
    if (!printerIface) return { sentRaw: false, note: 'No printable USB interface.' };

    await device.claimInterface(printerIface.interfaceNumber);
    const outEp = printerIface.alternates[0]?.endpoints.find((e) => e.direction === 'out');
    if (!outEp) {
      await device.releaseInterface(printerIface.interfaceNumber);
      await device.close();
      return { sentRaw: false, note: 'No USB OUT endpoint found.' };
    }

    let payloadBytes: Uint8Array;
    if (fileUrl) {
      const res = await fetch(fileUrl);
      const buf = await res.arrayBuffer();
      payloadBytes = new Uint8Array(buf);
    } else {
      payloadBytes = new TextEncoder().encode(fallbackText);
    }

    const pjlStart = new TextEncoder().encode(`\x1b%-12345X@PJL SET COPIES=${copies}\r\n`);
    const pjlEnd = new TextEncoder().encode(`\r\n\x1b%-12345X`);
    const combined = new Uint8Array(pjlStart.length + payloadBytes.length + pjlEnd.length);
    combined.set(pjlStart, 0);
    combined.set(payloadBytes, pjlStart.length);
    combined.set(pjlEnd, pjlStart.length + payloadBytes.length);

    await device.transferOut(outEp.endpointNumber, combined);
    await device.releaseInterface(printerIface.interfaceNumber);
    await device.close();
    return {
      sentRaw: true,
      note: `Transmitted ${combined.byteLength} bytes directly over USB to ${formatUsbDeviceName(device)}.`,
    };
  } catch {
    try {
      if (device.opened) await device.close();
    } catch {
      // ignore
    }
    return {
      sentRaw: false,
      note: 'OS printer driver owns USB interface; routing through OS Print Dialog.',
    };
  }
}

export interface BridgeMachine {
  name: string;
  portName: string;
  driverName: string;
  isUsb: boolean;
  isDefault: boolean;
  online: boolean;
  statusText: string;
  inkBlack: number | null;
  paperState: string;
}

const BRIDGE_URL = 'http://127.0.0.1:4777';

export async function queryLocalBridge(): Promise<{
  running: boolean;
  machines: BridgeMachine[];
}> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 900);
    const res = await fetch(`${BRIDGE_URL}/machines`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return { running: false, machines: [] };
    const json = (await res.json()) as { machines?: BridgeMachine[] };
    return { running: true, machines: json.machines || [] };
  } catch {
    return { running: false, machines: [] };
  }
}

export async function printViaLocalBridge(params: {
  printerName: string;
  copies: number;
  fileUrl: string | null;
  fileName: string | null;
  renderedHtml: string;
  title: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    let fileBase64: string | null = null;
    if (params.fileUrl) {
      const fileRes = await fetch(params.fileUrl);
      if (fileRes.ok) {
        const buf = await fileRes.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        fileBase64 = btoa(binary);
      }
    }

    const res = await fetch(`${BRIDGE_URL}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerName: params.printerName,
        copies: params.copies,
        fileName: params.fileName || `${params.title}.txt`,
        fileBase64,
        renderedHtml: params.renderedHtml,
      }),
    });
    const json = (await res.json()) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok || !json.ok) {
      return { ok: false, message: json.error || json.message || 'Local Print Bridge failed.' };
    }
    return { ok: true, message: json.message || 'Sent directly to local photocopier/printer.' };
  } catch (err) {
    return { ok: false, message: `Local Bridge unreachable: ${(err as Error).message}` };
  }
}
