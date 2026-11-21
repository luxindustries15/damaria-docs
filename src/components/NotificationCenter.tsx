import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  Bell,
  BellRing,
  CheckCheck,
  CheckCircle2,
  Printer,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import type { AppNotification, NotificationType } from '../types';
import { formatTimeAgo } from '../utils/format';
import {
  getNotificationPermission,
  requestDesktopNotificationPermission,
} from '../utils/notifications';

function NotificationIcon({ type }: { type: NotificationType }) {
  switch (type) {
    case 'PRINT_COMPLETED':
      return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
    case 'PRINT_FAILED':
    case 'PRINTER_OFFLINE':
      return <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />;
    case 'DOCUMENT_SENT':
      return <Send className="w-4 h-4 text-sky-400 shrink-0" />;
    case 'DOCUMENT_DELETED':
    case 'LOGS_DELETED':
    case 'PRINTER_REMOVED':
      return <Trash2 className="w-4 h-4 text-amber-300 shrink-0" />;
    default:
      return <Printer className="w-4 h-4 text-sky-300 shrink-0" />;
  }
}

interface NotificationBellProps {
  notifications: AppNotification[];
  readIds: Set<string>;
  onMarkAllRead: () => void;
  onMarkRead: (id: string) => void;
}

export function NotificationBell({
  notifications,
  readIds,
  onMarkAllRead,
  onMarkRead,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() =>
    getNotificationPermission()
  );
  const containerRef = useRef<HTMLDivElement | null>(null);

  const unreadCount = notifications.filter((n) => !readIds.has(n.id)).length;

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleOutside);
      setPerm(getNotificationPermission());
    }
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  async function handleEnableAlerts() {
    const next = await requestDesktopNotificationPermission();
    setPerm(next);
  }

  return (
    <div ref={containerRef} className="relative no-print">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications (${unreadCount} unread)`}
        title="Notifications"
        className="relative p-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.14] border border-white/15 text-slate-200 transition-colors"
      >
        <Bell className="w-4 h-4 text-sky-300" />
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-sky-500 text-slate-950 text-[10px] font-bold font-mono flex items-center justify-center shadow">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl glass-panel border border-white/15 shadow-2xl overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-sky-400" />
              <h3 className="text-xs font-bold text-white">Action Notifications</h3>
            </div>

            <div className="flex items-center gap-2">
              {perm === 'default' && (
                <button
                  type="button"
                  onClick={handleEnableAlerts}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-sky-200 inline-flex items-center gap-1 transition-colors"
                >
                  <BellRing className="w-3 h-3" />
                  Desktop Alerts
                </button>
              )}
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={onMarkAllRead}
                  className="px-2 py-1 rounded-lg text-[11px] font-medium text-slate-300 hover:text-white hover:bg-white/10 inline-flex items-center gap-1 transition-colors"
                >
                  <CheckCheck className="w-3.5 h-3.5 text-emerald-400" />
                  Mark read
                </button>
              )}
            </div>
          </div>

          {perm === 'granted' && (
            <div className="px-4 py-1.5 bg-emerald-500/10 border-b border-emerald-400/20 text-[11px] text-emerald-200 flex items-center gap-1.5">
              <BellRing className="w-3 h-3 text-emerald-400 shrink-0" />
              <span>Desktop pop-up alerts are active</span>
            </div>
          )}

          <div className="max-h-80 overflow-y-auto divide-y divide-white/[0.08]">
            {notifications.length === 0 ? (
              <div className="py-10 px-4 text-center text-xs text-slate-400">
                No activity notifications yet. Notifications appear automatically when documents are
                sent, printed, or updated.
              </div>
            ) : (
              notifications.slice(0, 30).map((item) => {
                const isUnread = !readIds.has(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onMarkRead(item.id)}
                    className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ${
                      isUnread ? 'bg-sky-500/[0.08] hover:bg-sky-500/[0.12]' : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="mt-0.5">
                      <NotificationIcon type={item.type} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-white truncate">
                          {item.title}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap shrink-0">
                          {formatTimeAgo(item.timestamp)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 mt-0.5 leading-snug">{item.message}</p>
                    </div>
                    {isUnread && (
                      <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0 mt-1.5" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface NotificationToastStackProps {
  toasts: AppNotification[];
  onDismiss: (id: string) => void;
}

export function NotificationToastStack({ toasts, onDismiss }: NotificationToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="no-print fixed bottom-4 right-4 z-50 flex flex-col gap-2.5 w-[calc(100vw-2rem)] max-w-sm pointer-events-none"
      aria-live="polite"
    >
      <AnimatePresence>
        {toasts.slice(0, 3).map((toast) => {
          const borderClass =
            toast.type === 'PRINT_COMPLETED'
              ? 'border-emerald-400/45 bg-slate-950/92'
              : toast.type === 'PRINT_FAILED' || toast.type === 'PRINTER_OFFLINE'
                ? 'border-rose-400/45 bg-slate-950/92'
                : 'border-sky-400/35 bg-slate-950/92';
          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.18 }}
              className={`pointer-events-auto rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-md flex items-start gap-3 ${borderClass}`}
            >
              <div className="mt-0.5">
                <NotificationIcon type={toast.type} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-white">{toast.title}</p>
                <p className="text-xs text-slate-300 mt-0.5 leading-snug">{toast.message}</p>
              </div>
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                aria-label="Dismiss notification"
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
