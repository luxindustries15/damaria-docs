import type { AppNotification, ExamSubmission } from '../types';

const SENDER_NAME_KEY = 'damaria_last_sender_name';
const MY_SUBMISSION_IDS_KEY = 'damaria_my_submission_ids';
const MY_DOC_STATUSES_KEY = 'damaria_my_doc_statuses';
const READ_NOTIFICATION_IDS_KEY = 'damaria_read_notification_ids';

export function getSavedSenderName(): string {
  try {
    return localStorage.getItem(SENDER_NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function saveSenderName(name: string): void {
  const clean = name.trim();
  if (!clean) return;
  try {
    localStorage.setItem(SENDER_NAME_KEY, clean);
  } catch {
    // ignore storage errors
  }
}

export function getMySubmissionIds(): string[] {
  try {
    const raw = localStorage.getItem(MY_SUBMISSION_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberSentSubmission(submission: Pick<ExamSubmission, 'id' | 'senderName' | 'status'>): void {
  saveSenderName(submission.senderName);
  try {
    const existing = getMySubmissionIds().filter((id) => id !== submission.id);
    existing.unshift(submission.id);
    localStorage.setItem(MY_SUBMISSION_IDS_KEY, JSON.stringify(existing.slice(0, 100)));

    const statusMap = getSavedSubmissionStatuses();
    statusMap[submission.id] = submission.status;
    localStorage.setItem(MY_DOC_STATUSES_KEY, JSON.stringify(statusMap));
  } catch {
    // ignore storage errors
  }
}

export function getSavedSubmissionStatuses(): Record<string, string> {
  try {
    const raw = localStorage.getItem(MY_DOC_STATUSES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveSubmissionStatuses(map: Record<string, string>): void {
  try {
    localStorage.setItem(MY_DOC_STATUSES_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors
  }
}

export function getReadNotificationIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_NOTIFICATION_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveReadNotificationIds(ids: Set<string>): void {
  try {
    localStorage.setItem(READ_NOTIFICATION_IDS_KEY, JSON.stringify(Array.from(ids).slice(-250)));
  } catch {
    // ignore storage errors
  }
}

export function isSenderNotificationForCurrentUser(
  notification: AppNotification,
  activeSenderName?: string
): boolean {
  const myIds = getMySubmissionIds();
  if (notification.submissionId && myIds.includes(notification.submissionId)) {
    return true;
  }
  const candidate = (activeSenderName || getSavedSenderName()).trim().toLowerCase();
  if (candidate && notification.senderName && notification.senderName.trim().toLowerCase() === candidate) {
    return true;
  }
  return false;
}

export function supportsBrowserNotifications(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!supportsBrowserNotifications()) return 'unsupported';
  return Notification.permission;
}

export async function requestDesktopNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (!supportsBrowserNotifications()) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function showNativeDesktopNotification(
  title: string,
  body: string,
  tag?: string
): Promise<void> {
  if (!supportsBrowserNotifications() || Notification.permission !== 'granted') return;

  const options: NotificationOptions = {
    body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag,
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(title, options);
        return;
      }
    }
  } catch {
    // fall back to window.Notification
  }

  try {
    new Notification(title, options);
  } catch {
    // ignore restricted contexts
  }
}
