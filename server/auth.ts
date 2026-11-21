import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { User, UserRole } from '../src/shared/types.js';

const EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');
let fallbackSecretProvider: (() => string) | null = null;

export function registerFallbackSecretProvider(provider: () => string) {
  fallbackSecretProvider = provider;
}

function getSigningSecret(): string {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) return envSecret;
  if (fallbackSecretProvider) {
    try {
      const persisted = fallbackSecretProvider();
      if (persisted && persisted.length >= 16) return persisted;
    } catch {
      // fall back to process secret
    }
  }
  return EPHEMERAL_SECRET;
}

export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (password.length > 128) {
    return 'Password must be 128 characters or fewer.';
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include at least one letter and one number.';
  }
  return null;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const expectedBuffer = Buffer.from(keyHex, 'hex');
  const derivedBuffer = crypto.scryptSync(password, salt, 64);
  if (expectedBuffer.length !== derivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, derivedBuffer);
}

export function hashResetToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export interface TokenPayload {
  sub: string;
  businessId: string;
  role: UserRole;
  exp: number;
}

export function signAuthToken(
  user: { id: string; businessId: string; role: UserRole },
  rememberMe = false
): string {
  const ttlMs = rememberMe ? 7 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  const payload: TokenPayload = {
    sub: user.id,
    businessId: user.businessId,
    role: user.role,
    exp: Date.now() + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyAuthToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenPayload;
    if (!parsed.sub || !parsed.businessId || !parsed.role || typeof parsed.exp !== 'number') return null;
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  authUser?: User;
}

export function parseCookieToken(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const pairs = raw.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    if (key === 'smartstock_session') {
      return decodeURIComponent(pair.slice(idx + 1).trim());
    }
  }
  return null;
}

export function extractRequestToken(req: Request): { token: string | null; viaCookie: boolean } {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return { token: authHeader.slice(7).trim(), viaCookie: false };
  }
  const cookieToken = parseCookieToken(req);
  if (cookieToken) {
    return { token: cookieToken, viaCookie: true };
  }
  return { token: null, viaCookie: false };
}

export function isValidMutationOrigin(req: Request): boolean {
  if (req.headers['x-requested-with'] === 'SmartStockAI') return true;
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host;
  if (!origin || !host) return true;
  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

export function createAuthMiddleware(getUserById: (id: string) => User | null) {
  return function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const { token, viaCookie } = extractRequestToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required. Please sign in.' });
      return;
    }
    if (viaCookie && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (!isValidMutationOrigin(req)) {
        res.status(403).json({ error: 'Invalid request origin.' });
        return;
      }
    }
    const payload = verifyAuthToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
      return;
    }
    const user = getUserById(payload.sub);
    if (!user || !user.active || user.businessId !== payload.businessId) {
      res.status(401).json({ error: 'Account is inactive or unavailable.' });
      return;
    }
    req.authUser = user;
    next();
  };
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'Admin permissions are required for this action.' });
    return;
  }
  next();
}

export function createRateLimiter(options: {
  maxRequests: number;
  windowMs: number;
  keyFn?: (req: AuthenticatedRequest) => string;
  message?: string;
}) {
  const hits = new Map<string, number[]>();
  return function rateLimitMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const key = options.keyFn
      ? options.keyFn(req)
      : req.authUser?.id || req.ip || 'anonymous';
    const now = Date.now();
    const cutoff = now - options.windowMs;
    const recent = (hits.get(key) || []).filter((ts) => ts > cutoff);
    if (recent.length >= options.maxRequests) {
      res.status(429).json({
        error: options.message || 'Too many requests. Please wait a few moments and try again.',
      });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

export function isHttpsRequest(req: Request): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https') {
    return true;
  }
  return Boolean(req.secure);
}

export function setSessionCookie(
  res: Response,
  token: string,
  rememberMe: boolean,
  isHttps = true
) {
  const maxAge = rememberMe ? 7 * 24 * 60 * 60 : 12 * 60 * 60;
  const securityFlags = isHttps ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax';
  res.setHeader(
    'Set-Cookie',
    `smartstock_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; ${securityFlags}`
  );
}

export function clearSessionCookie(res: Response, isHttps = true) {
  const securityFlags = isHttps ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax';
  res.setHeader(
    'Set-Cookie',
    `smartstock_session=; Path=/; Max-Age=0; HttpOnly; ${securityFlags}`
  );
}
