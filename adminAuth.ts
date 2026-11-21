import crypto from 'node:crypto';
import type { BootstrapPayload } from './src/types';

// Precomputed scrypt parameters for the default admin credential (never stored in plaintext)
const DEFAULT_ADMIN_SALT = 'a2fe00580ab3bb8d693967f06261b4c9';
const DEFAULT_ADMIN_HASH_BUF = Buffer.from(
  'c3bc12b3f77675e96990222018c52b056d15bed3574c8003c365ebb08f22e2b1',
  'hex'
);

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function verifyAdminPassword(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;

  const envPassword = process.env.ADMIN_PASSWORD;
  if (envPassword && envPassword.length > 0) {
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(envPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }

  try {
    const derived = crypto.scryptSync(candidate, DEFAULT_ADMIN_SALT, 32);
    return (
      derived.length === DEFAULT_ADMIN_HASH_BUF.length &&
      crypto.timingSafeEqual(derived, DEFAULT_ADMIN_HASH_BUF)
    );
  } catch {
    return false;
  }
}

export function createAdminToken(secret: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = {
    role: 'admin' as const,
    exp: expiresAt,
    jti: crypto.randomBytes(12).toString('hex'),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return { token: `${payloadB64}.${sig}`, expiresAt };
}

export function verifyAdminToken(token: string | null | undefined, secret: string): boolean {
  if (!token || typeof token !== 'string' || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

  const [payloadB64, providedSig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

  const bufA = Buffer.from(providedSig, 'utf-8');
  const bufB = Buffer.from(expectedSig, 'utf-8');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as {
      role?: string;
      exp?: number;
    };
    return parsed.role === 'admin' && typeof parsed.exp === 'number' && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

export function extractBearerToken(authHeader?: string | null): string | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

export function sanitizeBootstrapForPublic(payload: BootstrapPayload): BootstrapPayload {
  return {
    schemaVersion: payload.schemaVersion,
    schoolName: payload.schoolName,
    publicDomain: payload.publicDomain,
    liveAppUrl: payload.liveAppUrl,
    printers: [],
    logs: [],
    submissions: payload.submissions.map((sub) => ({
      ...sub,
      fileUrl: null,
      renderedHtml: '',
      notes: '',
    })),
  };
}
