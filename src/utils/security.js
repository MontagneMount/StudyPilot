import crypto from 'node:crypto';
import { AppError } from './errors.js';

const TOKEN_SECRET = process.env.AUTH_SECRET || 'studypilot-dev-hmac-secret-key-2026';

/**
 * Hashes a plaintext password using Node's built-in crypto.scryptSync.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Verifies a plaintext password against a stored salt:hash string.
 */
export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

/**
 * Creates a stateless HMAC-SHA256 signed session token for { userId, email }.
 */
export function signAuthToken({ id, email }) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: id,
      email,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    })
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest('base64url');

  return `${payload}.${sig}`;
}

/**
 * Verifies an HMAC-SHA256 token and returns { id, email } or null.
 */
export function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [payload, sig] = token.split('.');
  const expectedSig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest('base64url');

  if (sig !== expectedSig) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.exp || decoded.exp < Date.now()) {
      return null;
    }
    return {
      id: decoded.sub,
      email: decoded.email,
    };
  } catch {
    return null;
  }
}

/**
 * Express middleware that attaches req.user if a valid Bearer token is present.
 */
export function attachUserIfPresent(req, _res, next) {
  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const user = verifyAuthToken(token);
    if (user) {
      req.user = user;
    }
  }
  next();
}

/**
 * Configurable sliding-window rate limiter middleware for M6 production readiness.
 */
export function createRateLimiter({
  windowMs = 60 * 1000,
  maxRequests = 120,
} = {}) {
  const hits = new Map();

  return function rateLimiterMiddleware(req, _res, next) {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'global';
    const entry = hits.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }

    entry.count += 1;
    hits.set(key, entry);

    if (entry.count > maxRequests) {
      return next(
        new AppError(
          'Too many requests. Please wait a moment and try again.',
          429,
          'RATE_LIMIT_EXCEEDED'
        )
      );
    }

    next();
  };
}
