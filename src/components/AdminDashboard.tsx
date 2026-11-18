import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  Droplets,
  ExternalLink,
  FileCheck2,
  FileText,
  Layers,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Trash2,
  Usb,
  Clock,
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
  recordPrint,
  syncBridgeMachines,
  updatePrinter,
  verifyPrinter,
  type BackendMode,
} from '../utils/apiClient';
import { calcSheetsPerCopy, formatBytes, formatDateTime, formatTimeAgo } from '../utils/format';
import { renderPdfFromUrl } from '../utils/pdfRenderer';
import {
  detectUsbPort,
  printViaLocalBridge,
  queryLocalBridge,
  tryRawWebUsbPrint,
} from '../utils/usbDetector';
import { DomainSharePanel } from './DomainSharePanel';
import { PrinterStatusLabel, SubmissionStatusLabel } from './StatusBadge';
import colorPrinterImg from '../assets/images/printer_ecotank_color_1794773700020.jpg';
import laserPrinterImg from '../assets/images/printer_enterprise_laser_1794773699477.jpg';

export type AdminTab = 'documents' | 'printers' | 'logs';

interface AdminDashboardProps {
  activeTab: AdminTab;
  onChangeTab: (tab: AdminTab) => void;
  data: BootstrapPayload;
  backendMode?: BackendMode;
  onRefresh: () => void;
  onTriggerPrint: (
    submission: ExamSubmission,
    copies: number,
    pdfPageImages?: string[]
  ) => void;
}

const PRINT_COPY_PRESETS = [1, 10, 30, 50];

export function AdminDashboard({
  activeTab,
  onChangeTab,
  data,
  backendMode,
  onRefresh,
  onTriggerPrint,
}: AdminDashboardProps) {
  const [selectedId, setSelectedId] = useState<string>(data.submissions[0]?.id || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'waiting' | 'printed'>('all');
  const [editCopies, setEditCopies] = useState(1);
  const [selectedPrinterId, setSelectedPrinterId] = useState(data.printers[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [awaitingManualConfirmId, setAwaitingManualConfirmId] = useState<string | null>(null);
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null);
  const [confirmRemovePrinterId, setConfirmRemovePrinterId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Rendered PDF page images for preview & reliable printing
  const [pdfPages, setPdfPages] = useState<string[]>([]);
  const [pdfLoading, setPdfLoading] = useState(false);

  // Connect Machine Form
  const [showConnectForm, setShowConnectForm] = useState(data.printers.length === 0);
  const [mName, setMName] = useState('');
  const [mDeviceType, setMDeviceType] = useState<DeviceType>('photocopier');
  const [mLocation, setMLocation] = useState('Print Room');
  const [mMode, setMMode] = useState<PrinterConnectionMode>('manual');
  const [mEndpoint, setMEndpoint] = useState('Local USB / OS Print Driver');
  const [mIsColor, setMIsColor] = useState(false);
  const [mSheets, setMSheets] = useState<string>('');
  const [usbMsg, setUsbMsg] = useState<{ text: string; blockedIframe?: boolean } | null>(null);

  // Bridge status & tray inputs
  const [bridgeRunning, setBridgeRunning] = useState(false);
  const [trayEditMap, setTrayEditMap] = useState<Record<string, string>>({});

  // History Logs Filters
  const [logSearch, setLogSearch] = useState('');
  const [logActionFilter, setLogActionFilter] = useState<string>('all');

  const selectedDoc = useMemo(
    () => data.submissions.find((s) => s.id === selectedId) || data.submissions[0] || null,
    [data.submissions, selectedId]
  );

  useEffect(() => {
    if (!selectedDoc) {
      setPdfPages([]);
      return;
    }
    setEditCopies(selectedDoc.requestedCopies);
    setAwaitingManualConfirmId(null);
    setConfirmDeleteDocId(null);
    setFeedback(null);

    if (selectedDoc.fileType === 'pdf' && selectedDoc.fileUrl) {
      let cancelled = false;
      setPdfLoading(true);
      renderPdfFromUrl(apiUrl(selectedDoc.fileUrl))
        .then((res) => {
          if (!cancelled) setPdfPages(res.pageImages);
        })
        .catch(() => {
          if (!cancelled) setPdfPages([]);
        })
        .finally(() => {
          if (!cancelled) setPdfLoading(false);
        });
      return () => {
        cancelled = true;
      };
    } else {
      setPdfPages([]);
    }
  }, [selectedDoc?.id, selectedDoc?.fileUrl]);

  useEffect(() => {
    const connected = data.printers.filter((p) => p.status !== 'offline');
    if (!selectedPrinterId || !data.printers.some((p) => p.id === selectedPrinterId)) {
      setSelectedPrinterId(connected[0]?.id || data.printers[0]?.id || '');
    }
  }, [data.printers, selectedPrinterId]);

  async function syncFromLocalBridge() {
    const res = await queryLocalBridge();
    setBridgeRunning(res.running);
    if (res.running && res.machines.length > 0) {
      await syncBridgeMachines(res.machines);
      onRefresh();
    }
  }

  useEffect(() => {
    syncFromLocalBridge();
    const timer = setInterval(syncFromLocalBridge, 6000);
    return () => clearInterval(timer);
  }, []);

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

  const activeMachine: PrinterDevice | null = useMemo(
    () => data.printers.find((p) => p.id === selectedPrinterId) || null,
    [data.printers, selectedPrinterId]
  );

  const machineIsReady =
    activeMachine !== null &&
    (activeMachine.status === 'connected-digital' || activeMachine.status === 'connected-manual');

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

  async function handleDirectPrint() {
    if (!selectedDoc || !activeMachine || !machineIsReady) return;
    setBusy(true);
    setFeedback(null);

    try {
      // 1. Local PC Bridge (prints silently to USB/OS photocopier)
      if (activeMachine.telemetrySource === 'bridge' && bridgeRunning) {
        const bridgeRes = await printViaLocalBridge({
          printerName: activeMachine.name,
          copies: editCopies,
          fileUrl: selectedDoc.fileUrl,
          fileName: selectedDoc.fileName,
          renderedHtml: selectedDoc.renderedHtml,
          title: selectedDoc.title,
        });
        if (!bridgeRes.ok) throw new Error(bridgeRes.message);

        await recordPrint(selectedDoc.id, {
          printerId: activeMachine.id,
          copies: editCopies,
          bridgeAlreadySent: true,
        });
        setFeedback({ type: 'ok', text: bridgeRes.message });
        onRefresh();
        return;
      }

      // 2. Digital TCP/IPP machine
      if (activeMachine.connectionMode === 'digital') {
        await recordPrint(selectedDoc.id, {
          printerId: activeMachine.id,
          copies: editCopies,
        });
        setFeedback({
          type: 'ok',
          text: `Sent ${editCopies} copies directly to ${activeMachine.name} (Digital).`,
        });
        onRefresh();
        return;
      }

      // 3. WebUSB / Manual USB: first try direct raw WebUSB transferOut
      if (activeMachine.usbInfo?.vendorId) {
        const rawAttempt = await tryRawWebUsbPrint(
          activeMachine.usbInfo,
          selectedDoc.fileUrl,
          selectedDoc.title,
          editCopies
        );
        if (rawAttempt.sentRaw) {
          await recordPrint(selectedDoc.id, {
            printerId: activeMachine.id,
            copies: editCopies,
            bridgeAlreadySent: true,
          });
          setFeedback({ type: 'ok', text: rawAttempt.note });
          onRefresh();
          return;
        }
      }

      // 4. Reliable Browser Direct Print (prints rendered PDF images or Word HTML directly!)
      onTriggerPrint(selectedDoc, editCopies, pdfPages);
      setAwaitingManualConfirmId(selectedDoc.id);
      setFeedback({
        type: 'ok',
        text: `Printing "${selectedDoc.title}" (${editCopies} copies) via ${activeMachine.name}. Click "Confirm Printed" once finished.`,
      });
    } catch (err) {
      setFeedback({ type: 'err', text: (err as Error).message });
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmManualPrinted() {
    if (!selectedDoc || !activeMachine) return;
    setBusy(true);
    setFeedback(null);
    try {
      await recordPrint(selectedDoc.id, {
        printerId: activeMachine.id,
        copies: editCopies,
      });
      setAwaitingManualConfirmId(null);
      setFeedback({
        type: 'ok',
        text: `Printed ${editCopies} copies on ${activeMachine.name}.`,
      });
      onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // Detect USB device AND automatically register it with its real hardware name immediately!
  async function handleDetectAndConnectUsb(scanAllPorts: boolean) {
    setBusy(true);
    setUsbMsg(null);
    try {
      const probe = await detectUsbPort(scanAllPorts);
      setUsbMsg({ text: probe.note, blockedIframe: probe.blockedByIframe });
      if (!probe.ok || !probe.usbInfo) return;

      const detectedName = probe.deviceName || 'USB Photocopier';
      const inferredType: DeviceType = /copier|mfp|multifunction|ir|ricoh|xerox|kyocera|konica/i.test(
        detectedName
      )
        ? 'photocopier'
        : mDeviceType;

      const saved = await addOrUpdatePrinter({
        name: detectedName,
        deviceType: inferredType,
        location: mLocation.trim() || 'USB Port',
        connectionMode: 'manual',
        endpoint: probe.usbInfo.portLabel || 'USB Port',
        isColor: mIsColor,
        traySheets: mSheets.trim() !== '' ? Number(mSheets) : null,
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
      const parsedSheets = mSheets.trim() !== '' ? Number(mSheets) : null;
      await addOrUpdatePrinter({
        name: mName.trim(),
        deviceType: mDeviceType,
        location: mLocation.trim() || 'Print Room',
        connectionMode: mMode,
        endpoint: mEndpoint.trim(),
        isColor: mIsColor,
        traySheets: parsedSheets,
      });
      setMName('');
      setMSheets('');
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

  async function updateMachine(id: string, patch: Record<string, unknown>) {
    setBusy(true);
    try {
      await updatePrinter(id, patch);
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

  const effectivePages = selectedDoc ? pdfPages.length || selectedDoc.pageCount : 1;
  const sheetsNeeded = selectedDoc
    ? calcSheetsPerCopy(effectivePages, selectedDoc.duplex) * editCopies
    : 0;

  return (
    <div className="space-y-6">
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
              {kpis.printersReady} / {kpis.totalMachines}
            </p>
            <p className="text-xs text-slate-400 mt-1">
              {kpis.printersReady > 0 ? 'Hardware online' : 'Connect a machine'}
            </p>
          </div>
          <Printer className="w-4 h-4 text-sky-300 shrink-0 mt-0.5" />
        </div>
      </div>

      {/* Shareable Domain & Live Access Link */}
      <DomainSharePanel
        publicDomain={data.publicDomain}
        liveAppUrl={data.liveAppUrl}
        backendMode={backendMode}
      />

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
                        isSelected
                          ? 'bg-sky-500/15'
                          : 'hover:bg-white/[0.04]'
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

          {/* Right: Preview & Direct Print Studio */}
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

                {data.printers.length === 0 ? (
                  <div className="rounded-xl p-4 bg-amber-500/10 border border-amber-400/30 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-amber-200">
                          No Printer or Photocopier Connected
                        </p>
                        <p className="text-xs text-amber-100/80 mt-0.5">
                          Connect your USB photocopier or network printer in Machines to print
                          directly from Damaria Docs.
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowConnectForm(true);
                        onChangeTab('printers');
                      }}
                      className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-400 hover:bg-amber-300 text-slate-950 whitespace-nowrap shrink-0"
                    >
                      Connect Machine
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5 items-end">
                      <div className="sm:col-span-5 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-xs text-slate-400">Copies to Print</label>
                          <div className="flex items-center gap-1">
                            {PRINT_COPY_PRESETS.map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => setEditCopies(preset)}
                                className={`px-2 py-0.5 rounded text-[11px] font-mono tabular-nums transition-colors ${
                                  editCopies === preset
                                    ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                                    : 'bg-white/[0.05] text-slate-400 hover:text-white border border-white/10'
                                }`}
                              >
                                {preset}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            aria-label="Decrease copies"
                            onClick={() => setEditCopies((c) => Math.max(1, c - 5))}
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
                            onClick={() => setEditCopies((c) => c + 5)}
                            className="p-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.14] border border-white/10"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="sm:col-span-5">
                        <label className="block text-xs text-slate-400 mb-1.5">
                          Connected Printer / Photocopier
                        </label>
                        <select
                          value={selectedPrinterId}
                          onChange={(e) => setSelectedPrinterId(e.target.value)}
                          className="glass-input w-full rounded-lg px-3 py-2 text-xs"
                        >
                          {data.printers.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ·{' '}
                              {p.status === 'connected-digital'
                                ? 'Connected (Digital)'
                                : p.status === 'connected-manual'
                                  ? 'Connected (Manual)'
                                  : 'Offline'}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="sm:col-span-2 text-left sm:text-right font-mono">
                        <p className="text-[11px] text-slate-400">Sheets</p>
                        <p className="text-base font-bold text-sky-300 tabular-nums">
                          {sheetsNeeded.toLocaleString()}
                        </p>
                      </div>
                    </div>

                    {!machineIsReady && activeMachine && (
                      <div className="rounded-xl px-4 py-2.5 text-xs bg-rose-500/10 border border-rose-400/30 text-rose-200 flex items-center justify-between gap-3">
                        <span>
                          {activeMachine.name} is offline: {activeMachine.connectionMessage}
                        </span>
                        <button
                          type="button"
                          onClick={() => onChangeTab('printers')}
                          className="underline whitespace-nowrap shrink-0"
                        >
                          Check Machine
                        </button>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        disabled={busy || !machineIsReady || pdfLoading}
                        onClick={handleDirectPrint}
                        className="px-5 py-2.5 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 disabled:opacity-45 text-slate-950 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
                      >
                        <Printer className="w-4 h-4" />
                        {pdfLoading ? 'Preparing PDF Pages...' : 'Print Directly from Platform'}
                      </button>

                      {awaitingManualConfirmId === selectedDoc.id && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={handleConfirmManualPrinted}
                          className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          Confirm Printed ({editCopies} copies)
                        </button>
                      )}

                      {selectedDoc.fileUrl && (
                        <button
                          type="button"
                          onClick={() => downloadOriginalSubmission(selectedDoc)}
                          className="px-4 py-2.5 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-200 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
                        >
                          <Download className="w-4 h-4" />
                          Download Original
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {feedback && (
                  <div
                    className={`rounded-xl px-4 py-2.5 text-xs font-medium border ${
                      feedback.type === 'ok'
                        ? 'bg-emerald-500/12 border-emerald-400/35 text-emerald-200'
                        : 'bg-rose-500/12 border-rose-400/35 text-rose-200'
                    }`}
                  >
                    {feedback.text}
                  </div>
                )}

                {/* Document Preview Viewport */}
                <div className="rounded-xl overflow-hidden border border-white/15 bg-slate-950/75">
                  <div className="px-4 py-2.5 border-b border-white/10 flex items-center justify-between gap-3 text-xs text-slate-400">
                    <span className="font-medium text-slate-200">Document Preview</span>
                    <span className="font-mono tabular-nums">
                      {selectedDoc.fileType === 'pdf'
                        ? pdfPages.length > 0
                          ? `${pdfPages.length} pages rendered · ${selectedDoc.paperSize}`
                          : selectedDoc.paperSize
                        : `${selectedDoc.pageCount} ${selectedDoc.pageCount === 1 ? 'page' : 'pages'} · ${selectedDoc.paperSize}`}
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
                      <div className="p-10 text-center text-xs text-slate-600 bg-white">
                        PDF uploaded. Use Download Original or Print Directly.
                      </div>
                    )
                  ) : selectedDoc.fileMime?.startsWith('image/') && selectedDoc.fileUrl ? (
                    <div className="p-6 flex justify-center bg-slate-900/80">
                      <img
                        src={apiUrl(selectedDoc.fileUrl)}
                        alt={selectedDoc.title}
                        referrerPolicy="no-referrer"
                        className="max-h-[380px] object-contain rounded shadow-lg bg-white"
                      />
                    </div>
                  ) : (
                    <div
                      className="p-7 max-h-[440px] overflow-y-auto bg-white text-slate-900 text-sm leading-relaxed space-y-2 [&_h2]:text-lg [&_h2]:font-bold [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_hr]:my-3"
                      dangerouslySetInnerHTML={{
                        __html:
                          selectedDoc.renderedHtml ||
                          `<p><strong>${selectedDoc.title}</strong></p><p>File attached: ${selectedDoc.fileName || ''}</p>`,
                      }}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: PRINTERS & PHOTOCOPIERS */}
      {activeTab === 'printers' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-white">
                Connected Printers & Photocopiers
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Detects USB cable changes and reads device names, status, ink, and paper directly
                from your hardware.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => handleDetectAndConnectUsb(true)}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Usb className="w-3.5 h-3.5" />
                Detect & Connect USB Port
              </button>
              <button
                type="button"
                onClick={syncFromLocalBridge}
                className="px-3 py-2 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                {bridgeRunning ? 'Local Bridge Active' : 'Scan Local Bridge'}
              </button>
              <button
                type="button"
                onClick={() => setShowConnectForm(!showConnectForm)}
                className="px-3.5 py-2 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" />
                {showConnectForm ? 'Hide Manual Form' : 'Add Manually'}
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
                  Open Full Tab for USB
                </a>
              )}
            </div>
          )}

          <div className="glass-panel-subtle rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1 max-w-2xl">
              <p className="text-xs font-semibold text-white">
                {bridgeRunning
                  ? 'Local PC USB & Photocopier Bridge Connected (127.0.0.1:4777)'
                  : 'Local PC USB Bridge (Recommended for Windows / macOS USB Photocopiers)'}
              </p>
              <p className="text-xs text-slate-400 leading-relaxed">
                Run{' '}
                <span className="font-mono text-sky-300">node damaria-docs-bridge.mjs</span> on the
                computer connected to the photocopier to auto-detect its exact USB port & name and
                print PDF or Word files directly without browser popups.
              </p>
            </div>
            <button
              type="button"
              onClick={() => downloadBridgeScript()}
              className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-white/10 hover:bg-white/15 text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download Local Bridge
            </button>
          </div>

          {showConnectForm && (
            <form onSubmit={handleConnectMachine} className="glass-panel rounded-2xl p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3.5">
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    Manual or Digital Network Machine Setup
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Add a USB machine manually or verify a network photocopier via IPP / TCP port
                    9100.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">
                    Machine Name
                  </label>
                  <input
                    type="text"
                    required
                    value={mName}
                    onChange={(e) => setMName(e.target.value)}
                    placeholder="e.g. Canon iR-ADV Photocopier"
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">Machine Type</label>
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
                  <label className="block text-xs text-slate-300 mb-1.5">Connection Type</label>
                  <select
                    value={mMode}
                    onChange={(e) => {
                      const mode = e.target.value as PrinterConnectionMode;
                      setMMode(mode);
                      setMEndpoint(
                        mode === 'digital'
                          ? 'http://192.168.1.50:631/ipp/print'
                          : 'Local USB / OS Print Driver'
                      );
                    }}
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs"
                  >
                    <option value="manual">Manual (USB / Local Computer)</option>
                    <option value="digital">Digital (IPP URL or IP:Port)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">
                    {mMode === 'digital' ? 'IPP URL or IP:Port' : 'USB / Driver Port'}
                  </label>
                  <input
                    type="text"
                    required
                    value={mEndpoint}
                    onChange={(e) => setMEndpoint(e.target.value)}
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">Location</label>
                  <input
                    type="text"
                    value={mLocation}
                    onChange={(e) => setMLocation(e.target.value)}
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1.5">
                    Tray Sheets Loaded (Optional)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={5000}
                    value={mSheets}
                    onChange={(e) => setMSheets(e.target.value)}
                    placeholder="Leave blank if auto-read"
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs font-mono tabular-nums"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={mIsColor}
                    onChange={(e) => setMIsColor(e.target.checked)}
                    className="w-4 h-4 rounded border-white/20 bg-slate-900 text-sky-500"
                  />
                  Color Printing Capable
                </label>

                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 whitespace-nowrap shrink-0"
                >
                  {mMode === 'digital' ? 'Connect & Verify Digital Machine' : 'Add Manual Machine'}
                </button>
              </div>
            </form>
          )}

          {data.printers.length === 0 ? (
            <div className="glass-panel rounded-2xl p-12 text-center space-y-2.5">
              <Printer className="w-8 h-8 text-slate-500 mx-auto" />
              <p className="text-sm font-medium text-slate-200">
                No printers or photocopiers connected yet
              </p>
              <p className="text-xs text-slate-400">
                Click Detect & Connect USB Port above or run the Local Bridge to read your machine
                automatically.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {data.printers.map((p) => {
                const confirmingRemove = confirmRemovePrinterId === p.id;
                return (
                  <div key={p.id} className="glass-panel rounded-2xl overflow-hidden flex flex-col">
                    <div className="relative h-36 bg-slate-900 border-b border-white/10">
                      <img
                        src={p.isColor ? colorPrinterImg : laserPrinterImg}
                        alt={p.name}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover opacity-80"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/95 via-slate-950/45 to-transparent" />
                      <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs text-slate-300 capitalize truncate">
                            {p.deviceType} · {p.location}
                          </p>
                          <h3 className="text-sm font-bold text-white truncate">{p.name}</h3>
                        </div>
                        <PrinterStatusLabel status={p.status} />
                      </div>
                    </div>

                    <div className="p-5 space-y-4 flex-1 flex flex-col justify-between">
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs gap-2">
                            <span className="font-mono text-slate-300 truncate">{p.endpoint}</span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => verifyMachine(p.id)}
                              className="text-sky-300 hover:text-sky-200 whitespace-nowrap shrink-0"
                            >
                              Check Status
                            </button>
                          </div>
                          <p className="text-[11px] text-slate-300">
                            State: <span className="font-medium text-white">{p.hardwareState}</span>
                          </p>
                          <p className="text-[11px] text-slate-400 leading-snug">
                            {p.connectionMessage}
                          </p>
                        </div>

                        <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-950/70 border border-white/10">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => updateMachine(p.id, { connectionMode: 'digital' })}
                            className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                              p.connectionMode === 'digital'
                                ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                                : 'text-slate-400 hover:text-white border border-transparent'
                            }`}
                          >
                            <Cpu className="w-3.5 h-3.5" />
                            Digital
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => updateMachine(p.id, { connectionMode: 'manual' })}
                            className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                              p.connectionMode === 'manual'
                                ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                                : 'text-slate-400 hover:text-white border border-transparent'
                            }`}
                          >
                            <Usb className="w-3.5 h-3.5" />
                            Manual
                          </button>
                        </div>

                        {/* Honest Ink / Toner Reading */}
                        <div className="space-y-2 border-t border-white/10 pt-3">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-300 font-medium inline-flex items-center gap-1.5">
                              <Droplets className="w-3.5 h-3.5 text-sky-400" />
                              Ink / Toner Status
                            </span>
                            {p.ink.black !== null && (
                              <span className="font-mono tabular-nums text-white">
                                {Math.round(p.ink.black)}%
                              </span>
                            )}
                          </div>
                          {p.ink.black !== null ? (
                            <>
                              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                                <div
                                  className="h-full bg-slate-200"
                                  style={{ width: `${p.ink.black}%` }}
                                />
                              </div>
                              {p.isColor && p.ink.cyan !== null && (
                                <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] font-mono tabular-nums text-slate-300">
                                  <span>C: {Math.round(p.ink.cyan ?? 0)}%</span>
                                  <span>M: {Math.round(p.ink.magenta ?? 0)}%</span>
                                  <span>Y: {Math.round(p.ink.yellow ?? 0)}%</span>
                                </div>
                              )}
                            </>
                          ) : (
                            <p className="text-[11px] text-slate-400">{p.supplyNote}</p>
                          )}
                        </div>

                        {/* Honest Paper Tray Reading */}
                        <div className="space-y-2 border-t border-white/10 pt-3">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-300 font-medium inline-flex items-center gap-1.5">
                              <Layers className="w-3.5 h-3.5 text-sky-400" />
                              Paper Status
                            </span>
                            {p.traySheets !== null && (
                              <span className="font-mono tabular-nums text-slate-200">
                                {p.traySheets} sheets
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-300">{p.paperState}</p>
                          <div className="flex items-center gap-2 pt-1">
                            <input
                              type="number"
                              min={0}
                              max={5000}
                              value={trayEditMap[p.id] ?? ''}
                              onChange={(e) =>
                                setTrayEditMap((prev) => ({ ...prev, [p.id]: e.target.value }))
                              }
                              placeholder="Set loaded sheets..."
                              className="glass-input flex-1 rounded-lg px-2.5 py-1.5 text-xs font-mono tabular-nums"
                            />
                            <button
                              type="button"
                              disabled={busy || !trayEditMap[p.id]}
                              onClick={() => {
                                updateMachine(p.id, { setTraySheets: Number(trayEditMap[p.id]) });
                                setTrayEditMap((prev) => ({ ...prev, [p.id]: '' }));
                              }}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-sky-300 disabled:opacity-40 whitespace-nowrap shrink-0"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="border-t border-white/10 pt-3 flex items-center justify-between text-xs gap-2">
                        <span className="font-mono tabular-nums text-slate-400">
                          {p.totalSheetsPrinted.toLocaleString()} sh printed
                        </span>
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
                            className="text-rose-400 hover:text-rose-300"
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

          {/* Paper Usage by Sender */}
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

      {/* TAB 3: DOCUMENT HISTORY LOGS */}
      {activeTab === 'logs' && (
        <div className="glass-panel rounded-2xl overflow-hidden">
          <div className="p-4 sm:p-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Document History Logs</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Live audit log of uploads, deletions, USB/machine changes, and print jobs.
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
                onClick={() => downloadLogsCsv()}
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
      )}
    </div>
  );
}
