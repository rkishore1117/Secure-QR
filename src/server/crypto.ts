import crypto from 'node:crypto';

function readNonPlaceholderSecret(key: string, fallback: string): string {
  const val = (process.env[key] || '').trim();
  if (!val || /^(replace[-_]with|your[-_]|changeme$|example$|MY_)/i.test(val)) {
    return fallback;
  }
  return val;
}

function getJwtSecret(): string {
  return readNonPlaceholderSecret(
    'JWT_SECRET',
    'dev-secure-qr-verification-secret-change-in-production-256bit',
  );
}

function getOtpPepper(): string {
  return readNonPlaceholderSecret(
    'OTP_PEPPER',
    'dev-secure-qr-otp-pepper-change-in-production',
  );
}

export interface AccessTokenPayload {
  sub: number;
  email: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
  permissions: string[];
  type: 'access';
  iat: number;
  exp: number;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashOtp(mobile: string, otp: string): string {
  return crypto
    .createHmac('sha256', getOtpPepper())
    .update(`${mobile}:${otp}`, 'utf8')
    .digest('hex');
}

export function generateNumericOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function generateSecureQrToken(): string {
  // 32 random bytes = 256 bits of cryptographic entropy
  return crypto.randomBytes(32).toString('base64url');
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function signAccessToken(
  payload: Omit<AccessTokenPayload, 'type' | 'iat' | 'exp'>,
  expiresInSeconds = 3600,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({alg: 'HS256', typ: 'JWT'}));
  const bodyObj: AccessTokenPayload = {
    ...payload,
    type: 'access',
    iat: now,
    exp: now + expiresInSeconds,
  };
  const body = base64UrlEncode(JSON.stringify(bodyObj));
  const signature = crypto
    .createHmac('sha256', getJwtSecret())
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (!header || !body || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getJwtSecret())
    .update(`${header}.${body}`)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const decoded = JSON.parse(base64UrlDecode(body)) as AccessTokenPayload;
    if (decoded.type !== 'access') return null;
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}
