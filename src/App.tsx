import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FileUp, Printer } from 'lucide-react';
import { AdminDashboard, type AdminTab } from './components/AdminDashboard';
import { PrintablePacket } from './components/PrintablePacket';
import { TeacherPortal } from './components/TeacherPortal';
import type { BootstrapPayload, ExamSubmission } from './types';
import {
  formatUsbDeviceName,
  getPairedUsbDevices,
  subscribeUsbHotplug,
} from './utils/usbDetector';

export default function App() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState<'send' | 'admin'>('send');
  const [adminTab, setAdminTab] = useState<AdminTab>('documents');
  const [printState, setPrintState] = useState<{
    submission: ExamSubmission;
    copies: number;
    pdfPageImages: string[];
  } | null>(null);

  const fetchBootstrap = useCallback(async () => {
    try {
      const res = await fetch('/api/bootstrap');
      if (!res.ok) throw new Error('Unable to connect to Damaria Docs server');
      const json = (await res.json()) as BootstrapPayload;
      setData(json);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBootstrap();
  }, [fetchBootstrap]);

  useEffect(() => {
    const timer = setInterval(fetchBootstrap, 5000);
    return () => clearInterval(timer);
  }, [fetchBootstrap]);

  // Sync paired USB devices on startup and listen for live USB plug / unplug
  useEffect(() => {
    getPairedUsbDevices().then(async (devices) => {
      if (devices.length === 0) return;
      await fetch('/api/printers/usb-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairedDevices: devices.map((d) => ({
            vendorId: d.vendorId,
            productId: d.productId,
            name: formatUsbDeviceName(d),
          })),
        }),
      });
      fetchBootstrap();
    });

    const unsubscribe = subscribeUsbHotplug(
      async (device) => {
        await fetch('/api/printers/usb-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'connect',
            vendorId: device.vendorId,
            productId: device.productId,
            productName: device.productName,
            manufacturer: device.manufacturerName,
          }),
        });
        fetchBootstrap();
      },
      async (device) => {
        await fetch('/api/printers/usb-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'disconnect',
            vendorId: device.vendorId,
            productId: device.productId,
            productName: device.productName,
            manufacturer: device.manufacturerName,
          }),
        });
        fetchBootstrap();
      }
    );
    return unsubscribe;
  }, [fetchBootstrap]);

  function handleTriggerPrint(
    submission: ExamSubmission,
    copies: number,
    pdfPageImages: string[] = []
  ) {
    setPrintState({ submission, copies, pdfPageImages });
    setTimeout(() => {
      window.print();
    }, 150);
  }

  function openAdminSection(tab: AdminTab) {
    setViewMode('admin');
    setAdminTab(tab);
  }

  return (
    <>
      <div className="no-print relative min-h-screen text-slate-100 overflow-x-hidden">
        <div className="fixed inset-0 -z-10 pointer-events-none">
          <img
            src="/src/assets/images/glass_ambient_backdrop_1794773699533.jpg"
            alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover opacity-55"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-slate-950/92 via-slate-950/78 to-slate-900/88" />
        </div>

        <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
          {/* 3-Zone Top Bar: [Brand Title] — [4 single-line nav links] — [1 primary action] */}
          <header className="glass-panel rounded-2xl px-6 py-3.5 flex items-center justify-between gap-8">
            <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0">
              Damaria Docs
            </span>

            <nav className="hidden md:flex items-center gap-7 text-sm font-medium">
              <button
                type="button"
                onClick={() => setViewMode('send')}
                className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'send'
                    ? 'text-white border-sky-400'
                    : 'text-slate-400 hover:text-white border-transparent'
                }`}
              >
                Send File
              </button>
              <button
                type="button"
                onClick={() => openAdminSection('documents')}
                className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'admin' && adminTab === 'documents'
                    ? 'text-white border-sky-400'
                    : 'text-slate-400 hover:text-white border-transparent'
                }`}
              >
                Print Queue
              </button>
              <button
                type="button"
                onClick={() => openAdminSection('printers')}
                className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'admin' && adminTab === 'printers'
                    ? 'text-white border-sky-400'
                    : 'text-slate-400 hover:text-white border-transparent'
                }`}
              >
                Machines
              </button>
              <button
                type="button"
                onClick={() => openAdminSection('logs')}
                className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'admin' && adminTab === 'logs'
                    ? 'text-white border-sky-400'
                    : 'text-slate-400 hover:text-white border-transparent'
                }`}
              >
                Activity Logs
              </button>
            </nav>

            <button
              type="button"
              onClick={() =>
                viewMode === 'send' ? openAdminSection('documents') : setViewMode('send')
              }
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              {viewMode === 'send' ? (
                <>
                  <Printer className="w-3.5 h-3.5" />
                  Print Desk
                </>
              ) : (
                <>
                  <FileUp className="w-3.5 h-3.5" />
                  Send Document
                </>
              )}
            </button>
          </header>

          {/* Compact Mobile Workspace Switcher */}
          <div className="md:hidden flex items-center gap-1 p-1 rounded-xl glass-panel-subtle overflow-x-auto">
            <button
              type="button"
              onClick={() => setViewMode('send')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 ${
                viewMode === 'send' ? 'bg-sky-500/25 text-sky-200' : 'text-slate-400'
              }`}
            >
              Send File
            </button>
            <button
              type="button"
              onClick={() => openAdminSection('documents')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 ${
                viewMode === 'admin' && adminTab === 'documents'
                  ? 'bg-sky-500/25 text-sky-200'
                  : 'text-slate-400'
              }`}
            >
              Print Queue
            </button>
            <button
              type="button"
              onClick={() => openAdminSection('printers')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 ${
                viewMode === 'admin' && adminTab === 'printers'
                  ? 'bg-sky-500/25 text-sky-200'
                  : 'text-slate-400'
              }`}
            >
              Machines
            </button>
            <button
              type="button"
              onClick={() => openAdminSection('logs')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 ${
                viewMode === 'admin' && adminTab === 'logs'
                  ? 'bg-sky-500/25 text-sky-200'
                  : 'text-slate-400'
              }`}
            >
              Activity Logs
            </button>
          </div>

          {loading ? (
            <div className="glass-panel rounded-2xl p-8 space-y-4">
              <div className="h-6 w-48 bg-white/10 rounded-lg" />
              <div className="h-64 bg-white/[0.05] rounded-xl" />
            </div>
          ) : error ? (
            <div className="glass-panel rounded-2xl p-8 text-center space-y-3">
              <p className="text-sm text-rose-300">{error}</p>
              <button
                onClick={fetchBootstrap}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950"
              >
                Retry
              </button>
            </div>
          ) : data ? (
            <AnimatePresence mode="wait">
              {viewMode === 'send' ? (
                <motion.div
                  key="send-view"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                >
                  <TeacherPortal
                    submissions={data.submissions}
                    publicDomain={data.publicDomain}
                    liveAppUrl={data.liveAppUrl}
                    onSubmitted={fetchBootstrap}
                    onRefresh={fetchBootstrap}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key={`admin-${adminTab}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                >
                  <AdminDashboard
                    activeTab={adminTab}
                    onChangeTab={setAdminTab}
                    data={data}
                    onRefresh={fetchBootstrap}
                    onTriggerPrint={handleTriggerPrint}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          ) : null}
        </div>
      </div>

      <PrintablePacket
        submission={printState?.submission ?? null}
        copies={printState?.copies ?? 1}
        pdfPageImages={printState?.pdfPageImages ?? []}
      />
    </>
  );
}
