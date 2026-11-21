import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  Layers,
  Lock,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Trash2,
  Usb,
} from 'lucide-react';
import type {
  BootstrapPayload,
  DeviceType,
  ExamSubmission,
  PrinterConnectionMode,
  PrinterDevice,
} from '../types';
import { apiUrl } from '../utils/api';
import {
  addOrUpdatePrinter,
  deletePrinter,
  deleteSubmission,
  downloadBridgeScript,
  downloadLogsCsv,
  downloadOriginalSubmission,
  getAdminAuthHeaders,
  recordPrint,
  syncBridgeMachines,
  verifyPrinter,
  type BackendMode,
} from '../utils/apiClient';
import { isPlaceholderWordHtml } from '../utils/docParser';
import { parseWordFileInBrowser } from '../utils/docxBrowser';
import { calcSheetsPerCopy, formatBytes, formatDateTime, formatTimeAgo } from '../utils/format';
import { renderPdfFromUrl } from '../utils/pdfRenderer';
import {
  detectUsbPort,
  printViaLocalBridge,
  queryLocalBridge,
} from '../utils/usbDetector';
import { PrinterStatusLabel, SubmissionStatusLabel } from './StatusBadge';

export type AdminTab = 'documents' | 'printers' | 'logs';

interface AdminDashboardProps {
  activeTab: AdminTab;
  onChangeTab: (tab: AdminTab) => void;
  data: BootstrapPayload;
  backendMode?: BackendMode;
  onRefresh: () => void;
  onLockAdmin?: () => void;
  onTriggerPrint: (
    submission: ExamSubmission,
    copies: number,
    pdfPageImages?: string[]
  ) => Promise<void> | void;
}

const BROWSER_PRINTER_ID = 'browser-default';

export function AdminDashboard({
  activeTab,
  data,
  onRefresh,
  onLockAdmin,
  onTriggerPrint,
}: AdminDashboardProps) {
  const [selectedId, setSelectedId] = useState<string>(data.submissions[0]?.id || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'waiting' | 'printed'>('all');
  const [editCopies, setEditCopies] = useState(1);
  const [selectedPrinterId, setSelectedPrinterId] = useState<string>(
    data.printers.find((p) => p.status !== 'offline')?.id || BROWSER_PRINTER_ID
  );
  const [busy, setBusy] = useState(false);
  const [awaitingManualConfirmId, setAwaitingManualConfirmId] = useState<string | null>(null);
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null);
  const [confirmRemovePrinterId, setConfirmRemovePrinterId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'ok' | 'err';
    text: string;
    canFallbackBrowserPrint?: boolean;
  } | null>(null);

  // Rendered PDF page images for preview & reliable printing
  const [pdfPages, setPdfPages] = useState<string[]>([]);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Authenticated object URL for uploaded image previews & printing
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);

  // Live client-side re-parse fallback for previously uploaded .doc files
  const [liveWordDoc, setLiveWordDoc] = useState<{
    id: string;
    html: string;
    pageCount: number;
  } | null>(null);
  const [wordParsing, setWordParsing] = useState(false);

  // Simple Add Machine Form
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [mName, setMName] = useState('');
  const [mDeviceType, setMDeviceType] = useState<DeviceType>('photocopier');
  const [mMode, setMMode] = useState<PrinterConnectionMode>('manual');
  const [mEndpoint, setMEndpoint] = useState('');
  const [usbMsg, setUsbMsg] = useState<{ text: string; blockedIframe?: boolean } | null>(null);

  // Bridge status (quiet optional sync)
  const [bridgeRunning, setBridgeRunning] = useState(false);

  // History Logs Filters
  const [logSearch, setLogSearch] = useState('');
  const [logActionFilter, setLogActionFilter] = useState<string>('all');

  const selectedDoc = useMemo(
    () => data.submissions.find((s) => s.id === selectedId) || data.submissions[0] || null,
    [data.submissions, selectedId]
  );

  const loadPdfPreview = useCallback(async (fileUrl: string) => {
    setPdfLoading(true);
    setPdfError(null);
    try {
      const res = await renderPdfFromUrl(apiUrl(fileUrl), getAdminAuthHeaders());
      setPdfPages(res.pageImages);
    } catch (err) {
      setPdfPages([]);
      setPdfError((err as Error).message || 'Could not render PDF pages.');
    } finally {
      setPdfLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedDoc) {
      setPdfPages([]);
      setPdfError(null);
      setImagePreviewUrl(null);
      setLiveWordDoc(null);
      setWordParsing(false);
      return;
    }
    setEditCopies(selectedDoc.requestedCopies);
    setAwaitingManualConfirmId(null);
    setConfirmDeleteDocId(null);
    setFeedback(null);
    setLiveWordDoc(null);
    setWordParsing(false);

    if (selectedDoc.fileType === 'pdf' && selectedDoc.fileUrl) {
      setImagePreviewUrl(null);
      let active = true;
      setPdfLoading(true);
      setPdfError(null);
      renderPdfFromUrl(apiUrl(selectedDoc.fileUrl), getAdminAuthHeaders())
        .then((res) => {
          if (active) setPdfPages(res.pageImages);
        })
        .catch((err) => {
          if (active) {
            setPdfPages([]);
            setPdfError((err as Error).message || 'Could not render PDF preview.');
          }
        })
        .finally(() => {
          if (active) setPdfLoading(false);
        });
      return () => {
        active = false;
      };
    }

    setPdfPages([]);
    setPdfError(null);

    if (selectedDoc.fileMime?.startsWith('image/') && selectedDoc.fileUrl) {
      if (selectedDoc.fileUrl.startsWith('blob:')) {
        setImagePreviewUrl(selectedDoc.fileUrl);
        return;
      }
      let active = true;
      let createdObjectUrl: string | null = null;
      setImagePreviewUrl(null);
      fetch(apiUrl(selectedDoc.fileUrl), { headers: getAdminAuthHeaders() })
        .then(async (res) => {
          if (!res.ok) throw new Error('Could not load image');
          return await res.blob();
        })
        .then((blob) => {
          if (!active) return;
          createdObjectUrl = URL.createObjectURL(blob);
          setImagePreviewUrl(createdObjectUrl);
        })
        .catch(() => {
          if (active) setImagePreviewUrl(null);
        });
      return () => {
        active = false;
        if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
      };
    }

    setImagePreviewUrl(null);

    if (
      selectedDoc.fileType === 'word' &&
      selectedDoc.fileUrl &&
      isPlaceholderWordHtml(selectedDoc.renderedHtml)
    ) {
      let active = true;
      setWordParsing(true);
      fetch(apiUrl(selectedDoc.fileUrl), { headers: getAdminAuthHeaders() })
        .then(async (res) => {
          if (!res.ok) throw new Error('Could not read file');
          const ab = await res.arrayBuffer();
          return parseWordFileInBrowser(
            new Uint8Array(ab),
            selectedDoc.fileName || selectedDoc.title
          );
        })
        .then((parsed) => {
          if (active && parsed.html) {
            setLiveWordDoc({
              id: selectedDoc.id,
              html: parsed.html,
              pageCount: parsed.pageCount,
            });
          }
        })
        .catch(() => {
          // keep stored fallback if original binary isn't reachable
        })
        .finally(() => {
          if (active) setWordParsing(false);
        });
      return () => {
        active = false;
      };
    }
  }, [selectedDoc?.id, selectedDoc?.fileUrl, selectedDoc?.renderedHtml, selectedDoc?.fileMime]);

  useEffect(() => {
    if (selectedPrinterId === BROWSER_PRINTER_ID) return;
    if (!data.printers.some((p) => p.id === selectedPrinterId)) {
      const ready = data.printers.find((p) => p.status !== 'offline');
      setSelectedPrinterId(ready?.id || BROWSER_PRINTER_ID);
    }
  }, [data.printers, selectedPrinterId]);

  const syncFromLocalBridge = useCallback(async () => {
    const res = await queryLocalBridge();
    setBridgeRunning(res.running);
    if (res.running && res.machines.length > 0) {
      await syncBridgeMachines(res.machines);
      onRefresh();
    }
  }, [onRefresh]);

  useEffect(() => {
    syncFromLocalBridge();
    const timer = setInterval(syncFromLocalBridge, 8000);
    return () => clearInterval(timer);
  }, [syncFromLocalBridge]);

  const filteredDocs = useMemo(() => {
    return data.submissions.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          s.title.toLowerCase().includes(q) ||
          s.senderName.toLowerCase().includes(q) ||
          (s.fileName || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [data.submissions, statusFilter, searchQuery]);

  const kpis = useMemo(() => {
    const waitingDocs = data.submissions.filter((s) => s.status === 'waiting');
    const waiting = waitingDocs.length;
    const waitingCopies = waitingDocs.reduce((sum, s) => sum + s.requestedCopies, 0);
    const printedFiles = data.submissions.filter((s) => s.status === 'printed').length;
    const paperUsed = data.submissions.reduce((sum, s) => sum + s.sheetsConsumed, 0);
    const printersReady = data.printers.filter(
      (p) => p.status === 'connected-digital' || p.status === 'connected-manual'
    ).length;
    return {
      waiting,
      waitingCopies,
      printedFiles,
      paperUsed,
      printersReady,
      totalMachines: data.printers.length,
    };
  }, [data]);

  const senderPaperStats = useMemo(() => {
    const map = new Map<string, { sender: string; files: number; copies: number; sheets: number }>();
    for (const s of data.submissions) {
      const existing = map.get(s.senderName) || {
        sender: s.senderName,
        files: 0,
        copies: 0,
        sheets: 0,
      };
      existing.files += 1;
      existing.copies += s.printedCopies;
      existing.sheets += s.sheetsConsumed;
      map.set(s.senderName, existing);
    }
    return Array.from(map.values());
  }, [data.submissions]);

  const totalSenderSheets = useMemo(
    () => senderPaperStats.reduce((sum, row) => sum + row.sheets, 0),
    [senderPaperStats]
  );

  const filteredLogs = useMemo(() => {
    return data.logs.filter((log) => {
      if (logActionFilter !== 'all') {
        if (logActionFilter === 'machines') {
          if (!log.action.startsWith('PRINTER_')) return false;
        } else if (log.action !== logActionFilter) {
          return false;
        }
      }
      if (logSearch.trim()) {
        const q = logSearch.toLowerCase();
        return (
          log.actorName.toLowerCase().includes(q) ||
          log.details.toLowerCase().includes(q) ||
          log.action.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [data.logs, logActionFilter, logSearch]);

  const activeMachine: PrinterDevice | null = useMemo(() => {
    if (selectedPrinterId === BROWSER_PRINTER_ID) return null;
    return data.printers.find((p) => p.id === selectedPrinterId) || null;
  }, [data.printers, selectedPrinterId]);

  const isUsingBrowserPrinter = selectedPrinterId === BROWSER_PRINTER_ID || !activeMachine;
  const machineIsReady =
    isUsingBrowserPrinter ||
    (activeMachine !== null &&
      (activeMachine.status === 'connected-digital' || activeMachine.status === 'connected-manual'));

  async function handleDeleteDoc(doc: ExamSubmission) {
    setBusy(true);
    setFeedback(null);
    try {
      await deleteSubmission(doc.id);
      if (selectedId === doc.id) setSelectedId('');
      setConfirmDeleteDocId(null);
      setFeedback({ type: 'ok', text: `Deleted "${doc.title}".` });
      onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function printWithBrowserDialog(doc: ExamSubmission, copies: number) {
    // If a PDF didn't render to canvas images, try rendering once more or print via authenticated blob iframe
    let pagesToPrint = pdfPages;
    if (doc.fileType === 'pdf' && pagesToPrint.length === 0 && doc.fileUrl) {
      try {
        const res = await renderPdfFromUrl(apiUrl(doc.fileUrl), getAdminAuthHeaders());
        pagesToPrint = res.pageImages;
        setPdfPages(res.pageImages);
        setPdfError(null);
      } catch {
        const fileRes = await fetch(apiUrl(doc.fileUrl), { headers: getAdminAuthHeaders() });
        if (!fileRes.ok) {
          throw new Error(
            'Could not open PDF for printing in this browser. Use Download Original to print from your PDF viewer.'
          );
        }
        const blobUrl = URL.createObjectURL(await fileRes.blob());
        const iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.src = blobUrl;
        document.body.appendChild(iframe);
        await new Promise<void>((resolve) => {
          iframe.onload = () => resolve();
          setTimeout(() => resolve(), 2000);
        });
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
          setTimeout(() => {
            iframe.remove();
            URL.revokeObjectURL(blobUrl);
          }, 60_000);
          setAwaitingManualConfirmId(doc.id);
          setFeedback({
            type: 'ok',
            text: `Opened browser print dialog for "${doc.title}". Click "Mark Printed" once printing completes.`,
          });
          return;
        } catch {
          iframe.remove();
          URL.revokeObjectURL(blobUrl);
          throw new Error(
            'Could not open PDF for printing in this browser. Use Download Original to print from your PDF viewer.'
          );
        }
      }
    }

    let resolvedDoc: ExamSubmission =
      liveWordDoc && liveWordDoc.id === doc.id
        ? { ...doc, renderedHtml: liveWordDoc.html, pageCount: liveWordDoc.pageCount }
        : doc;

    if (doc.fileMime?.startsWith('image/') && imagePreviewUrl) {
      resolvedDoc = { ...resolvedDoc, fileUrl: imagePreviewUrl };
    }

    await onTriggerPrint(resolvedDoc, copies, pagesToPrint);
    setAwaitingManualConfirmId(doc.id);

    const pagesPerCopy =
      pagesToPrint.length > 0 ? pagesToPrint.length : Math.max(1, resolvedDoc.pageCount || 1);
    const batchedByOs = copies > 10 || copies * pagesPerCopy > 24;

    setFeedback({
      type: 'ok',
      text: batchedByOs
        ? `Print dialog opened for "${doc.title}". Set Copies to ${copies} in your print dialog, then click "Mark Printed".`
        : `Print dialog opened for "${doc.title}" (${copies} ${copies === 1 ? 'copy' : 'copies'}). Click "Mark Printed" once finished.`,
    });
  }

  async function handleDirectPrint() {
    if (!selectedDoc) return;
    setBusy(true);
    setFeedback(null);

    try {
      // Built-in default: print straight from the browser / OS print dialog
      if (isUsingBrowserPrinter) {
        await printWithBrowserDialog(selectedDoc, editCopies);
        return;
      }

      if (!activeMachine || !machineIsReady) {
        await printWithBrowserDialog(selectedDoc, editCopies);
        return;
      }

      // 1. Local PC Bridge (only when actively running) -> fall back seamlessly to Browser Print if it fails
      if (activeMachine.telemetrySource === 'bridge' && bridgeRunning) {
        const bridgeRes = await printViaLocalBridge({
          printerName: activeMachine.name,
          copies: editCopies,
          fileUrl: selectedDoc.fileUrl,
          fileName: selectedDoc.fileName,
          renderedHtml: effectiveWordHtml,
          title: selectedDoc.title,
          authHeaders: getAdminAuthHeaders(),
        });

        if (bridgeRes.ok) {
          await recordPrint(selectedDoc.id, {
            printerId: activeMachine.id,
            copies: editCopies,
            bridgeAlreadySent: true,
          });
          setFeedback({ type: 'ok', text: bridgeRes.message });
          onRefresh();
          return;
        }
        // Automatic fallback to Browser Print if bridge cannot print this file type
        await printWithBrowserDialog(selectedDoc, editCopies);
        return;
      }

      // 2. Digital TCP/IPP machine (only for PDF/images; Word files always use Browser Print)
      if (activeMachine.connectionMode === 'digital' && selectedDoc.fileType !== 'word') {
        try {
          await recordPrint(selectedDoc.id, {
            printerId: activeMachine.id,
            copies: editCopies,
          });
          setFeedback({
            type: 'ok',
            text: `Sent ${editCopies} copies directly to ${activeMachine.name}.`,
          });
          onRefresh();
          return;
        } catch (err) {
          setFeedback({
            type: 'err',
            text: (err as Error).message,
            canFallbackBrowserPrint: true,
          });
          onRefresh();
          return;
        }
      }

      // 3. Reliable Browser / OS Print Dialog (prints PDFs, Word HTML, TXT, Images cleanly)
      await printWithBrowserDialog(selectedDoc, editCopies);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: (err as Error).message,
        canFallbackBrowserPrint: true,
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmPrinted() {
    if (!selectedDoc) return;
    setBusy(true);
    setFeedback(null);
    const printerId =
      activeMachine && machineIsReady ? activeMachine.id : BROWSER_PRINTER_ID;
    const printerLabel =
      activeMachine && machineIsReady ? activeMachine.name : 'This Device';

    try {
      await recordPrint(selectedDoc.id, {
        printerId,
        copies: editCopies,
      });
      setAwaitingManualConfirmId(null);
      setFeedback({
        type: 'ok',
        text: `Marked "${selectedDoc.title}" printed (${editCopies} copies on ${printerLabel}).`,
      });
      onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleDetectUsb() {
    setBusy(true);
    setUsbMsg(null);
    try {
      const probe = await detectUsbPort(true);
      setUsbMsg({ text: probe.note, blockedIframe: probe.blockedByIframe });
      if (!probe.ok || !probe.usbInfo) return;

      const detectedName = probe.deviceName || 'USB Printer';
      const inferredType: DeviceType = /copier|mfp|multifunction|ir|ricoh|xerox|kyocera|konica/i.test(
        detectedName
      )
        ? 'photocopier'
        : 'printer';

      const saved = await addOrUpdatePrinter({
        name: detectedName,
        deviceType: inferredType,
        location: 'USB Port',
        connectionMode: 'manual',
        endpoint: probe.usbInfo.portLabel || 'USB Port',
        isColor: false,
        traySheets: null,
        usbInfo: probe.usbInfo,
        hardwareState: probe.hardwareState,
        inkBlack: probe.inkBlack ?? null,
        paperState: probe.paperState,
      });
      setSelectedPrinterId(saved.id);
      setShowConnectForm(false);
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectMachine(e: FormEvent) {
    e.preventDefault();
    if (!mName.trim()) return;
    setBusy(true);
    try {
      const saved = await addOrUpdatePrinter({
        name: mName.trim(),
        deviceType: mDeviceType,
        location: 'Print Room',
        connectionMode: mMode,
        endpoint:
          mMode === 'digital'
            ? mEndpoint.trim() || 'http://192.168.1.50:631/ipp/print'
            : 'USB / This Computer',
        isColor: false,
        traySheets: null,
      });
      setSelectedPrinterId(saved.id);
      setMName('');
      setMEndpoint('');
      setUsbMsg(null);
      setShowConnectForm(false);
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function verifyMachine(id: string) {
    setBusy(true);
    try {
      await verifyPrinter(id);
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function removeMachine(id: string) {
    setBusy(true);
    try {
      await deletePrinter(id);
      setConfirmRemovePrinterId(null);
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  const effectiveWordHtml =
    selectedDoc && liveWordDoc && liveWordDoc.id === selectedDoc.id
      ? liveWordDoc.html
      : selectedDoc?.renderedHtml || '';
  const effectiveWordPages =
    selectedDoc && liveWordDoc && liveWordDoc.id === selectedDoc.id
      ? liveWordDoc.pageCount
      : selectedDoc?.pageCount || 1;
  const effectivePages = selectedDoc ? pdfPages.length || effectiveWordPages : 1;
  const sheetsNeeded = selectedDoc
    ? calcSheetsPerCopy(effectivePages, selectedDoc.duplex) * editCopies
    : 0;

  return (
    <div className="space-y-6">
      {onLockAdmin && (
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="text-xs text-slate-400">
            Admin Portal unlocked · Delete, print, and machine controls active
          </p>
          <button
            type="button"
            onClick={onLockAdmin}
            className="px-3 py-1.5 rounded-xl text-xs font-medium bg-white/[0.07] hover:bg-white/[0.13] border border-white/10 text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <Lock className="w-3.5 h-3.5 text-sky-400" />
            Lock Admin Portal
          </button>
        </div>
      )}

      {/* Real Live Metrics Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-panel rounded-2xl p-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-slate-400">Waiting to Print</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
              {kpis.waiting}
            </p>
            <p className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
              {kpis.waitingCopies.toLocaleString()} copies requested
            </p>
          </div>
          <Clock className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
        </div>

        <div className="glass-panel rounded-2xl p-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-slate-400">Printed Files</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-emerald-400 mt-1">
              {kpis.printedFiles}
            </p>
            <p className="text-xs text-slate-400 mt-1">Completed jobs</p>
          </div>
          <FileCheck2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        </div>

        <div className="glass-panel rounded-2xl p-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-slate-400">Paper Used</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
              {kpis.paperUsed.toLocaleString()}
            </p>
            <p className="text-xs text-slate-400 mt-1">Total sheets produced</p>
          </div>
          <Layers className="w-4 h-4 text-slate-300 shrink-0 mt-0.5" />
        </div>

        <div className="glass-panel rounded-2xl p-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-slate-400">Machines Ready</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-sky-300 mt-1">
              {kpis.totalMachines === 0 ? 'Browser' : `${kpis.printersReady} / ${kpis.totalMachines}`}
            </p>
            <p className="text-xs text-slate-400 mt-1">
              {kpis.totalMachines === 0
                ? 'This device print ready'
                : kpis.printersReady > 0
                  ? 'Printers available'
                  : 'Use This Device or check cable'}
            </p>
          </div>
          <Printer className="w-4 h-4 text-sky-300 shrink-0 mt-0.5" />
        </div>
      </div>

      {/* TAB 1: PRINT QUEUE (DOCUMENTS TO PRINT) */}
      {activeTab === 'documents' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Incoming Queue List */}
          <div className="lg:col-span-5 glass-panel rounded-2xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-white/10 space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-white">Submitted PDF & Word Files</h2>
                <button
                  type="button"
                  onClick={onRefresh}
                  aria-label="Refresh print queue"
                  className="p-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.11] border border-white/10 text-slate-300 hover:text-white transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-slate-950/70 border border-white/10">
                {(
                  [
                    { id: 'all', label: `All (${data.submissions.length})` },
                    { id: 'waiting', label: `Waiting (${kpis.waiting})` },
                    { id: 'printed', label: `Printed (${kpis.printedFiles})` },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setStatusFilter(tab.id)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                      statusFilter === tab.id
                        ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                        : 'text-slate-400 hover:text-white border border-transparent'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by file, title, or sender..."
                  className="glass-input w-full rounded-xl pl-9 pr-3 py-2 text-xs"
                />
              </div>
            </div>

            <div className="divide-y divide-white/10 max-h-[640px] overflow-y-auto">
              {filteredDocs.length === 0 ? (
                <div className="py-16 px-6 text-center space-y-2">
                  <FileText className="w-8 h-8 text-slate-500 mx-auto" />
                  <p className="text-sm font-medium text-slate-200">
                    {data.submissions.length === 0
                      ? 'No documents submitted yet'
                      : 'No matching documents'}
                  </p>
                  <p className="text-xs text-slate-400">
                    {data.submissions.length === 0
                      ? 'Uploaded PDF and Word files from Send File appear here automatically.'
                      : 'Try another filter or search term.'}
                  </p>
                </div>
              ) : (
                filteredDocs.map((doc) => {
                  const isSelected = selectedDoc?.id === doc.id;
                  const isConfirmingDelete = confirmDeleteDocId === doc.id;
                  return (
                    <div
                      key={doc.id}
                      onClick={() => setSelectedId(doc.id)}
                      className={`p-4 cursor-pointer transition-colors flex items-start justify-between gap-3 ${
                        isSelected ? 'bg-sky-500/15' : 'hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-white truncate">{doc.title}</p>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">
                          {doc.senderName} ·{' '}
                          <span className="uppercase font-mono text-sky-300">{doc.fileType}</span>
                          {' · '}
                          <span className="font-mono tabular-nums">{doc.requestedCopies} copies</span>
                          {' · '}
                          {formatTimeAgo(doc.submittedAt)}
                        </p>
                      </div>

                      <div
                        className="flex items-center gap-2 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isConfirmingDelete ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleDeleteDoc(doc)}
                              className="px-2 py-1 rounded-lg text-xs font-semibold bg-rose-500 hover:bg-rose-400 text-white whitespace-nowrap"
                            >
                              Delete?
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteDocId(null)}
                              className="px-2 py-1 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-200 whitespace-nowrap"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <SubmissionStatusLabel status={doc.status} />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmDeleteDocId(doc.id)}
                              title="Delete submitted document"
                              aria-label={`Delete ${doc.title}`}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-white/10 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Preview & Direct Print */}
          <div className="lg:col-span-7 glass-panel rounded-2xl p-5 sm:p-6 space-y-5">
            {!selectedDoc ? (
              <div className="py-20 text-center space-y-2.5">
                <FileText className="w-8 h-8 text-slate-500 mx-auto" />
                <p className="text-sm font-medium text-slate-200">
                  {data.submissions.length === 0
                    ? 'Waiting for the first document submission'
                    : 'Select a submitted file on the left to preview and print'}
                </p>
                <p className="text-xs text-slate-400">
                  Teachers and staff can upload PDF or Word files in the Send File view.
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span className="uppercase font-mono text-sky-300">{selectedDoc.fileType}</span>
                      <span aria-hidden="true">·</span>
                      <span>Sent by {selectedDoc.senderName}</span>
                      {selectedDoc.fileSizeBytes && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {formatBytes(selectedDoc.fileSizeBytes)}
                          </span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>{selectedDoc.duplex ? 'Double-sided' : 'Single-sided'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{selectedDoc.colorMode === 'color' ? 'Color' : 'B&W'}</span>
                    </div>
                    <h3 className="text-lg font-bold text-white">{selectedDoc.title}</h3>
                    {selectedDoc.notes && (
                      <p className="text-xs text-amber-200/90">Note: {selectedDoc.notes}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0">
                    <SubmissionStatusLabel status={selectedDoc.status} />
                    {confirmDeleteDocId === selectedDoc.id ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleDeleteDoc(selectedDoc)}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500 hover:bg-rose-400 text-white whitespace-nowrap"
                        >
                          Confirm Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteDocId(null)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-200 whitespace-nowrap"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDeleteDocId(selectedDoc.id)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5 items-end">
                    <div className="sm:col-span-5 space-y-1.5">
                      <label className="block text-xs text-slate-400">Copies</label>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          aria-label="Decrease copies"
                          onClick={() => setEditCopies((c) => Math.max(1, c - 1))}
                          className="p-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.14] border border-white/10"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <input
                          type="number"
                          min={1}
                          max={5000}
                          value={editCopies}
                          onChange={(e) => setEditCopies(Math.max(1, Number(e.target.value)))}
                          className="glass-input w-full rounded-lg px-2 py-2 text-center text-sm font-mono font-semibold tabular-nums"
                        />
                        <button
                          type="button"
                          aria-label="Increase copies"
                          onClick={() => setEditCopies((c) => c + 1)}
                          className="p-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.14] border border-white/10"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="sm:col-span-7">
                      <label className="block text-xs text-slate-400 mb-1.5">Printer</label>
                      <select
                        value={selectedPrinterId}
                        onChange={(e) => setSelectedPrinterId(e.target.value)}
                        className="glass-input w-full rounded-lg px-3 py-2 text-xs"
                      >
                        <option value={BROWSER_PRINTER_ID}>This Device (Browser Print)</option>
                        {data.printers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.status === 'offline' ? 'Offline' : 'Ready'})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {!machineIsReady && activeMachine && (
                    <div className="rounded-xl px-4 py-2.5 text-xs bg-amber-500/10 border border-amber-400/30 text-amber-200 flex items-center justify-between gap-3">
                      <span>
                        {activeMachine.name} is offline. Printing will use your browser print dialog.
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedPrinterId(BROWSER_PRINTER_ID)}
                        className="underline whitespace-nowrap shrink-0"
                      >
                        Switch to This Device
                      </button>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={busy || pdfLoading}
                      onClick={handleDirectPrint}
                      className="px-5 py-2.5 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 disabled:opacity-45 text-slate-950 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
                    >
                      <Printer className="w-4 h-4" />
                      {pdfLoading ? 'Preparing PDF...' : 'Print Document'}
                    </button>

                    {awaitingManualConfirmId === selectedDoc.id && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleConfirmPrinted}
                        className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        Mark Printed
                      </button>
                    )}

                    {selectedDoc.fileUrl && (
                      <button
                        type="button"
                        onClick={() =>
                          downloadOriginalSubmission(selectedDoc).catch((err) =>
                            setFeedback({ type: 'err', text: (err as Error).message })
                          )
                        }
                        className="px-4 py-2.5 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-200 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
                      >
                        <Download className="w-4 h-4" />
                        Download Original
                      </button>
                    )}
                  </div>
                </div>

                {feedback && (
                  <div
                    className={`rounded-xl px-4 py-2.5 text-xs font-medium border flex flex-wrap items-center justify-between gap-3 ${
                      feedback.type === 'ok'
                        ? 'bg-emerald-500/12 border-emerald-400/35 text-emerald-200'
                        : 'bg-rose-500/12 border-rose-400/35 text-rose-200'
                    }`}
                  >
                    <span>{feedback.text}</span>
                    {feedback.canFallbackBrowserPrint && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPrinterId(BROWSER_PRINTER_ID);
                          if (selectedDoc) printWithBrowserDialog(selectedDoc, editCopies);
                        }}
                        className="px-3 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-white font-semibold whitespace-nowrap shrink-0"
                      >
                        Print via Browser Dialog
                      </button>
                    )}
                  </div>
                )}

                {/* Document Preview Viewport */}
                <div className="rounded-xl overflow-hidden border border-white/15 bg-slate-950/75">
                  <div className="px-4 py-2.5 border-b border-white/10 flex items-center justify-between gap-3 text-xs text-slate-400">
                    <span className="font-medium text-slate-200">Document Preview</span>
                    <span className="font-mono tabular-nums">
                      {selectedDoc.fileType === 'pdf'
                        ? pdfPages.length > 0
                          ? `${pdfPages.length} ${pdfPages.length === 1 ? 'page' : 'pages'} · ${selectedDoc.paperSize}`
                          : selectedDoc.paperSize
                        : `${effectiveWordPages} ${effectiveWordPages === 1 ? 'page' : 'pages'} · ${selectedDoc.paperSize}`}
                    </span>
                  </div>

                  {selectedDoc.fileType === 'pdf' ? (
                    pdfLoading ? (
                      <div className="p-12 text-center text-xs bg-white text-slate-600">
                        Rendering PDF pages...
                      </div>
                    ) : pdfPages.length > 0 ? (
                      <div className="max-h-[460px] overflow-y-auto bg-slate-900/90 p-5 space-y-5">
                        {pdfPages.map((src, idx) => (
                          <div key={idx} className="space-y-1.5">
                            <img
                              src={src}
                              alt={`Page ${idx + 1}`}
                              className="w-full h-auto rounded shadow-lg bg-white"
                            />
                            <p className="text-[11px] font-mono text-slate-400 text-center tabular-nums">
                              Page {idx + 1} of {pdfPages.length}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="p-10 text-center space-y-3 bg-white text-slate-700 text-xs">
                        <p>{pdfError || 'PDF preview unavailable. You can still print or download.'}</p>
                        <div className="flex items-center justify-center gap-2">
                          {selectedDoc.fileUrl && (
                            <button
                              type="button"
                              onClick={() => loadPdfPreview(selectedDoc.fileUrl!)}
                              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-medium"
                            >
                              Retry Preview
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={handleDirectPrint}
                            className="px-3 py-1.5 rounded-lg bg-sky-600 text-white font-medium"
                          >
                            Print PDF
                          </button>
                        </div>
                      </div>
                    )
                  ) : selectedDoc.fileMime?.startsWith('image/') && selectedDoc.fileUrl ? (
                    <div className="p-6 flex justify-center bg-slate-900/80">
                      {imagePreviewUrl ? (
                        <img
                          src={imagePreviewUrl}
                          alt={selectedDoc.title}
                          referrerPolicy="no-referrer"
                          className="max-h-[380px] object-contain rounded shadow-lg bg-white"
                        />
                      ) : (
                        <div className="py-12 text-xs text-slate-400">Loading image preview...</div>
                      )}
                    </div>
                  ) : (
                    <div className="max-h-[500px] overflow-y-auto bg-slate-900/90 p-4 sm:p-6">
                      {wordParsing ? (
                        <div className="doc-paper-sheet mx-auto shadow-xl flex items-center justify-center text-xs text-slate-600">
                          Reading Word document formatting...
                        </div>
                      ) : (
                        <div
                          className="doc-paper-sheet mx-auto shadow-xl"
                          dangerouslySetInnerHTML={{
                            __html:
                              effectiveWordHtml ||
                              `<p><strong>${selectedDoc.title}</strong></p><p>File attached: ${selectedDoc.fileName || ''}</p>`,
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: SIMPLE MACHINES PLATFORM */}
      {activeTab === 'printers' && (
        <div className="space-y-5">
          <div className="glass-panel rounded-2xl p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-white">Printers & Photocopiers</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                You can always print directly using your computer&apos;s print dialog, or save a
                printer here.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={busy}
                onClick={handleDetectUsb}
                className="px-4 py-2 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-100 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Usb className="w-3.5 h-3.5" />
                Detect USB
              </button>
              <button
                type="button"
                onClick={() => setShowConnectForm((v) => !v)}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                {showConnectForm ? 'Close' : 'Add Printer'}
              </button>
            </div>
          </div>

          {usbMsg && (
            <div className="text-xs text-sky-200 bg-sky-500/10 border border-sky-400/25 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <span>{usbMsg.text}</span>
              {usbMsg.blockedIframe && typeof window !== 'undefined' && (
                <a
                  href={window.location.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open Full Tab
                </a>
              )}
            </div>
          )}

          {showConnectForm && (
            <form onSubmit={handleConnectMachine} className="glass-panel rounded-2xl p-5 sm:p-6 space-y-4">
              <h3 className="text-sm font-semibold text-white">Add a Printer or Photocopier</h3>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">Printer Name</label>
                  <input
                    type="text"
                    required
                    value={mName}
                    onChange={(e) => setMName(e.target.value)}
                    placeholder="Printer or photocopier name"
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">Type</label>
                  <select
                    value={mDeviceType}
                    onChange={(e) => setMDeviceType(e.target.value as DeviceType)}
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs"
                  >
                    <option value="photocopier">Photocopier</option>
                    <option value="printer">Printer</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">Connection</label>
                  <select
                    value={mMode}
                    onChange={(e) => setMMode(e.target.value as PrinterConnectionMode)}
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs"
                  >
                    <option value="manual">USB / This Computer</option>
                    <option value="digital">Network IP / IPP</option>
                  </select>
                </div>
              </div>

              {mMode === 'digital' && (
                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">
                    Network IP or IPP URL
                  </label>
                  <input
                    type="text"
                    required
                    value={mEndpoint}
                    onChange={(e) => setMEndpoint(e.target.value)}
                    placeholder="IP:Port or IPP URL"
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs font-mono"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowConnectForm(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-200 whitespace-nowrap shrink-0"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 whitespace-nowrap shrink-0"
                >
                  Save Printer
                </button>
              </div>
            </form>
          )}

          {data.printers.length === 0 ? (
            <div className="glass-panel rounded-2xl p-10 text-center space-y-2">
              <Printer className="w-7 h-7 text-slate-500 mx-auto" />
              <p className="text-sm font-medium text-slate-200">No saved printers yet</p>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Click <span className="text-white">Print Document</span> in the Print Queue anytime
                to print using your device&apos;s default printer, or add a printer above.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {data.printers.map((p) => {
                const confirmingRemove = confirmRemovePrinterId === p.id;
                return (
                  <div
                    key={p.id}
                    className="glass-panel rounded-2xl p-5 flex flex-col justify-between gap-4"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-sm font-bold text-white truncate">{p.name}</h3>
                          <p className="text-xs text-slate-400 capitalize mt-0.5">
                            {p.deviceType} · {p.connectionMode === 'digital' ? 'Network' : 'USB / Local'}
                          </p>
                        </div>
                        <PrinterStatusLabel status={p.status} />
                      </div>

                      <p className="text-xs font-mono text-slate-400 truncate">{p.endpoint}</p>

                      {p.ink.black !== null && (
                        <p className="text-xs font-mono tabular-nums text-slate-300">
                          Ink: {Math.round(p.ink.black)}%
                        </p>
                      )}
                    </div>

                    <div className="border-t border-white/10 pt-3 flex items-center justify-between text-xs gap-2">
                      <span className="font-mono tabular-nums text-slate-400">
                        {p.totalSheetsPrinted.toLocaleString()} sheets printed
                      </span>

                      <div className="flex items-center gap-3 shrink-0">
                        {p.connectionMode === 'digital' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => verifyMachine(p.id)}
                            className="text-sky-300 hover:text-sky-200 whitespace-nowrap"
                          >
                            Test
                          </button>
                        )}
                        {confirmingRemove ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => removeMachine(p.id)}
                              className="px-2 py-1 rounded bg-rose-500 hover:bg-rose-400 text-white font-semibold"
                            >
                              Remove?
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmRemovePrinterId(null)}
                              className="px-2 py-1 rounded bg-white/10 hover:bg-white/15 text-slate-200"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmRemovePrinterId(p.id)}
                            className="text-rose-400 hover:text-rose-300 whitespace-nowrap"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Optional Silent Bridge Link (unobtrusive single row) */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-2 pt-1 text-xs text-slate-400">
            <span>
              {bridgeRunning
                ? 'Local PC Bridge is active and syncing your computer printers.'
                : 'Optional: Need 1-click silent USB printing without the browser dialog?'}
            </span>
            <button
              type="button"
              onClick={() =>
                downloadBridgeScript().catch((err) =>
                  setFeedback({ type: 'err', text: (err as Error).message })
                )
              }
              className="text-sky-300 hover:text-sky-200 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download PC Print Bridge
            </button>
          </div>
        </div>
      )}

      {/* TAB 3: DOCUMENT HISTORY LOGS & PAPER USAGE */}
      {activeTab === 'logs' && (
        <div className="space-y-6">
          <div className="glass-panel rounded-2xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-white">Document History Logs</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Live audit log of uploads, deletions, machine changes, and print jobs.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    placeholder="Search person or details..."
                    className="glass-input rounded-xl pl-8 pr-3 py-2 text-xs w-48 sm:w-56"
                  />
                </div>

                <select
                  value={logActionFilter}
                  onChange={(e) => setLogActionFilter(e.target.value)}
                  className="glass-input rounded-xl px-3 py-2 text-xs"
                >
                  <option value="all">All Events</option>
                  <option value="DOCUMENT_SENT">Document Sent</option>
                  <option value="PRINT_COMPLETED">Print Completed</option>
                  <option value="PRINT_FAILED">Print Failed</option>
                  <option value="DOCUMENT_DELETED">Document Deleted</option>
                  <option value="machines">Machine Events</option>
                </select>

                <button
                  type="button"
                  onClick={() =>
                    downloadLogsCsv().catch((err) =>
                      setFeedback({ type: 'err', text: (err as Error).message })
                    )
                  }
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export CSV
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-slate-400">
                    <th className="py-3 px-5 font-medium">Time</th>
                    <th className="py-3 px-4 font-medium">Person</th>
                    <th className="py-3 px-4 font-medium">Event</th>
                    <th className="py-3 px-4 text-right font-medium">Copies / Sheets</th>
                    <th className="py-3 px-5 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.07]">
                  {filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-slate-400">
                        {data.logs.length === 0
                          ? 'No activity recorded yet.'
                          : 'No log entries match your current filter.'}
                      </td>
                    </tr>
                  ) : (
                    filteredLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-white/[0.03]">
                        <td className="py-3 px-5 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                          {formatDateTime(log.timestamp)}
                        </td>
                        <td className="py-3 px-4 text-slate-200 whitespace-nowrap">
                          {log.actorName}
                        </td>
                        <td className="py-3 px-4 font-mono text-sky-300 whitespace-nowrap">
                          {log.action.replace(/_/g, ' ')}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                          {log.copiesProduced ? `${log.copiesProduced}c / ${log.sheetsUsed ?? 0}sh` : '—'}
                        </td>
                        <td className="py-3 px-5 text-slate-300">{log.details}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="glass-panel rounded-2xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between gap-4">
              <h3 className="text-sm font-semibold text-white">Paper Usage by Sender</h3>
              <span className="text-xs font-mono tabular-nums text-slate-400">
                Total: {totalSenderSheets.toLocaleString()} sheets
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-slate-400">
                    <th className="py-3 px-5 font-medium">Sender</th>
                    <th className="py-3 px-4 text-right font-medium">Files Sent</th>
                    <th className="py-3 px-4 text-right font-medium">Copies Printed</th>
                    <th className="py-3 px-5 text-right font-medium">Sheets Used</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.07]">
                  {senderPaperStats.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-10 text-center text-slate-400">
                        No paper usage recorded yet.
                      </td>
                    </tr>
                  ) : (
                    senderPaperStats.map((row) => (
                      <tr key={row.sender} className="hover:bg-white/[0.03]">
                        <td className="py-3 px-5 text-white font-medium">{row.sender}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">{row.files}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          {row.copies}
                        </td>
                        <td className="py-3 px-5 text-right font-mono tabular-nums text-sky-300">
                          {row.sheets.toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
