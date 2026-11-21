import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Eye, EyeOff, FileUp, Lock, Printer, ShieldCheck } from 'lucide-react';
import { AdminDashboard, type AdminTab } from './components/AdminDashboard';
import {
  NotificationBell,
  NotificationToastStack,
} from './components/NotificationCenter';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PrintablePacket } from './components/PrintablePacket';
import { PWAInstallButton } from './components/PWAInstallButton';
import { TeacherPortal } from './components/TeacherPortal';
import backdropImg from './assets/images/glass_ambient_backdrop_1794773699533.jpg';
import schoolLogo from './assets/images/damaria_school_logo_rounded.png';
import type { AppNotification, BootstrapPayload, ExamSubmission } from './types';
import {
  getAdminSessionToken,
  isAdminLoggedIn,
  loadBootstrap,
  loginAdmin,
  logoutAdmin,
  sendUsbEvent,
  syncUsbDevices,
  type BackendMode,
} from './utils/apiClient';
import {
  getMySubmissionIds,
  getReadNotificationIds,
  getSavedSubmissionStatuses,
  isSenderNotificationForCurrentUser,
  saveReadNotificationIds,
  saveSubmissionStatuses,
  showNativeDesktopNotification,
} from './utils/notifications';
import {
  formatUsbDeviceName,
  getPairedUsbDevices,
  subscribeUsbHotplug,
} from './utils/usbDetector';

export default function App() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [backendMode, setBackendMode] = useState<BackendMode>('server');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState<'send' | 'admin'>('send');
  const [adminTab, setAdminTab] = useState<AdminTab>('documents');
  const [adminUnlocked, setAdminUnlocked] = useState<boolean>(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [logoFailed, setLogoFailed] = useState(false);
  const [printState, setPrintState] = useState<{
    submission: ExamSubmission;
    copies: number;
    pdfPageImages: string[];
  } | null>(null);

  const [liveNotifications, setLiveNotifications] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(() =>
    getReadNotificationIds()
  );

  const seenNotificationIdsRef = useRef<Set<string>>(new Set());
  const initialBootstrapLoadedRef = useRef(false);
  const adminUnlockedRef = useRef(adminUnlocked);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    adminUnlockedRef.current = adminUnlocked;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'auth', token: getAdminSessionToken() }));
    }
  }, [adminUnlocked]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const triggerIncomingNotification = useCallback((item: AppNotification) => {
    if (seenNotificationIdsRef.current.has(item.id)) return;
    seenNotificationIdsRef.current.add(item.id);

    setLiveNotifications((prev) => {
      if (prev.some((existing) => existing.id === item.id)) return prev;
      return [item, ...prev].slice(0, 120);
    });

    const isMine = isSenderNotificationForCurrentUser(item);
    const shouldShowToast =
      adminUnlockedRef.current ||
      item.type === 'DOCUMENT_SENT' ||
      item.type === 'PRINT_COMPLETED' ||
      item.type === 'PRINT_FAILED' ||
      item.type === 'DOCUMENT_DELETED';

    if (shouldShowToast) {
      setToasts((prev) => {
        if (prev.some((t) => t.id === item.id)) return prev;
        return [item, ...prev].slice(0, 4);
      });
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== item.id));
      }, item.type === 'PRINT_COMPLETED' && isMine ? 9000 : 6000);
    }

    // Fire native OS Desktop Notification for important cross-user actions
    if (item.type === 'PRINT_COMPLETED' && isMine) {
      showNativeDesktopNotification('Your Document is Ready', item.message, `done-${item.id}`);
    } else if (item.type === 'PRINT_FAILED' && (isMine || adminUnlockedRef.current)) {
      showNativeDesktopNotification(item.title, item.message, `fail-${item.id}`);
    } else if (item.type === 'DOCUMENT_SENT' && adminUnlockedRef.current) {
      showNativeDesktopNotification(item.title, item.message, `sent-${item.id}`);
    }
  }, []);

  const fetchBootstrap = useCallback(async () => {
    try {
      const { payload, mode } = await loadBootstrap();
      const adminNow = isAdminLoggedIn();
      setData(payload);
      setBackendMode(mode);
      setAdminUnlocked(adminNow);
      adminUnlockedRef.current = adminNow;
      setError('');

      const serverNotifications = payload.notifications || [];
      const myIds = new Set(getMySubmissionIds());
      const prevStatusMap = getSavedSubmissionStatuses();
      const nextStatusMap: Record<string, string> = { ...prevStatusMap };

      if (!initialBootstrapLoadedRef.current) {
        initialBootstrapLoadedRef.current = true;
        for (const n of serverNotifications) {
          seenNotificationIdsRef.current.add(n.id);
        }
        setLiveNotifications(serverNotifications);

        // If any of this sender's documents finished printing while their tab was closed, notify immediately
        for (const sub of payload.submissions) {
          if (!myIds.has(sub.id)) continue;
          const prevStatus = prevStatusMap[sub.id];
          if (prevStatus && prevStatus !== 'printed' && sub.status === 'printed') {
            const synthetic: AppNotification = {
              id: `done_sync_${sub.id}_${sub.completedAt || sub.printedCopies}`,
              timestamp: sub.completedAt || new Date().toISOString(),
              type: 'PRINT_COMPLETED',
              audience: 'sender',
              title: 'Printing Completed',
              message: `"${sub.title}" is done (${sub.printedCopies} copies, ${sub.sheetsConsumed} sheets).`,
              submissionId: sub.id,
              senderName: sub.senderName,
              printerName: sub.assignedPrinterName || undefined,
            };
            triggerIncomingNotification(synthetic);
          }
          nextStatusMap[sub.id] = sub.status;
        }
        saveSubmissionStatuses(nextStatusMap);
      } else {
        setLiveNotifications((prev) => {
          const byId = new Map<string, AppNotification>();
          for (const item of serverNotifications) byId.set(item.id, item);
          for (const item of prev) {
            if (!byId.has(item.id) && (adminNow || item.audience !== 'admin')) {
              byId.set(item.id, item);
            }
          }
          return Array.from(byId.values())
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, 120);
        });

        for (const n of [...serverNotifications].reverse()) {
          if (!seenNotificationIdsRef.current.has(n.id)) {
            triggerIncomingNotification(n);
          }
        }

        for (const sub of payload.submissions) {
          if (myIds.has(sub.id)) {
            nextStatusMap[sub.id] = sub.status;
          }
        }
        saveSubmissionStatuses(nextStatusMap);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [triggerIncomingNotification]);

  useEffect(() => {
    fetchBootstrap();
  }, [fetchBootstrap]);

  useEffect(() => {
    const timer = setInterval(fetchBootstrap, 5000);
    return () => clearInterval(timer);
  }, [fetchBootstrap]);

  // Real-time WebSocket stream for instant action notifications (Express server mode)
  useEffect(() => {
    if (backendMode !== 'server' || typeof window === 'undefined') return;
    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!active) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = getAdminSessionToken();
      const wsUrl = `${proto}//${window.location.host}/ws/events${
        token ? `?token=${encodeURIComponent(token)}` : ''
      }`;
      try {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data) as {
              type?: string;
              notification?: AppNotification;
              syncRequired?: boolean;
            };
            if (msg.type === 'notification' && msg.notification) {
              triggerIncomingNotification(msg.notification);
            }
            if (msg.syncRequired) {
              fetchBootstrap();
            }
          } catch {
            // ignore malformed ws message
          }
        };

        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          if (active) {
            reconnectTimer = setTimeout(connect, 3500);
          }
        };
      } catch {
        // fallback polling handles updates
      }
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [backendMode, fetchBootstrap, triggerIncomingNotification]);

  const visibleNotifications = useMemo(() => {
    return liveNotifications.filter((n) => adminUnlocked || n.audience !== 'admin');
  }, [liveNotifications, adminUnlocked]);

  const handleMarkNotificationRead = useCallback((id: string) => {
    setReadNotificationIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveReadNotificationIds(next);
      return next;
    });
  }, []);

  const handleMarkAllNotificationsRead = useCallback(() => {
    setReadNotificationIds((prev) => {
      const next = new Set(prev);
      for (const n of visibleNotifications) {
        next.add(n.id);
      }
      saveReadNotificationIds(next);
      return next;
    });
  }, [visibleNotifications]);

  // Sync paired USB devices only after Admin Portal is unlocked
  useEffect(() => {
    if (!adminUnlocked) return;

    getPairedUsbDevices().then(async (devices) => {
      if (devices.length === 0) return;
      await syncUsbDevices(
        devices.map((d) => ({
          vendorId: d.vendorId,
          productId: d.productId,
          name: formatUsbDeviceName(d),
        }))
      );
      fetchBootstrap();
    });

    const unsubscribe = subscribeUsbHotplug(
      async (device) => {
        await sendUsbEvent({
          event: 'connect',
          vendorId: device.vendorId,
          productId: device.productId,
          productName: device.productName,
          manufacturer: device.manufacturerName,
        });
        fetchBootstrap();
      },
      async (device) => {
        await sendUsbEvent({
          event: 'disconnect',
          vendorId: device.vendorId,
          productId: device.productId,
          productName: device.productName,
          manufacturer: device.manufacturerName,
        });
        fetchBootstrap();
      }
    );
    return unsubscribe;
  }, [adminUnlocked, fetchBootstrap]);

  async function handleAdminLogin(e: FormEvent) {
    e.preventDefault();
    if (!adminPassword.trim()) {
      setAuthError('Please enter the admin password.');
      return;
    }
    setAuthBusy(true);
    setAuthError('');
    try {
      await loginAdmin(adminPassword);
      setAdminUnlocked(true);
      setAdminPassword('');
      setShowPassword(false);
      await fetchBootstrap();
    } catch (err) {
      setAuthError((err as Error).message || 'Incorrect admin password.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLockAdmin() {
    await logoutAdmin();
    setAdminUnlocked(false);
    setAdminPassword('');
    setAuthError('');
    setViewMode('send');
    await fetchBootstrap();
  }

  async function handleTriggerPrint(
    submission: ExamSubmission,
    copies: number,
    pdfPageImages: string[] = []
  ) {
    setPrintState({ submission, copies, pdfPageImages });

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );

    const printRoot = document.querySelector('.print-only');
    if (printRoot) {
      const imgs = Array.from(printRoot.querySelectorAll('img'));
      await Promise.race([
        Promise.all(
          imgs.map(async (img) => {
            if (!img.complete) {
              await new Promise<void>((res) => {
                img.addEventListener('load', () => res(), { once: true });
                img.addEventListener('error', () => res(), { once: true });
              });
            }
            if (typeof img.decode === 'function') {
              await img.decode().catch(() => undefined);
            }
          })
        ),
        new Promise<void>((res) => setTimeout(res, 2500)),
      ]);
    }

    const prevTitle = document.title;
    document.title = ' ';
    let afterPrintFired = false;
    let resolveAfterPrint: (() => void) | null = null;
    const afterPrintPromise = new Promise<void>((resolve) => {
      resolveAfterPrint = resolve;
    });
    const onAfterPrint = () => {
      afterPrintFired = true;
      resolveAfterPrint?.();
    };
    window.addEventListener('afterprint', onAfterPrint, { once: true });

    try {
      window.print();
      if (!afterPrintFired) {
        await Promise.race([
          afterPrintPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
      }
    } finally {
      window.removeEventListener('afterprint', onAfterPrint);
      document.title = prevTitle;
    }
  }

  function openAdminSection(tab: AdminTab) {
    setAuthError('');
    setViewMode('admin');
    setAdminTab(tab);
  }

  return (
    <>
      <div className="no-print relative min-h-screen text-slate-100 overflow-x-hidden">
        <div className="fixed inset-0 -z-10 pointer-events-none">
          <img
            src={backdropImg}
            alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover opacity-55"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-slate-950/92 via-slate-950/78 to-slate-900/88" />
        </div>

        <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
          {/* 3-Zone Top Bar: [Brand Title] — [4 single-line nav links] — [1 primary action] */}
          <header className="glass-panel rounded-2xl px-6 py-3.5 flex items-center justify-between gap-8">
            <div className="flex items-center gap-2.5 shrink-0">
              {logoFailed ? (
                <div className="w-9 h-9 rounded-xl bg-[#060a13] border border-white/15 flex items-center justify-center text-sky-400 shrink-0">
                  <Printer className="w-4 h-4" />
                </div>
              ) : (
                <img
                  src={schoolLogo}
                  alt="Damaria Pre & Primary School logo"
                  referrerPolicy="no-referrer"
                  onError={() => setLogoFailed(true)}
                  className="w-9 h-9 rounded-xl object-contain shrink-0"
                />
              )}
              <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0">
                Damaria Docs
              </span>
            </div>

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

            <div className="flex items-center gap-2.5 shrink-0">
              <NotificationBell
                notifications={visibleNotifications}
                readIds={readNotificationIds}
                onMarkRead={handleMarkNotificationRead}
                onMarkAllRead={handleMarkAllNotificationsRead}
              />
              <PWAInstallButton />
              <button
                type="button"
                onClick={() =>
                  viewMode === 'send' ? openAdminSection('documents') : setViewMode('send')
                }
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {viewMode === 'send' ? (
                  <>
                    {adminUnlocked ? (
                      <ShieldCheck className="w-3.5 h-3.5" />
                    ) : (
                      <Lock className="w-3.5 h-3.5" />
                    )}
                    Admin Portal
                  </>
                ) : (
                  <>
                    <FileUp className="w-3.5 h-3.5" />
                    Send Document
                  </>
                )}
              </button>
            </div>
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
                    notifications={visibleNotifications}
                    publicDomain={data.publicDomain}
                    liveAppUrl={data.liveAppUrl}
                    backendMode={backendMode}
                    onSubmitted={() => fetchBootstrap()}
                    onRefresh={fetchBootstrap}
                  />
                </motion.div>
              ) : !adminUnlocked ? (
                <motion.div
                  key="admin-lock"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  className="max-w-md mx-auto py-8 sm:py-12"
                >
                  <form
                    onSubmit={handleAdminLogin}
                    className="glass-panel rounded-2xl p-6 sm:p-8 space-y-5"
                  >
                    <div className="flex flex-col items-center text-center space-y-3">
                      {logoFailed ? (
                        <div className="w-14 h-14 rounded-2xl bg-[#060a13] border border-white/15 flex items-center justify-center text-sky-400">
                          <Lock className="w-6 h-6" />
                        </div>
                      ) : (
                        <img
                          src={schoolLogo}
                          alt="Damaria Pre & Primary School"
                          referrerPolicy="no-referrer"
                          className="w-16 h-16 rounded-2xl object-contain"
                        />
                      )}
                      <div>
                        <h1 className="text-xl font-bold text-white">Admin Portal</h1>
                        <p className="text-xs text-slate-300 mt-1">
                          Enter the admin password to print, delete documents, or manage machines.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label
                        htmlFor="admin-password-input"
                        className="block text-xs font-medium text-slate-300"
                      >
                        Admin Password
                      </label>
                      <div className="relative">
                        <input
                          id="admin-password-input"
                          type={showPassword ? 'text' : 'password'}
                          autoFocus
                          autoComplete="current-password"
                          required
                          value={adminPassword}
                          onChange={(e) => {
                            setAdminPassword(e.target.value);
                            if (authError) setAuthError('');
                          }}
                          placeholder="Enter admin password"
                          className="glass-input w-full rounded-xl pl-4 pr-10 py-2.5 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors"
                        >
                          {showPassword ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    {authError && (
                      <div className="rounded-xl px-3.5 py-2.5 text-xs font-medium bg-rose-500/12 border border-rose-400/35 text-rose-200">
                        {authError}
                      </div>
                    )}

                    <div className="space-y-2.5 pt-1">
                      <button
                        type="submit"
                        disabled={authBusy}
                        className="w-full px-5 py-2.5 rounded-xl text-sm font-semibold bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 transition-colors inline-flex items-center justify-center gap-2"
                      >
                        <Lock className="w-4 h-4" />
                        {authBusy ? 'Verifying...' : 'Unlock Admin Portal'}
                      </button>

                      <button
                        type="button"
                        onClick={() => setViewMode('send')}
                        className="w-full px-4 py-2 rounded-xl text-xs font-medium bg-white/[0.05] hover:bg-white/[0.1] text-slate-300 hover:text-white transition-colors"
                      >
                        Back to Send File
                      </button>
                    </div>
                  </form>
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
                    backendMode={backendMode}
                    onRefresh={fetchBootstrap}
                    onLockAdmin={handleLockAdmin}
                    onTriggerPrint={handleTriggerPrint}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          ) : null}
        </div>
      </div>

      <NotificationToastStack toasts={toasts} onDismiss={dismissToast} />
      <OfflineIndicator />

      <PrintablePacket
        submission={printState?.submission ?? null}
        copies={printState?.copies ?? 1}
        pdfPageImages={printState?.pdfPageImages ?? []}
      />
    </>
  );
}
