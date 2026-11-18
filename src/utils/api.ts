const RAW_API_BASE = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export function apiUrl(path: string): string {
  if (!path) return path;
  if (/^(https?:|blob:|data:)/i.test(path)) return path;
  if (!RAW_API_BASE) return path;
  return path.startsWith('/') ? `${RAW_API_BASE}${path}` : `${RAW_API_BASE}/${path}`;
}
