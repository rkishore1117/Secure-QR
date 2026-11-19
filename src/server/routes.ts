import express, {type Request, type Response, type NextFunction} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  connectLiveMysqlRuntime,
  ensureFixedAdmin,
  ensureSeeded,
  executeSql,
  getEnvValue,
  getMysqlConfig,
  getUploadsDir,
  isMockDbActive,
  parseJsonSafe,
  queryOne,
  queryRows,
  toMysqlDateTime,
  withTransaction,
} from './db';
import {buildVerifiedUsersWorkbook} from './excel';
import {
  checkEmailProviderHealth,
  EMAIL_SETTINGS_KEYS,
  getEffectiveEmailDeliveryConfig,
  getEmailSettingsMaskedSummary,
  sendDailyVerificationExcelReport,
  sendTestEmail,
  sendVerificationOtpEmail,
} from './mailer';
import {checkMysqlConnection, ensureMysqlDatabaseAndSchema} from './mysql-connector';
import {uploadBase64Media} from './s3-storage';
import {
  generateNumericOtp,
  generateRefreshToken,
  generateSecureQrToken,
  hashOtp,
  hashPassword,
  sha256Hex,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
  type AccessTokenPayload,
} from './crypto';
import {notificationHub} from './ws';

interface AuthenticatedRequest extends Request {
  auth?: AccessTokenPayload;
}

const rateBuckets = new Map<string, {count: number; resetAt: number}>();

function rateLimit(keyPrefix: string, maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, {count: 1, resetAt: now + windowMs});
      next();
      return;
    }
    if (bucket.count >= maxRequests) {
      res.status(429).json({
        error: 'Too many requests. Please wait before trying again.',
        retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
      });
      return;
    }
    bucket.count += 1;
    next();
  };
}

function getBaseUrl(req: Request): string {
  const configuredAppUrl = getEnvValue('APP_URL');
  if (configuredAppUrl) {
    return configuredAppUrl;
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

function toMysqlDate(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await queryOne<{value: string}>(
    'SELECT `value` AS `value` FROM system_settings WHERE `key` = ?',
    [key],
  );
  return row ? row.value : fallback;
}

async function writeAuditLog(
  actor: {id?: number | null; email: string; role: string},
  action: string,
  targetType: string,
  targetId: string | number | null,
  details: Record<string, unknown>,
  ip?: string,
): Promise<void> {
  await executeSql(
    `INSERT INTO admin_activity_logs
      (actor_user_id, actor_email, actor_role, action, target_type, target_id, details_json, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actor.id ?? null,
      actor.email,
      actor.role,
      action,
      targetType,
      targetId !== null ? String(targetId) : null,
      JSON.stringify(details),
      ip ?? null,
      toMysqlDateTime(),
    ],
  );
}

async function createNotification(params: {
  recipientUserId?: number | null;
  recipientRole?: 'ADMIN' | 'SUPER_ADMIN' | null;
  type: string;
  title: string;
  message: string;
  linkPath?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const nowObj = new Date();
  const nowMysql = toMysqlDateTime(nowObj);
  const nowIso = nowObj.toISOString();
  const res = await executeSql(
    `INSERT INTO notifications
      (recipient_user_id, recipient_role, type, title, message, link_path, metadata_json, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      params.recipientUserId ?? null,
      params.recipientRole ?? null,
      params.type,
      params.title,
      params.message,
      params.linkPath ?? null,
      JSON.stringify(params.metadata ?? {}),
      nowMysql,
    ],
  );

  const payload = {
    event: 'notification',
    notification: {
      id: Number(res.insertId),
      type: params.type,
      title: params.title,
      message: params.message,
      linkPath: params.linkPath ?? null,
      metadata: params.metadata ?? {},
      isRead: false,
      createdAt: nowIso,
    },
  };

  if (params.recipientUserId) {
    notificationHub.pushToUser(params.recipientUserId, payload);
  }
  if (params.recipientRole === 'ADMIN' || params.recipientRole === 'SUPER_ADMIN') {
    notificationHub.pushToAdmins(payload);
  }
}

async function saveBase64Upload(
  dataUrl: string,
  allowedMimes: string[],
  prefix: string,
): Promise<string> {
  const folder = prefix === 'photo' ? 'photos' : 'id_proofs';
  const result = await uploadBase64Media(dataUrl, allowedMimes, folder, prefix);
  return result.url;
}

async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({error: 'Authentication required.'});
      return;
    }
    const token = header.slice(7).trim();
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      res.status(401).json({error: 'Invalid or expired access token.'});
      return;
    }

    const user = await queryOne<{
      id: number;
      email: string;
      role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
      is_active: number;
      deleted_at: Date | string | null;
    }>('SELECT id, email, role, is_active, deleted_at FROM user_accounts WHERE id = ?', [
      decoded.sub,
    ]);

    if (!user || !user.is_active || user.deleted_at) {
      res.status(403).json({error: 'Account is inactive or archived.'});
      return;
    }

    let permissions: string[] = [];
    if (user.role === 'SUPER_ADMIN') {
      permissions = [
        'can_view_registrations',
        'can_approve_registrations',
        'can_manage_qr',
        'can_scan_qr',
        'can_export_excel',
        'can_manage_users',
      ];
    } else if (user.role === 'ADMIN') {
      const adminProfile = await queryOne<{permissions_json: unknown}>(
        'SELECT permissions_json FROM admin_profiles WHERE user_id = ?',
        [user.id],
      );
      permissions = adminProfile ? parseJsonSafe<string[]>(adminProfile.permissions_json, []) : [];
    }

    req.auth = {
      ...decoded,
      role: user.role,
      permissions,
    };
    next();
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Database authentication check failed.',
    });
  }
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.auth || (req.auth.role !== 'ADMIN' && req.auth.role !== 'SUPER_ADMIN')) {
    res.status(403).json({error: 'Admin access required.'});
    return;
  }
  next();
}

function requireSuperAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.role !== 'SUPER_ADMIN') {
    res.status(403).json({error: 'Super Admin authority required.'});
    return;
  }
  next();
}

function requirePermission(permission: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({error: 'Authentication required.'});
      return;
    }
    if (req.auth.role === 'SUPER_ADMIN') {
      next();
      return;
    }
    if (req.auth.role !== 'ADMIN' || !req.auth.permissions.includes(permission)) {
      res.status(403).json({error: `Missing required permission: ${permission}`});
      return;
    }
    next();
  };
}

function extractTokenFromInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (trimmed.includes('token=')) {
    try {
      const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://dummy.local/${trimmed}`);
      return parsed.searchParams.get('token') || trimmed;
    } catch {
      const match = /token=([^&\s]+)/.exec(trimmed);
      return match ? decodeURIComponent(match[1]) : trimmed;
    }
  }
  return trimmed;
}

async function generateAndSaveQr(
  userRecordId: number,
  issuedByAdminId: number,
  baseUrl: string,
): Promise<{
  id: number;
  tokenPrefix: string;
  verificationUrl: string;
  qrPngDataUrl: string;
  status: string;
  issuedAt: string;
  expiresAt: string;
}> {
  const validityDays = Number.parseInt(await getSetting('qr_validity_days', '365'), 10) || 365;
  const allowMultiple = (await getSetting('allow_multiple_active_qr', 'false')) === 'true';

  const rawToken = generateSecureQrToken();
  const tokenHash = sha256Hex(rawToken);
  const tokenPrefix = tokenHash.slice(0, 12);
  const verificationUrl = `${baseUrl.replace(/\/$/, '')}/verify?token=${encodeURIComponent(rawToken)}`;
  const qrPngDataUrl = await QRCode.toDataURL(verificationUrl, {
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 480,
    color: {dark: '#0F172A', light: '#FFFFFF'},
  });

  const now = new Date();
  const issuedAtIso = now.toISOString();
  const expiresDate = new Date(now.getTime() + validityDays * 86400000);
  const expiresAtIso = expiresDate.toISOString();
  const issuedAtMysql = toMysqlDateTime(now);
  const expiresAtMysql = toMysqlDateTime(expiresDate);

  const qrId = await withTransaction(async (tx) => {
    if (!allowMultiple) {
      await tx.executeSql(
        `UPDATE qr_codes
         SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, revoke_reason = 'Superseded by newly issued QR credential'
         WHERE user_record_id = ? AND status = 'ACTIVE'`,
        [issuedAtMysql, issuedByAdminId, userRecordId],
      );
    }

    const res = await tx.executeSql(
      `INSERT INTO qr_codes
        (user_record_id, token_hash, token_prefix, verification_url, qr_png_data_url, status, issued_at, expires_at, issued_by)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [
        userRecordId,
        tokenHash,
        tokenPrefix,
        verificationUrl,
        qrPngDataUrl,
        issuedAtMysql,
        expiresAtMysql,
        issuedByAdminId,
      ],
    );

    return Number(res.insertId);
  });

  return {
    id: qrId,
    tokenPrefix,
    verificationUrl,
    qrPngDataUrl,
    status: 'ACTIVE',
    issuedAt: issuedAtIso,
    expiresAt: expiresAtIso,
  };
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // Serve uploaded fallback files safely (prevent path traversal)
  router.get('/uploads/:filename', (req: Request, res: Response) => {
    const filename = path.basename(String(req.params['filename'] || ''));
    const fullPath = path.join(getUploadsDir(), filename);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({error: 'File not found'});
      return;
    }
    res.sendFile(fullPath);
  });

  // Ensure MySQL RDS schema & seed data are ready before serving API routes
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      await ensureSeeded(getBaseUrl(req));
      next();
    } catch (err) {
      res.status(503).json({
        error: err instanceof Error ? err.message : 'Database connection unavailable.',
      });
    }
  });

  // Public runtime health check (non-PII, no secrets)
  router.get('/public/health', async (_req: Request, res: Response) => {
    const cfg = getMysqlConfig();
    const emailCfg = await getEffectiveEmailDeliveryConfig();
    res.json({
      databaseConnected: !isMockDbActive(),
      databaseEngine: isMockDbActive() ? 'in-memory-fallback' : 'mysql-rds',
      databaseName: cfg.database,
      emailConfigured: emailCfg.configured,
      emailProvider: emailCfg.mode,
    });
  });

  // Public field configuration & settings
  router.get('/public/field-configs', async (_req: Request, res: Response) => {
    const rows = await queryRows<{
      id: number;
      field_key: string;
      label: string;
      field_type: string;
      is_required: number;
      is_enabled: number;
      is_editable_on_resubmit: number;
      options_json: unknown;
      sort_order: number;
    }>('SELECT * FROM user_field_configs WHERE is_enabled = 1 ORDER BY sort_order ASC, id ASC');

    res.json({
      organizationName: await getSetting('organization_name', 'Secure QR Verification Authority'),
      idProofRequired: (await getSetting('id_proof_required', 'true')) === 'true',
      fields: rows.map((r) => ({
        id: r.id,
        fieldKey: r.field_key,
        label: r.label,
        fieldType: r.field_type,
        isRequired: Boolean(r.is_required),
        isEditableOnResubmit: Boolean(r.is_editable_on_resubmit),
        options: parseJsonSafe<string[]>(r.options_json, []),
        sortOrder: r.sort_order,
      })),
    });
  });

  // Public non-PII verification status check (never exposes user PII!)
  router.get('/public/verify-info', async (req: Request, res: Response) => {
    const tokenParam = String(req.query['token'] || '');
    if (!tokenParam) {
      res.status(400).json({status: 'INVALID', message: 'Verification token is missing.'});
      return;
    }
    const rawToken = extractTokenFromInput(tokenParam);
    const tokenHash = sha256Hex(rawToken);
    const qr = await queryOne<{
      status: string;
      expires_at: Date | string;
      issued_at: Date | string;
      approval_status: string;
      is_active: number;
      deleted_at: Date | string | null;
    }>(
      `SELECT q.status, q.expires_at, q.issued_at, ur.approval_status, ua.is_active, ua.deleted_at
       FROM qr_codes q
       JOIN user_records ur ON ur.id = q.user_record_id
       JOIN user_accounts ua ON ua.id = ur.user_id
       WHERE q.token_hash = ?`,
      [tokenHash],
    );

    if (!qr) {
      res.json({
        status: 'INVALID',
        message: 'This QR credential does not exist or has been tampered with.',
      });
      return;
    }
    if (qr.status === 'REVOKED') {
      res.json({
        status: 'REVOKED',
        message: 'This QR credential has been revoked by an administrator.',
      });
      return;
    }
    if (qr.status === 'EXPIRED' || new Date(qr.expires_at).getTime() <= Date.now()) {
      res.json({
        status: 'EXPIRED',
        message: 'This QR credential has expired.',
        expiresAt: qr.expires_at,
      });
      return;
    }
    if (!qr.is_active || qr.deleted_at || qr.approval_status !== 'APPROVED') {
      res.json({
        status: 'INACTIVE_USER',
        message: 'Credential holder account is currently inactive or unapproved.',
      });
      return;
    }

    res.json({
      status: 'VALID',
      message:
        'This pass is active and valid. Team administrators can sign in to view the member photo and finish check-in.',
      issuedAt: qr.issued_at,
      expiresAt: qr.expires_at,
    });
  });

  // Duplicate Email / Mobile check
  router.post('/auth/check-availability', async (req: Request, res: Response) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const mobile = String(req.body?.mobile || '').trim();

    const emailTaken = email
      ? Boolean(await queryOne('SELECT id FROM user_accounts WHERE LOWER(email) = ?', [email]))
      : false;
    const mobileTaken = mobile
      ? Boolean(await queryOne('SELECT id FROM user_accounts WHERE mobile = ?', [mobile]))
      : false;

    res.json({emailAvailable: !emailTaken, mobileAvailable: !mobileTaken});
  });

  // Send Email OTP (stored ONLY as HMAC-SHA256 hash)
  router.post(
    '/auth/otp/send',
    rateLimit('otp_send', 8, 15 * 60 * 1000),
    async (req: Request, res: Response) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const rawPurpose = String(req.body?.purpose || 'REGISTRATION').trim().toUpperCase();
      const purpose: 'REGISTRATION' | 'PASSWORD_RESET' =
        rawPurpose === 'PASSWORD_RESET' ? 'PASSWORD_RESET' : 'REGISTRATION';

      if (!/^\S+@\S+\.\S+$/.test(email)) {
        res.status(400).json({error: 'Enter a valid email address.'});
        return;
      }

      if (purpose === 'REGISTRATION') {
        const existingEmail = await queryOne(
          'SELECT id FROM user_accounts WHERE LOWER(email) = ?',
          [email],
        );
        if (existingEmail) {
          res.status(409).json({error: 'This email address is already registered.'});
          return;
        }
      } else {
        const account = await queryOne<{id: number; is_active: number}>(
          'SELECT id, is_active FROM user_accounts WHERE LOWER(email) = ? AND deleted_at IS NULL',
          [email],
        );
        if (!account) {
          res.status(404).json({error: 'No registered account found with this email address.'});
          return;
        }
        if (!account.is_active) {
          res.status(403).json({
            error: 'This account is currently deactivated. Please contact your Super Admin.',
          });
          return;
        }
      }

      // Enforce 30-second resend cooldown & max 5 OTPs per 30 mins per email & purpose
      const cutoffMysql = toMysqlDateTime(Date.now() - 30 * 60 * 1000);
      const recentOtps = await queryRows<{id: number; created_at: Date | string}>(
        `SELECT id, created_at FROM otp_verifications
         WHERE LOWER(email) = ? AND purpose = ? AND created_at >= ?
         ORDER BY id DESC`,
        [email, purpose, cutoffMysql],
      );

      if (recentOtps.length >= 5) {
        res.status(429).json({
          error: 'OTP resend limit reached for this email address. Try again in 30 minutes.',
        });
        return;
      }
      if (recentOtps.length > 0) {
        const lastAgeMs = Date.now() - new Date(recentOtps[0].created_at).getTime();
        if (lastAgeMs < 30_000) {
          res.status(429).json({
            error: `Please wait ${Math.ceil((30_000 - lastAgeMs) / 1000)}s before requesting another OTP.`,
          });
          return;
        }
      }

      const expiryMinutes = Number.parseInt(await getSetting('otp_expiry_minutes', '5'), 10) || 5;
      const maxAttempts = Number.parseInt(await getSetting('max_otp_attempts', '5'), 10) || 5;
      const otp = generateNumericOtp();
      const otpHash = hashOtp(email, otp);
      const now = new Date();
      const expiresAtMysql = toMysqlDateTime(now.getTime() + expiryMinutes * 60 * 1000);

      const insertRes = await executeSql(
        `INSERT INTO otp_verifications
          (email, mobile, purpose, otp_hash, expires_at, attempts, max_attempts, ip_address, created_at)
         VALUES (?, '', ?, ?, ?, 0, ?, ?, ?)`,
        [email, purpose, otpHash, expiresAtMysql, maxAttempts, req.ip || null, toMysqlDateTime(now)],
      );

      const isResend = recentOtps.length > 0;
      const emailResult = await sendVerificationOtpEmail(
        email,
        otp,
        expiryMinutes,
        isResend,
        purpose,
      );

      const isTestRuntime = Boolean(process.env['VITEST']);
      const hintSettingRaw = getEnvValue('ALLOW_DEV_OTP_HINT').toLowerCase();
      const allowDevHint = isTestRuntime || hintSettingRaw === 'true';

      if (!emailResult.dispatched && !allowDevHint) {
        // Delete unsent OTP record so resend cooldown does not block retry after fixing email config
        await executeSql('DELETE FROM otp_verifications WHERE id = ?', [Number(insertRes.insertId)]);
        const statusCode = emailResult.configured ? 502 : 503;
        const errorMessage = emailResult.configured
          ? `Could not deliver verification email (${emailResult.error || 'Email delivery failed'}).`
          : 'No email delivery provider is configured on this server. Configure EMAIL_HOST_USER / EMAIL_HOST_PASSWORD or an HTTPS relay (BREVO_API_KEY / EMAIL_WEBHOOK_URL) in environment variables or Admin Settings.';
        res.status(statusCode).json({
          error: errorMessage,
          emailDispatched: false,
          emailConfigured: emailResult.configured,
          emailProvider: emailResult.provider,
          emailError: emailResult.error || null,
        });
        return;
      }

      // Supersede any earlier unused OTPs for this email & purpose so only the latest code is valid
      await executeSql(
        `UPDATE otp_verifications
         SET used_at = ?
         WHERE LOWER(email) = ? AND purpose = ? AND used_at IS NULL AND id < ?`,
        [toMysqlDateTime(now), email, purpose, Number(insertRes.insertId)],
      );

      if (!emailResult.dispatched && isTestRuntime) {
        console.log(
          `[EMAIL OTP TEST NOTICE] purpose=${purpose} email=${email} otp=${otp} | provider=${emailResult.provider} | err=${emailResult.error || 'none'}`,
        );
      }

      res.json({
        otpRequestId: Number(insertRes.insertId),
        email,
        expiresInSeconds: expiryMinutes * 60,
        message: emailResult.dispatched
          ? `Verification code sent to ${email}.`
          : `Verification code generated for test verification.`,
        emailProvider: emailResult.provider,
        emailDispatched: emailResult.dispatched,
        emailConfigured: emailResult.configured,
        emailError: emailResult.error || null,
        ...(allowDevHint ? {devOtpHint: otp} : {}),
      });
    },
  );

  // Verify Email OTP
  router.post(
    '/auth/otp/verify',
    rateLimit('otp_verify', 15, 15 * 60 * 1000),
    async (req: Request, res: Response) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const otp = String(req.body?.otp || '').trim();
      const purpose = req.body?.purpose
        ? String(req.body.purpose).trim().toUpperCase()
        : '';

      if (!/^\S+@\S+\.\S+$/.test(email) || !/^\d{6}$/.test(otp)) {
        res.status(400).json({error: 'Valid email address and 6-digit OTP are required.'});
        return;
      }

      const latest = await queryOne<{
        id: number;
        otp_hash: string;
        expires_at: Date | string;
        attempts: number;
        max_attempts: number;
        verified_at: Date | string | null;
      }>(
        purpose
          ? `SELECT * FROM otp_verifications
             WHERE LOWER(email) = ? AND purpose = ? AND used_at IS NULL
             ORDER BY id DESC LIMIT 1`
          : `SELECT * FROM otp_verifications
             WHERE LOWER(email) = ? AND used_at IS NULL
             ORDER BY id DESC LIMIT 1`,
        purpose ? [email, purpose] : [email],
      );

      if (!latest) {
        res.status(400).json({error: 'No active OTP request found. Please request a new code.'});
        return;
      }
      if (new Date(latest.expires_at).getTime() < Date.now()) {
        res.status(400).json({error: 'OTP has expired. Please request a new code.'});
        return;
      }
      if (latest.attempts >= latest.max_attempts) {
        res.status(429).json({error: 'Maximum OTP attempts exceeded. Request a new code.'});
        return;
      }

      const providedHash = hashOtp(email, otp);
      if (providedHash !== latest.otp_hash) {
        await executeSql('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?', [
          latest.id,
        ]);
        const remaining = latest.max_attempts - (latest.attempts + 1);
        res.status(400).json({
          error: `Invalid OTP. ${Math.max(remaining, 0)} attempt(s) remaining.`,
        });
        return;
      }

      const now = new Date();
      await executeSql('UPDATE otp_verifications SET verified_at = ? WHERE id = ?', [
        toMysqlDateTime(now),
        latest.id,
      ]);

      res.json({
        verified: true,
        otpVerificationId: latest.id,
        verifiedAt: now.toISOString(),
      });
    },
  );

  // Confirm Password Reset using verified PASSWORD_RESET OTP
  router.post(
    '/auth/password-reset/confirm',
    rateLimit('password_reset_confirm', 10, 15 * 60 * 1000),
    async (req: Request, res: Response) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const otpVerificationId = Number(req.body?.otpVerificationId || 0);
      const newPassword = String(req.body?.newPassword || '');

      if (!/^\S+@\S+\.\S+$/.test(email) || !otpVerificationId || newPassword.length < 8) {
        res.status(400).json({
          error: 'Valid email, verified code, and a new password (8+ characters) are required.',
        });
        return;
      }

      const account = await queryOne<{
        id: number;
        email: string;
        role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
        is_active: number;
      }>(
        'SELECT id, email, role, is_active FROM user_accounts WHERE LOWER(email) = ? AND deleted_at IS NULL',
        [email],
      );

      if (!account) {
        res.status(404).json({error: 'No account found with this email address.'});
        return;
      }
      if (!account.is_active) {
        res.status(403).json({error: 'This account has been deactivated by an administrator.'});
        return;
      }

      const otpRec = await queryOne<{
        id: number;
        expires_at: Date | string;
        verified_at: Date | string | null;
        used_at: Date | string | null;
      }>(
        `SELECT id, expires_at, verified_at, used_at
         FROM otp_verifications
         WHERE id = ? AND LOWER(email) = ? AND purpose = 'PASSWORD_RESET'`,
        [otpVerificationId, email],
      );

      if (
        !otpRec ||
        !otpRec.verified_at ||
        otpRec.used_at ||
        new Date(otpRec.expires_at).getTime() < Date.now()
      ) {
        res.status(400).json({
          error: 'Password reset verification has expired or was already used. Request a new code.',
        });
        return;
      }

      const nowMysql = toMysqlDateTime();
      await withTransaction(async (tx) => {
        await tx.executeSql('UPDATE otp_verifications SET used_at = ? WHERE id = ?', [
          nowMysql,
          otpRec.id,
        ]);
        await tx.executeSql(
          'UPDATE user_accounts SET password_hash = ?, is_email_verified = 1, updated_at = ? WHERE id = ?',
          [hashPassword(newPassword), nowMysql, account.id],
        );
        await tx.executeSql(
          'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
          [nowMysql, account.id],
        );
      });

      await writeAuditLog(
        {id: account.id, email: account.email, role: account.role},
        'PASSWORD_RESET_COMPLETED',
        'USER_ACCOUNT',
        account.id,
        {method: 'EMAIL_OTP'},
        req.ip,
      );

      res.json({
        success: true,
        role: account.role,
        message: 'Password updated successfully.',
      });
    },
  );

  // User Self-Registration
  router.post('/auth/register', async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const fullName = String(b.fullName || '').trim();
      const email = String(b.email || '').trim().toLowerCase();
      const mobile = String(b.mobile || '').trim();
      const password = String(b.password || '');
      const otpVerificationId = Number(b.otpVerificationId || 0);
      const dob = toMysqlDate(b.dob);
      const gender = b.gender ? String(b.gender).trim() || null : null;
      const address = String(b.address || '').trim();
      const city = String(b.city || '').trim();
      const district = String(b.district || '').trim();
      const state = String(b.state || '').trim();
      const country = String(b.country || '').trim();
      const postalCode = String(b.postalCode || '').trim();
      const idProofType = String(b.idProofType || 'National ID').trim();
      const consentAccepted = Boolean(b.consentAccepted);
      const dynamicFields = b.dynamicFields && typeof b.dynamicFields === 'object' ? b.dynamicFields : {};

      if (
        !fullName ||
        !email ||
        !mobile ||
        password.length < 8 ||
        !address ||
        !city ||
        !district ||
        !state ||
        !country ||
        !postalCode
      ) {
        res.status(400).json({
          error: 'Please fill in all required details and set a password with at least 8 characters.',
        });
        return;
      }
      if (!consentAccepted) {
        res.status(400).json({error: 'Please accept the privacy notice before submitting your application.'});
        return;
      }
      if (!otpVerificationId) {
        res.status(400).json({error: 'Please verify your email address with the one-time code first.'});
        return;
      }

      const otpRec = await queryOne<{
        id: number;
        email: string;
        verified_at: Date | string | null;
        used_at: Date | string | null;
      }>(
        'SELECT id, email, verified_at, used_at FROM otp_verifications WHERE id = ? AND LOWER(email) = ?',
        [otpVerificationId, email],
      );

      if (!otpRec || !otpRec.verified_at || otpRec.used_at) {
        res.status(400).json({
          error: 'Your email verification has expired or was already used. Please request a fresh code.',
        });
        return;
      }

      const dup = await queryOne(
        'SELECT id FROM user_accounts WHERE LOWER(email) = ? OR mobile = ?',
        [email, mobile],
      );
      if (dup) {
        res.status(409).json({error: 'An account with this email or mobile number already exists.'});
        return;
      }

      const profilePhotoUrl = b.profilePhotoData
        ? await saveBase64Upload(
            String(b.profilePhotoData),
            ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],
            'photo',
          )
        : '/assets/images/avatar_member_portrait_1794911275468.jpg';

      let idProofUrl: string | null = null;
      if (b.idProofData) {
        idProofUrl = await saveBase64Upload(
          String(b.idProofData),
          ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'],
          'idproof',
        );
      } else if ((await getSetting('id_proof_required', 'true')) === 'true') {
        res.status(400).json({error: 'Please upload a photo or PDF of your ID proof.'});
        return;
      }

      const nowDate = new Date();
      const nowIso = nowDate.toISOString();
      const nowMysql = toMysqlDateTime(nowDate);
      const year = nowDate.getFullYear();

      const result = await withTransaction(async (tx) => {
        await tx.executeSql('UPDATE otp_verifications SET used_at = ? WHERE id = ?', [
          nowMysql,
          otpRec.id,
        ]);

        const userRes = await tx.executeSql(
          `INSERT INTO user_accounts
            (email, mobile, password_hash, role, is_active, is_mobile_verified, is_email_verified, created_at, updated_at)
           VALUES (?, ?, ?, 'USER', 1, 0, 1, ?, ?)`,
          [email, mobile, hashPassword(password), nowMysql, nowMysql],
        );
        const userId = Number(userRes.insertId);
        const registrationId = `SQR-${year}-${String(100000 + userId).padStart(6, '0')}`;

        const recRes = await tx.executeSql(
          `INSERT INTO user_records
            (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
             profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
             approval_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'PENDING', ?, ?)`,
          [
            userId,
            registrationId,
            fullName,
            dob,
            gender,
            address,
            city,
            district,
            state,
            country,
            postalCode,
            profilePhotoUrl,
            idProofType,
            idProofUrl,
            JSON.stringify(dynamicFields),
            nowMysql,
            nowMysql,
            nowMysql,
          ],
        );
        const userRecordId = Number(recRes.insertId);

        await tx.executeSql(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at)
           VALUES (?, 'INITIAL', 'PENDING', 'Self-registration submitted with verified email OTP.', ?)`,
          [userRecordId, nowMysql],
        );

        return {userId, userRecordId, registrationId};
      });

      await createNotification({
        recipientRole: 'ADMIN',
        type: 'NEW_REGISTRATION',
        title: 'New Registration Pending Review',
        message: `${fullName} (${result.registrationId}) registered from ${city}, ${state}.`,
        linkPath: '/admin/registrations',
        metadata: {userRecordId: result.userRecordId, registrationId: result.registrationId},
      });

      await createNotification({
        recipientUserId: result.userId,
        type: 'REGISTRATION_RECEIVED',
        title: 'Registration Received',
        message: `Application ${result.registrationId} is pending administrator review.`,
        linkPath: '/user/home',
        metadata: {registrationId: result.registrationId},
      });

      await writeAuditLog(
        {id: result.userId, email, role: 'USER'},
        'USER_REGISTERED',
        'USER_RECORD',
        result.userRecordId,
        {registrationId: result.registrationId, city, state},
        req.ip,
      );

      res.status(201).json({
        success: true,
        registrationId: result.registrationId,
        status: 'PENDING',
        submittedAt: nowIso,
        message:
          'Registration submitted successfully. Your application is awaiting administrator approval.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed.';
      res.status(400).json({error: message});
    }
  });

  // Login helper for both User & Admin endpoints
  function handleLogin(expectedPortal: 'USER' | 'ADMIN') {
    return async (req: Request, res: Response): Promise<void> => {
      const identifier = String(req.body?.email || req.body?.identifier || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      if (!identifier || !password) {
        res.status(400).json({error: 'Email/mobile and password are required.'});
        return;
      }

      let account = await queryOne<{
        id: number;
        email: string;
        mobile: string;
        password_hash: string;
        role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
        is_active: number;
        is_mobile_verified: number;
      }>(
        `SELECT * FROM user_accounts
         WHERE (LOWER(email) = ? OR mobile = ?) AND deleted_at IS NULL`,
        [identifier, identifier],
      );

      if (!account && expectedPortal === 'ADMIN') {
        const fixedAdminEmail = (getEnvValue('FIXED_ADMIN_EMAIL') || 'kishore.sathayush@gmail.com')
          .trim()
          .toLowerCase();
        if (identifier === fixedAdminEmail) {
          await ensureFixedAdmin();
          account = await queryOne<{
            id: number;
            email: string;
            mobile: string;
            password_hash: string;
            role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
            is_active: number;
            is_mobile_verified: number;
          }>(
            `SELECT * FROM user_accounts
             WHERE (LOWER(email) = ? OR mobile = ?) AND deleted_at IS NULL`,
            [identifier, identifier],
          );
        }
      }

      if (!account || !verifyPassword(password, account.password_hash)) {
        res.status(401).json({error: 'Invalid credentials.'});
        return;
      }
      if (!account.is_active) {
        res.status(403).json({error: 'This account has been deactivated by an administrator.'});
        return;
      }

      const isAdminRole = account.role === 'ADMIN' || account.role === 'SUPER_ADMIN';
      if (expectedPortal === 'ADMIN' && !isAdminRole) {
        res.status(403).json({error: 'Administrator privileges are required for the Admin Portal.'});
        return;
      }
      if (expectedPortal === 'USER' && isAdminRole) {
        res.status(403).json({error: 'Please sign in via the Admin Portal for staff accounts.'});
        return;
      }

      let permissions: string[] = [];
      let displayName = account.email;
      let avatarUrl = '/assets/images/avatar_member_portrait_1794911275468.jpg';
      let registrationId: string | null = null;
      let approvalStatus: string | null = null;

      if (isAdminRole) {
        const profile = await queryOne<{
          full_name: string;
          avatar_url: string;
          permissions_json: unknown;
        }>('SELECT * FROM admin_profiles WHERE user_id = ?', [account.id]);

        displayName = profile?.full_name || account.email;
        avatarUrl = profile?.avatar_url || '/assets/images/avatar_admin_portrait_1794911291825.jpg';
        permissions =
          account.role === 'SUPER_ADMIN'
            ? [
                'can_view_registrations',
                'can_approve_registrations',
                'can_manage_qr',
                'can_scan_qr',
                'can_export_excel',
                'can_manage_users',
              ]
            : profile
              ? parseJsonSafe<string[]>(profile.permissions_json, [])
              : [];
      } else {
        const rec = await queryOne<{
          full_name: string;
          profile_photo_url: string;
          registration_id: string;
          approval_status: string;
        }>(
          'SELECT full_name, profile_photo_url, registration_id, approval_status FROM user_records WHERE user_id = ?',
          [account.id],
        );
        if (rec) {
          displayName = rec.full_name;
          avatarUrl = rec.profile_photo_url;
          registrationId = rec.registration_id;
          approvalStatus = rec.approval_status;
        }
      }

      const accessToken = signAccessToken(
        {sub: account.id, email: account.email, role: account.role, permissions},
        3600,
      );
      const refreshToken = generateRefreshToken();
      const now = new Date();
      await executeSql(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
        [
          account.id,
          sha256Hex(refreshToken),
          toMysqlDateTime(now.getTime() + 7 * 86400000),
          toMysqlDateTime(now),
        ],
      );

      await writeAuditLog(
        {id: account.id, email: account.email, role: account.role},
        isAdminRole ? 'ADMIN_LOGIN' : 'USER_LOGIN',
        'USER_ACCOUNT',
        account.id,
        {},
        req.ip,
      );

      res.json({
        accessToken,
        refreshToken,
        user: {
          id: account.id,
          email: account.email,
          mobile: account.mobile,
          role: account.role,
          permissions,
          displayName,
          avatarUrl,
          registrationId,
          approvalStatus,
        },
      });
    };
  }

  router.post('/auth/login', rateLimit('login', 20, 15 * 60 * 1000), handleLogin('USER'));
  router.post('/auth/admin/login', rateLimit('admin_login', 20, 15 * 60 * 1000), handleLogin('ADMIN'));

  router.post('/auth/refresh', async (req: Request, res: Response) => {
    const refreshToken = String(req.body?.refreshToken || '');
    if (!refreshToken) {
      res.status(400).json({error: 'Refresh token required.'});
      return;
    }
    const tokenHash = sha256Hex(refreshToken);
    const row = await queryOne<{id: number; user_id: number; expires_at: Date | string}>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL',
      [tokenHash],
    );

    if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
      res.status(401).json({error: 'Refresh token is invalid or expired.'});
      return;
    }

    const account = await queryOne<{
      id: number;
      email: string;
      role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
      is_active: number;
      deleted_at: Date | string | null;
    }>('SELECT id, email, role, is_active, deleted_at FROM user_accounts WHERE id = ?', [
      row.user_id,
    ]);

    if (!account || !account.is_active || account.deleted_at) {
      res.status(403).json({error: 'Account inactive.'});
      return;
    }

    let permissions: string[] = [];
    if (account.role === 'SUPER_ADMIN') {
      permissions = [
        'can_view_registrations',
        'can_approve_registrations',
        'can_manage_qr',
        'can_scan_qr',
        'can_export_excel',
        'can_manage_users',
      ];
    } else if (account.role === 'ADMIN') {
      const profile = await queryOne<{permissions_json: unknown}>(
        'SELECT permissions_json FROM admin_profiles WHERE user_id = ?',
        [account.id],
      );
      permissions = profile ? parseJsonSafe<string[]>(profile.permissions_json, []) : [];
    }

    const accessToken = signAccessToken(
      {sub: account.id, email: account.email, role: account.role, permissions},
      3600,
    );
    res.json({accessToken});
  });

  router.post('/auth/logout', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const refreshToken = String(req.body?.refreshToken || '');
    if (refreshToken) {
      await executeSql('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?', [
        toMysqlDateTime(),
        sha256Hex(refreshToken),
      ]);
    }
    res.json({success: true});
  });

  router.get('/auth/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const auth = req.auth!;
    const account = await queryOne<Record<string, unknown>>(
      'SELECT id, email, mobile, role, is_active, is_mobile_verified, created_at FROM user_accounts WHERE id = ?',
      [auth.sub],
    );

    if (auth.role === 'ADMIN' || auth.role === 'SUPER_ADMIN') {
      const profile = await queryOne<{
        full_name: string;
        department: string;
        designation: string;
        avatar_url: string;
      }>('SELECT full_name, department, designation, avatar_url FROM admin_profiles WHERE user_id = ?', [
        auth.sub,
      ]);
      res.json({
        ...account,
        permissions: auth.permissions,
        displayName: profile?.full_name || auth.email,
        department: profile?.department || '',
        designation: profile?.designation || '',
        avatarUrl: profile?.avatar_url || '/assets/images/avatar_admin_portrait_1794911291825.jpg',
      });
      return;
    }

    const rec = await queryOne<{
      full_name: string;
      profile_photo_url: string;
      registration_id: string;
      approval_status: string;
    }>(
      'SELECT full_name, profile_photo_url, registration_id, approval_status FROM user_records WHERE user_id = ?',
      [auth.sub],
    );
    res.json({
      ...account,
      permissions: [],
      displayName: rec?.full_name || auth.email,
      avatarUrl: rec?.profile_photo_url || '/assets/images/avatar_member_portrait_1794911275468.jpg',
      registrationId: rec?.registration_id || null,
      approvalStatus: rec?.approval_status || null,
    });
  });

  // =========================================================================
  // USER PORTAL APIs
  // =========================================================================

  router.get('/user/dashboard', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.auth!.sub;
    const record = await queryOne<Record<string, unknown>>(
      `SELECT ur.*, ua.email, ua.mobile, ua.is_mobile_verified, ua.is_active
       FROM user_records ur
       JOIN user_accounts ua ON ua.id = ur.user_id
       WHERE ur.user_id = ? AND ur.deleted_at IS NULL`,
      [userId],
    );

    if (!record) {
      res.status(404).json({error: 'User registration record not found.'});
      return;
    }

    const activeQr = await queryOne<Record<string, unknown>>(
      `SELECT id, token_prefix, verification_url, qr_png_data_url, status, issued_at, expires_at, scan_count, last_verified_at
       FROM qr_codes
       WHERE user_record_id = ? AND status = 'ACTIVE'
       ORDER BY id DESC LIMIT 1`,
      [record['id']],
    );

    const unreadRow = await queryOne<{cnt: number}>(
      'SELECT COUNT(*) as cnt FROM notifications WHERE recipient_user_id = ? AND is_read = 0',
      [userId],
    );
    const unreadNotifications = Number(unreadRow?.cnt || 0);

    const recentNotifications = await queryRows(
      `SELECT id, type, title, message, link_path, is_read, created_at
       FROM notifications
       WHERE recipient_user_id = ?
       ORDER BY id DESC LIMIT 5`,
      [userId],
    );

    const history = await queryRows(
      `SELECT id, request_type, status, notes, submitted_at, processed_at
       FROM registration_requests
       WHERE user_record_id = ?
       ORDER BY id DESC`,
      [record['id']],
    );

    res.json({
      record: {
        ...record,
        dob: toMysqlDate(record['dob']) || '',
        dynamicFields: parseJsonSafe<Record<string, unknown>>(record['dynamic_fields_json'], {}),
      },
      activeQr: activeQr || null,
      unreadNotifications,
      recentNotifications,
      history,
      organizationName: await getSetting('organization_name', 'Secure QR Verification Authority'),
    });
  });

  router.patch('/user/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.auth!.sub;
      const record = await queryOne<Record<string, unknown>>(
        'SELECT * FROM user_records WHERE user_id = ?',
        [userId],
      );
      if (!record) {
        res.status(404).json({error: 'Record not found.'});
        return;
      }

      const b = req.body || {};
      const nowDate = new Date();
      const nowIso = nowDate.toISOString();
      const nowMysql = toMysqlDateTime(nowDate);
      const profilePhotoUrl = b.profilePhotoData
        ? await saveBase64Upload(
            String(b.profilePhotoData),
            ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],
            'photo',
          )
        : String(record['profile_photo_url']);

      const idProofUrl = b.idProofData
        ? await saveBase64Upload(
            String(b.idProofData),
            ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'],
            'idproof',
          )
        : (record['id_proof_url'] as string | null);

      const dynJson = b.dynamicFields
        ? JSON.stringify(b.dynamicFields)
        : JSON.stringify(parseJsonSafe<Record<string, unknown>>(record['dynamic_fields_json'], {}));

      const nextFullName = String(b.fullName ?? record['full_name']).trim();
      const nextAddress = String(b.address ?? record['address']).trim();
      const nextCity = String(b.city ?? record['city']).trim();
      const nextDistrict = String(b.district ?? record['district']).trim();
      const nextState = String(b.state ?? record['state']).trim();
      const nextCountry = String(b.country ?? record['country']).trim();
      const nextPostalCode = String(b.postalCode ?? record['postal_code']).trim();

      if (
        !nextFullName ||
        !nextAddress ||
        !nextCity ||
        !nextDistrict ||
        !nextState ||
        !nextCountry ||
        !nextPostalCode
      ) {
        res.status(400).json({error: 'All required personal and address fields must be provided.'});
        return;
      }

      const dobVal = b.dob !== undefined ? toMysqlDate(b.dob) : toMysqlDate(record['dob']);
      const genderVal =
        b.gender !== undefined ? (b.gender ? String(b.gender).trim() || null : null) : record['gender'];

      await executeSql(
        `UPDATE user_records
         SET full_name = ?, dob = ?, gender = ?, address = ?, city = ?, district = ?, state = ?, country = ?, postal_code = ?,
             profile_photo_url = ?, id_proof_type = ?, id_proof_url = ?, dynamic_fields_json = ?, updated_at = ?
         WHERE user_id = ?`,
        [
          nextFullName,
          dobVal,
          genderVal,
          nextAddress,
          nextCity,
          nextDistrict,
          nextState,
          nextCountry,
          nextPostalCode,
          profilePhotoUrl,
          String(b.idProofType ?? record['id_proof_type']),
          idProofUrl,
          dynJson,
          nowMysql,
          userId,
        ],
      );

      res.json({success: true, updatedAt: nowIso});
    } catch (err) {
      res.status(400).json({error: err instanceof Error ? err.message : 'Update failed'});
    }
  });

  router.post('/user/resubmit', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.auth!.sub;
      const record = await queryOne<Record<string, unknown>>(
        'SELECT * FROM user_records WHERE user_id = ?',
        [userId],
      );

      if (!record) {
        res.status(404).json({error: 'Registration record not found.'});
        return;
      }
      if (record['approval_status'] !== 'RESUBMISSION_REQUIRED') {
        res.status(400).json({error: 'Only applications marked for update can be resubmitted.'});
        return;
      }

      const b = req.body || {};
      const nextFullName = String(b.fullName ?? record['full_name']).trim();
      const nextAddress = String(b.address ?? record['address']).trim();
      const nextCity = String(b.city ?? record['city']).trim();
      const nextDistrict = String(b.district ?? record['district']).trim();
      const nextState = String(b.state ?? record['state']).trim();
      const nextCountry = String(b.country ?? record['country']).trim();
      const nextPostalCode = String(b.postalCode ?? record['postal_code']).trim();

      if (
        !nextFullName ||
        !nextAddress ||
        !nextCity ||
        !nextDistrict ||
        !nextState ||
        !nextCountry ||
        !nextPostalCode
      ) {
        res.status(400).json({error: 'All required personal and address fields must be provided.'});
        return;
      }

      const nowMysql = toMysqlDateTime();
      const profilePhotoUrl = b.profilePhotoData
        ? await saveBase64Upload(
            String(b.profilePhotoData),
            ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],
            'photo',
          )
        : String(record['profile_photo_url']);

      const idProofUrl = b.idProofData
        ? await saveBase64Upload(
            String(b.idProofData),
            ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'],
            'idproof',
          )
        : (record['id_proof_url'] as string | null);

      const dynJson = b.dynamicFields
        ? JSON.stringify(b.dynamicFields)
        : JSON.stringify(parseJsonSafe<Record<string, unknown>>(record['dynamic_fields_json'], {}));

      const dobVal = b.dob !== undefined ? toMysqlDate(b.dob) : toMysqlDate(record['dob']);
      const genderVal =
        b.gender !== undefined ? (b.gender ? String(b.gender).trim() || null : null) : record['gender'];

      await withTransaction(async (tx) => {
        await tx.executeSql(
          `UPDATE user_records
           SET full_name = ?, dob = ?, gender = ?, address = ?, city = ?, district = ?, state = ?, country = ?, postal_code = ?,
               profile_photo_url = ?, id_proof_type = ?, id_proof_url = ?, dynamic_fields_json = ?,
               approval_status = 'PENDING', resubmission_note = NULL, updated_at = ?
           WHERE id = ?`,
          [
            nextFullName,
            dobVal,
            genderVal,
            nextAddress,
            nextCity,
            nextDistrict,
            nextState,
            nextCountry,
            nextPostalCode,
            profilePhotoUrl,
            String(b.idProofType ?? record['id_proof_type']),
            idProofUrl,
            dynJson,
            nowMysql,
            record['id'],
          ],
        );

        await tx.executeSql(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at)
           VALUES (?, 'RESUBMISSION', 'PENDING', ?, ?)`,
          [
            record['id'],
            String(b.resubmissionComment || 'Applicant updated requested details and resubmitted.'),
            nowMysql,
          ],
        );
      });

      await createNotification({
        recipientRole: 'ADMIN',
        type: 'RESUBMISSION',
        title: 'Application Resubmitted',
        message: `${String(b.fullName ?? record['full_name'])} (${String(record['registration_id'])}) resubmitted corrections for review.`,
        linkPath: '/admin/registrations',
        metadata: {userRecordId: record['id'], registrationId: record['registration_id']},
      });

      res.json({success: true, status: 'PENDING'});
    } catch (err) {
      res.status(400).json({error: err instanceof Error ? err.message : 'Resubmission failed'});
    }
  });

  router.get('/user/qr/download', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.auth!.sub;
    const record = await queryOne<{
      id: number;
      registration_id: string;
      approval_status: string;
    }>('SELECT id, registration_id, approval_status FROM user_records WHERE user_id = ?', [userId]);

    if (!record || record.approval_status !== 'APPROVED') {
      res.status(403).json({error: 'Only approved users can download an active QR credential.'});
      return;
    }

    const qr = await queryOne<{
      qr_png_data_url: string;
      status: string;
      expires_at: Date | string;
    }>(
      `SELECT qr_png_data_url, status, expires_at FROM qr_codes
       WHERE user_record_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1`,
      [record.id],
    );

    if (!qr || new Date(qr.expires_at).getTime() <= Date.now()) {
      res.status(404).json({error: 'No active non-expired QR credential found.'});
      return;
    }

    const b64 = qr.qr_png_data_url.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="QR_${record.registration_id}.png"`,
    );
    res.send(buffer);
  });

  router.get('/user/notifications', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const items = await queryRows(
      'SELECT * FROM notifications WHERE recipient_user_id = ? ORDER BY id DESC LIMIT 100',
      [req.auth!.sub],
    );
    res.json({notifications: items});
  });

  router.post('/user/notifications/:id/read', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await executeSql(
      'UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ? AND recipient_user_id = ?',
      [toMysqlDateTime(), Number(req.params['id']), req.auth!.sub],
    );
    res.json({success: true});
  });

  router.post('/user/notifications/read-all', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await executeSql(
      'UPDATE notifications SET is_read = 1, read_at = ? WHERE recipient_user_id = ? AND is_read = 0',
      [toMysqlDateTime(), req.auth!.sub],
    );
    res.json({success: true});
  });

  router.post('/user/change-password', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 8) {
      res.status(400).json({error: 'New password must be at least 8 characters long.'});
      return;
    }
    const account = await queryOne<{password_hash: string}>(
      'SELECT password_hash FROM user_accounts WHERE id = ?',
      [req.auth!.sub],
    );
    if (!account || !verifyPassword(currentPassword, account.password_hash)) {
      res.status(400).json({error: 'Current password is incorrect.'});
      return;
    }
    await executeSql('UPDATE user_accounts SET password_hash = ?, updated_at = ? WHERE id = ?', [
      hashPassword(newPassword),
      toMysqlDateTime(),
      req.auth!.sub,
    ]);
    res.json({success: true});
  });

  // =========================================================================
  // ADMIN PORTAL APIs
  // =========================================================================

  router.get('/admin/dashboard/stats', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
    // Auto-expire past-due active QRs
    await executeSql(`UPDATE qr_codes SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ?`, [
      toMysqlDateTime(),
    ]);

    const countOf = async (sql: string): Promise<number> => {
      const r = await queryOne<{c: number}>(sql);
      return Number(r?.c || 0);
    };

    const [
      totalUsers,
      pendingRegistrations,
      approvedUsers,
      rejectedUsers,
      resubmissionRequests,
      activeQrCodes,
      expiredQrCodes,
      revokedQrCodes,
      totalQrScans,
      unreadNotifications,
    ] = await Promise.all([
      countOf("SELECT COUNT(*) as c FROM user_accounts WHERE role = 'USER' AND deleted_at IS NULL"),
      countOf("SELECT COUNT(*) as c FROM user_records ur JOIN user_accounts ua ON ua.id = ur.user_id WHERE ur.approval_status = 'PENDING' AND ur.deleted_at IS NULL AND ua.deleted_at IS NULL"),
      countOf("SELECT COUNT(*) as c FROM user_records ur JOIN user_accounts ua ON ua.id = ur.user_id WHERE ur.approval_status = 'APPROVED' AND ur.deleted_at IS NULL AND ua.deleted_at IS NULL"),
      countOf("SELECT COUNT(*) as c FROM user_records ur JOIN user_accounts ua ON ua.id = ur.user_id WHERE ur.approval_status = 'REJECTED' AND ur.deleted_at IS NULL AND ua.deleted_at IS NULL"),
      countOf("SELECT COUNT(*) as c FROM user_records ur JOIN user_accounts ua ON ua.id = ur.user_id WHERE ur.approval_status = 'RESUBMISSION_REQUIRED' AND ur.deleted_at IS NULL AND ua.deleted_at IS NULL"),
      countOf("SELECT COUNT(*) as c FROM qr_codes WHERE status = 'ACTIVE'"),
      countOf("SELECT COUNT(*) as c FROM qr_codes WHERE status = 'EXPIRED'"),
      countOf("SELECT COUNT(*) as c FROM qr_codes WHERE status = 'REVOKED'"),
      countOf('SELECT COUNT(*) as c FROM qr_scan_logs'),
      countOf("SELECT COUNT(*) as c FROM notifications WHERE recipient_role IN ('ADMIN', 'SUPER_ADMIN') AND is_read = 0"),
    ]);

    const recentRegistrations = await queryRows(
      `SELECT ur.id, ur.registration_id, ur.full_name, ur.city, ur.state, ur.approval_status, ur.created_at, ur.profile_photo_url, ua.email
       FROM user_records ur
       JOIN user_accounts ua ON ua.id = ur.user_id
       WHERE ur.deleted_at IS NULL
       ORDER BY ur.id DESC LIMIT 6`,
    );

    const recentScans = await queryRows(
      `SELECT sl.id, sl.result_status, sl.reason, sl.scanned_token_prefix, sl.scanned_at,
              ur.full_name as holder_name, ur.registration_id,
              ap.full_name as scanner_name
       FROM qr_scan_logs sl
       LEFT JOIN user_records ur ON ur.id = sl.user_record_id
       LEFT JOIN admin_profiles ap ON ap.user_id = sl.scanned_by_admin_id
       ORDER BY sl.id DESC LIMIT 6`,
    );

    res.json({
      stats: {
        totalUsers,
        pendingRegistrations,
        approvedUsers,
        rejectedUsers,
        resubmissionRequests,
        activeQrCodes,
        expiredQrCodes,
        revokedQrCodes,
        totalQrScans,
        unreadNotifications,
      },
      recentRegistrations,
      recentScans,
    });
  });

  // Registration queue & filters
  router.get(
    '/admin/registrations',
    requireAuth,
    requirePermission('can_view_registrations'),
    async (req: AuthenticatedRequest, res: Response) => {
      const status = String(req.query['status'] || '').trim();
      const search = String(req.query['search'] || '').trim();
      const state = String(req.query['state'] || '').trim();
      const city = String(req.query['city'] || '').trim();
      const dateFrom = String(req.query['dateFrom'] || '').trim();
      const dateTo = String(req.query['dateTo'] || '').trim();
      const sortBy = String(req.query['sortBy'] || 'created_at');
      const sortDir = String(req.query['sortDir'] || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      const page = Math.max(1, Number.parseInt(String(req.query['page'] || '1'), 10) || 1);
      const pageSize = Math.min(100, Math.max(5, Number.parseInt(String(req.query['pageSize'] || '15'), 10) || 15));

      const where: string[] = ['ur.deleted_at IS NULL'];
      const params: (string | number)[] = [];

      if (status && status !== 'ALL') {
        where.push('ur.approval_status = ?');
        params.push(status);
      }
      if (state) {
        where.push('LOWER(ur.state) = LOWER(?)');
        params.push(state);
      }
      if (city) {
        where.push('LOWER(ur.city) = LOWER(?)');
        params.push(city);
      }
      if (dateFrom) {
        where.push('ur.created_at >= ?');
        params.push(toMysqlDateTime(`${dateFrom}T00:00:00.000Z`));
      }
      if (dateTo) {
        where.push('ur.created_at <= ?');
        params.push(toMysqlDateTime(`${dateTo}T23:59:59.999Z`));
      }
      if (search) {
        where.push(
          '(LOWER(ur.full_name) LIKE ? OR LOWER(ur.registration_id) LIKE ? OR LOWER(ua.email) LIKE ? OR ua.mobile LIKE ?)',
        );
        const like = `%${search.toLowerCase()}%`;
        params.push(like, like, like, like);
      }

      const allowedSorts: Record<string, string> = {
        created_at: 'ur.created_at',
        full_name: 'ur.full_name',
        registration_id: 'ur.registration_id',
        approval_status: 'ur.approval_status',
        state: 'ur.state',
      };
      const sortCol = allowedSorts[sortBy] || 'ur.created_at';

      const whereSql = where.join(' AND ');
      const totalRow = await queryOne<{c: number}>(
        `SELECT COUNT(*) as c FROM user_records ur JOIN user_accounts ua ON ua.id = ur.user_id WHERE ${whereSql}`,
        params,
      );
      const total = Number(totalRow?.c || 0);

      const rows = await queryRows<Record<string, unknown>>(
        `SELECT ur.*, ua.email, ua.mobile, ua.is_active, ua.is_mobile_verified,
                (SELECT status FROM qr_codes q WHERE q.user_record_id = ur.id ORDER BY q.id DESC LIMIT 1) as latest_qr_status,
                (SELECT expires_at FROM qr_codes q WHERE q.user_record_id = ur.id ORDER BY q.id DESC LIMIT 1) as latest_qr_expires_at
         FROM user_records ur
         JOIN user_accounts ua ON ua.id = ur.user_id
         WHERE ${whereSql}
         ORDER BY ${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize],
      );

      const states = await queryRows<{state: string}>(
        'SELECT DISTINCT state FROM user_records WHERE deleted_at IS NULL ORDER BY state ASC',
      );
      const cities = await queryRows<{city: string}>(
        'SELECT DISTINCT city FROM user_records WHERE deleted_at IS NULL ORDER BY city ASC',
      );

      const countRows = await queryRows<{approval_status: string; cnt: number}>(
        `SELECT ur.approval_status, COUNT(*) as cnt
         FROM user_records ur
         JOIN user_accounts ua ON ua.id = ur.user_id
         WHERE ur.deleted_at IS NULL AND ua.deleted_at IS NULL
         GROUP BY ur.approval_status`,
      );
      const countsMap = new Map<string, number>();
      let allCount = 0;
      for (const cr of countRows) {
        const c = Number(cr.cnt || 0);
        countsMap.set(cr.approval_status, c);
        allCount += c;
      }

      res.json({
        items: rows.map((r) => ({
          ...r,
          dob: toMysqlDate(r['dob']) || '',
          dynamicFields: parseJsonSafe<Record<string, unknown>>(r['dynamic_fields_json'], {}),
        })),
        total,
        page,
        pageSize,
        counts: {
          all: allCount,
          pending: countsMap.get('PENDING') ?? 0,
          approved: countsMap.get('APPROVED') ?? 0,
          resubmission: countsMap.get('RESUBMISSION_REQUIRED') ?? 0,
          rejected: countsMap.get('REJECTED') ?? 0,
        },
        filters: {
          states: states.map((s) => s.state),
          cities: cities.map((c) => c.city),
        },
      });
    },
  );

  router.get(
    '/admin/registrations/:id',
    requireAuth,
    requirePermission('can_view_registrations'),
    async (req: AuthenticatedRequest, res: Response) => {
      const id = Number(req.params['id']);
      const row = await queryOne<Record<string, unknown>>(
        `SELECT ur.*, ua.email, ua.mobile, ua.is_active, ua.is_mobile_verified
         FROM user_records ur
         JOIN user_accounts ua ON ua.id = ur.user_id
         WHERE ur.id = ? AND ur.deleted_at IS NULL`,
        [id],
      );

      if (!row) {
        res.status(404).json({error: 'Registration record not found.'});
        return;
      }

      const history = await queryRows(
        `SELECT rr.*, ap.full_name as admin_name
         FROM registration_requests rr
         LEFT JOIN admin_profiles ap ON ap.user_id = rr.processed_by
         WHERE rr.user_record_id = ?
         ORDER BY rr.id DESC`,
        [id],
      );

      const qrs = await queryRows(
        `SELECT id, token_prefix, status, issued_at, expires_at, revoked_at, revoke_reason, scan_count, last_verified_at
         FROM qr_codes WHERE user_record_id = ? ORDER BY id DESC`,
        [id],
      );

      res.json({
        record: {
          ...row,
          dob: toMysqlDate(row['dob']) || '',
          dynamicFields: parseJsonSafe<Record<string, unknown>>(row['dynamic_fields_json'], {}),
        },
        history,
        qrs,
      });
    },
  );

  // Approve registration + Atomic QR Generation
  router.post(
    '/admin/registrations/:id/approve',
    requireAuth,
    requirePermission('can_approve_registrations'),
    async (req: AuthenticatedRequest, res: Response) => {
      const id = Number(req.params['id']);
      const adminId = req.auth!.sub;
      const adminEmail = req.auth!.email;

      const record = await queryOne<{
        id: number;
        user_id: number;
        registration_id: string;
        full_name: string;
        email: string;
        approval_status: string;
      }>(
        `SELECT ur.*, ua.email FROM user_records ur
         JOIN user_accounts ua ON ua.id = ur.user_id
         WHERE ur.id = ? AND ur.deleted_at IS NULL`,
        [id],
      );

      if (!record) {
        res.status(404).json({error: 'Registration not found.'});
        return;
      }

      const existingActiveQr = await queryOne(
        "SELECT id FROM qr_codes WHERE user_record_id = ? AND status = 'ACTIVE'",
        [record.id],
      );

      if (record.approval_status === 'APPROVED' && existingActiveQr) {
        res.status(409).json({error: 'Application is already approved with an active QR code.'});
        return;
      }

      const nowMysql = toMysqlDateTime();
      await withTransaction(async (tx) => {
        await tx.executeSql(
          `UPDATE user_records
           SET approval_status = 'APPROVED', rejection_reason = NULL, resubmission_note = NULL,
               reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ?`,
          [adminId, nowMysql, nowMysql, record.id],
        );

        await tx.executeSql(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
           VALUES (?, 'INITIAL', 'APPROVED', ?, ?, ?, ?)`,
          [record.id, String(req.body?.note || 'Approved by administrator.'), nowMysql, adminId, nowMysql],
        );
      });

      try {
        const qr = await generateAndSaveQr(record.id, adminId, getBaseUrl(req));

        await createNotification({
          recipientUserId: record.user_id,
          type: 'REGISTRATION_APPROVED',
          title: 'Application Approved',
          message: `Your registration (${record.registration_id}) has been approved.`,
          linkPath: '/user/home',
          metadata: {registrationId: record.registration_id},
        });

        await createNotification({
          recipientUserId: record.user_id,
          type: 'QR_GENERATED',
          title: 'Active QR Credential Ready',
          message: `Your cryptographic QR credential and ID card are now ready for download.`,
          linkPath: '/user/qr-card',
          metadata: {registrationId: record.registration_id, tokenPrefix: qr.tokenPrefix},
        });

        await writeAuditLog(
          {id: adminId, email: adminEmail, role: req.auth!.role},
          'REGISTRATION_APPROVED_AND_QR_ISSUED',
          'USER_RECORD',
          record.id,
          {registrationId: record.registration_id, qrId: qr.id, tokenPrefix: qr.tokenPrefix},
          req.ip,
        );

        res.json({
          success: true,
          status: 'APPROVED',
          qr: {
            id: qr.id,
            tokenPrefix: qr.tokenPrefix,
            status: qr.status,
            issuedAt: qr.issuedAt,
            expiresAt: qr.expiresAt,
          },
        });
      } catch (err) {
        res.status(500).json({
          error:
            'Application marked APPROVED, but QR generation encountered an error. You may safely retry QR issuance.',
          recoverable: true,
          details: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    },
  );

  router.post(
    '/admin/registrations/:id/reject',
    requireAuth,
    requirePermission('can_approve_registrations'),
    async (req: AuthenticatedRequest, res: Response) => {
      const id = Number(req.params['id']);
      const reason = String(req.body?.reason || '').trim();
      if (!reason) {
        res.status(400).json({error: 'A rejection reason is required.'});
        return;
      }

      const record = await queryOne<{
        id: number;
        user_id: number;
        registration_id: string;
        full_name: string;
      }>('SELECT id, user_id, registration_id, full_name FROM user_records WHERE id = ? AND deleted_at IS NULL', [
        id,
      ]);

      if (!record) {
        res.status(404).json({error: 'Registration not found.'});
        return;
      }

      const nowMysql = toMysqlDateTime();
      await withTransaction(async (tx) => {
        await tx.executeSql(
          `UPDATE user_records
           SET approval_status = 'REJECTED', rejection_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ?`,
          [reason, req.auth!.sub, nowMysql, nowMysql, record.id],
        );

        await tx.executeSql(
          `UPDATE qr_codes
           SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, revoke_reason = 'Application rejected'
           WHERE user_record_id = ? AND status = 'ACTIVE'`,
          [nowMysql, req.auth!.sub, record.id],
        );

        await tx.executeSql(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
           VALUES (?, 'INITIAL', 'REJECTED', ?, ?, ?, ?)`,
          [record.id, reason, nowMysql, req.auth!.sub, nowMysql],
        );
      });

      await createNotification({
        recipientUserId: record.user_id,
        type: 'REGISTRATION_REJECTED',
        title: 'Application Rejected',
        message: reason,
        linkPath: '/user/home',
        metadata: {registrationId: record.registration_id},
      });

      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'REGISTRATION_REJECTED',
        'USER_RECORD',
        record.id,
        {registrationId: record.registration_id, reason},
        req.ip,
      );

      res.json({success: true, status: 'REJECTED'});
    },
  );

  router.post(
    '/admin/registrations/:id/request-resubmission',
    requireAuth,
    requirePermission('can_approve_registrations'),
    async (req: AuthenticatedRequest, res: Response) => {
      const id = Number(req.params['id']);
      const note = String(req.body?.note || '').trim();
      if (!note) {
        res.status(400).json({error: 'Correction instructions are required for resubmission.'});
        return;
      }

      const record = await queryOne<{
        id: number;
        user_id: number;
        registration_id: string;
      }>('SELECT id, user_id, registration_id FROM user_records WHERE id = ? AND deleted_at IS NULL', [
        id,
      ]);

      if (!record) {
        res.status(404).json({error: 'Registration not found.'});
        return;
      }

      const nowMysql = toMysqlDateTime();
      await withTransaction(async (tx) => {
        await tx.executeSql(
          `UPDATE user_records
           SET approval_status = 'RESUBMISSION_REQUIRED', resubmission_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ?`,
          [note, req.auth!.sub, nowMysql, nowMysql, record.id],
        );

        await tx.executeSql(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
           VALUES (?, 'INITIAL', 'RESUBMISSION_REQUIRED', ?, ?, ?, ?)`,
          [record.id, note, nowMysql, req.auth!.sub, nowMysql],
        );
      });

      await createNotification({
        recipientUserId: record.user_id,
        type: 'RESUBMISSION_REQUIRED',
        title: 'Resubmission Required',
        message: note,
        linkPath: '/user/profile',
        metadata: {registrationId: record.registration_id},
      });

      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'RESUBMISSION_REQUESTED',
        'USER_RECORD',
        record.id,
        {registrationId: record.registration_id, note},
        req.ip,
      );

      res.json({success: true, status: 'RESUBMISSION_REQUIRED'});
    },
  );

  // User Management
  router.get(
    '/admin/users',
    requireAuth,
    requirePermission('can_view_registrations'),
    async (req: AuthenticatedRequest, res: Response) => {
      const search = String(req.query['search'] || '').trim().toLowerCase();
      const rows = await queryRows<Record<string, unknown>>(
        `SELECT ua.id as account_id, ua.email, ua.mobile, ua.is_active, ua.is_mobile_verified, ua.created_at as account_created_at,
                ur.id as record_id, ur.registration_id, ur.full_name, ur.city, ur.state, ur.country, ur.approval_status, ur.profile_photo_url
         FROM user_accounts ua
         JOIN user_records ur ON ur.user_id = ua.id
         WHERE ua.role = 'USER' AND ua.deleted_at IS NULL
         ORDER BY ua.id DESC`,
      );

      const filtered = search
        ? rows.filter(
            (r) =>
              String(r['full_name']).toLowerCase().includes(search) ||
              String(r['email']).toLowerCase().includes(search) ||
              String(r['registration_id']).toLowerCase().includes(search) ||
              String(r['mobile']).includes(search),
          )
        : rows;

      res.json({users: filtered});
    },
  );

  router.patch(
    '/admin/users/:accountId/status',
    requireAuth,
    requirePermission('can_manage_users'),
    async (req: AuthenticatedRequest, res: Response) => {
      const accountId = Number(req.params['accountId']);
      const isActive = Boolean(req.body?.isActive);
      const target = await queryOne<{id: number; email: string}>(
        "SELECT id, email FROM user_accounts WHERE id = ? AND role = 'USER'",
        [accountId],
      );
      if (!target) {
        res.status(404).json({error: 'User account not found.'});
        return;
      }

      await executeSql('UPDATE user_accounts SET is_active = ?, updated_at = ? WHERE id = ?', [
        isActive ? 1 : 0,
        toMysqlDateTime(),
        accountId,
      ]);

      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
        'USER_ACCOUNT',
        accountId,
        {targetEmail: target.email},
        req.ip,
      );

      res.json({success: true, isActive});
    },
  );

  // QR Management
  router.get(
    '/admin/qrs',
    requireAuth,
    requirePermission('can_manage_qr'),
    async (_req: AuthenticatedRequest, res: Response) => {
      await executeSql(`UPDATE qr_codes SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ?`, [
        toMysqlDateTime(),
      ]);

      const qrs = await queryRows(
        `SELECT q.id, q.user_record_id, q.token_prefix, q.verification_url, q.qr_png_data_url, q.status,
                q.issued_at, q.expires_at, q.revoked_at, q.revoke_reason, q.last_verified_at, q.scan_count,
                ur.registration_id, ur.full_name, ur.city, ur.state, ur.approval_status, ur.profile_photo_url,
                ua.email, ua.is_active
         FROM qr_codes q
         JOIN user_records ur ON ur.id = q.user_record_id
         JOIN user_accounts ua ON ua.id = ur.user_id
         ORDER BY q.id DESC`,
      );

      res.json({qrs});
    },
  );

  router.post(
    '/admin/qrs/generate/:userRecordId',
    requireAuth,
    requirePermission('can_manage_qr'),
    async (req: AuthenticatedRequest, res: Response) => {
      const userRecordId = Number(req.params['userRecordId']);
      const record = await queryOne<{
        id: number;
        user_id: number;
        registration_id: string;
        approval_status: string;
      }>('SELECT id, user_id, registration_id, approval_status FROM user_records WHERE id = ? AND deleted_at IS NULL', [
        userRecordId,
      ]);

      if (!record) {
        res.status(404).json({error: 'User record not found.'});
        return;
      }
      if (record.approval_status !== 'APPROVED') {
        res.status(400).json({error: 'Only APPROVED users can receive active QR codes.'});
        return;
      }

      const qr = await generateAndSaveQr(record.id, req.auth!.sub, getBaseUrl(req));
      await createNotification({
        recipientUserId: record.user_id,
        type: 'QR_GENERATED',
        title: 'New QR Credential Issued',
        message: `A new active QR credential (${qr.tokenPrefix}...) has been issued for ${record.registration_id}.`,
        linkPath: '/user/qr-card',
      });
      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'QR_GENERATED',
        'QR_CODE',
        qr.id,
        {registrationId: record.registration_id, tokenPrefix: qr.tokenPrefix},
        req.ip,
      );

      res.status(201).json({qr});
    },
  );

  router.post(
    '/admin/qrs/:id/revoke',
    requireAuth,
    requirePermission('can_manage_qr'),
    async (req: AuthenticatedRequest, res: Response) => {
      const qrId = Number(req.params['id']);
      const reason = String(req.body?.reason || 'Revoked by administrator').trim();
      const qr = await queryOne<{
        id: number;
        user_id: number;
        registration_id: string;
        token_prefix: string;
        status: string;
      }>(
        `SELECT q.*, ur.user_id, ur.registration_id
         FROM qr_codes q
         JOIN user_records ur ON ur.id = q.user_record_id
         WHERE q.id = ?`,
        [qrId],
      );

      if (!qr) {
        res.status(404).json({error: 'QR code not found.'});
        return;
      }

      await executeSql(
        `UPDATE qr_codes SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?`,
        [toMysqlDateTime(), req.auth!.sub, reason, qrId],
      );

      await createNotification({
        recipientUserId: qr.user_id,
        type: 'QR_REVOKED',
        title: 'QR Credential Revoked',
        message: `Your QR credential for ${qr.registration_id} was revoked. Reason: ${reason}`,
        linkPath: '/user/qr-card',
      });

      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'QR_REVOKED',
        'QR_CODE',
        qrId,
        {registrationId: qr.registration_id, reason},
        req.ip,
      );

      res.json({success: true});
    },
  );

  router.post(
    '/admin/qrs/:id/regenerate',
    requireAuth,
    requirePermission('can_manage_qr'),
    async (req: AuthenticatedRequest, res: Response) => {
      const qrId = Number(req.params['id']);
      const existing = await queryOne<{
        user_record_id: number;
        user_id: number;
        registration_id: string;
        approval_status: string;
      }>(
        `SELECT q.user_record_id, ur.user_id, ur.registration_id, ur.approval_status
         FROM qr_codes q
         JOIN user_records ur ON ur.id = q.user_record_id
         WHERE q.id = ?`,
        [qrId],
      );

      if (!existing) {
        res.status(404).json({error: 'QR code not found.'});
        return;
      }
      if (existing.approval_status !== 'APPROVED') {
        res.status(400).json({error: 'Cannot regenerate QR for an unapproved user.'});
        return;
      }

      await executeSql(
        `UPDATE qr_codes SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, revoke_reason = 'Regenerated by administrator' WHERE id = ? AND status = 'ACTIVE'`,
        [toMysqlDateTime(), req.auth!.sub, qrId],
      );

      const newQr = await generateAndSaveQr(existing.user_record_id, req.auth!.sub, getBaseUrl(req));
      await createNotification({
        recipientUserId: existing.user_id,
        type: 'QR_GENERATED',
        title: 'QR Credential Regenerated',
        message: `Your previous QR was retired and a new active QR credential (${newQr.tokenPrefix}...) was issued.`,
        linkPath: '/user/qr-card',
      });
      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'QR_REGENERATED',
        'QR_CODE',
        newQr.id,
        {previousQrId: qrId, registrationId: existing.registration_id},
        req.ip,
      );

      res.json({qr: newQr});
    },
  );

  // Admin-Only QR Verification Scanner Endpoint
  router.post(
    '/admin/verify-qr',
    requireAuth,
    requirePermission('can_scan_qr'),
    rateLimit('verify_qr', 120, 60 * 1000),
    async (req: AuthenticatedRequest, res: Response) => {
      const rawPayload = String(req.body?.payload || '').trim();
      if (!rawPayload) {
        res.status(400).json({error: 'QR token or verification URL payload is required.'});
        return;
      }

      const rawToken = extractTokenFromInput(rawPayload);
      const tokenHash = sha256Hex(rawToken);
      const tokenPrefix = tokenHash.slice(0, 12);
      const now = new Date();
      const nowIso = now.toISOString();
      const nowMysql = toMysqlDateTime(now);

      const qr = await queryOne<Record<string, unknown>>(
        `SELECT q.*, ur.id as ur_id, ur.registration_id, ur.full_name, ur.profile_photo_url, ur.city, ur.state,
                ur.country, ur.approval_status, ur.dynamic_fields_json, ur.id_proof_type,
                ua.email, ua.mobile, ua.is_active, ua.deleted_at
         FROM qr_codes q
         JOIN user_records ur ON ur.id = q.user_record_id
         JOIN user_accounts ua ON ua.id = ur.user_id
         WHERE q.token_hash = ?`,
        [tokenHash],
      );

      if (!qr) {
        await executeSql(
          `INSERT INTO qr_scan_logs
            (qr_code_id, user_record_id, scanned_by_admin_id, scanned_token_prefix, result_status, reason, ip_address, user_agent, scanned_at)
           VALUES (NULL, NULL, ?, ?, 'INVALID', 'No matching QR credential hash found.', ?, ?, ?)`,
          [
            req.auth!.sub,
            tokenPrefix,
            req.ip || null,
            String(req.headers['user-agent'] || ''),
            nowMysql,
          ],
        );

        res.json({
          resultStatus: 'INVALID',
          label: 'INVALID QR',
          reason: 'Token signature not recognized in the verification registry.',
          holder: null,
        });
        return;
      }

      // Duplicate scan prevention (10s window per admin + QR)
      const recentScan = await queryOne<{id: number; scanned_at: Date | string}>(
        `SELECT id, scanned_at FROM qr_scan_logs
         WHERE qr_code_id = ? AND scanned_by_admin_id = ? AND scanned_at >= ?
         ORDER BY id DESC LIMIT 1`,
        [qr['id'], req.auth!.sub, toMysqlDateTime(now.getTime() - 10_000)],
      );

      let resultStatus: 'VALID' | 'EXPIRED' | 'REVOKED' | 'INACTIVE_USER' | 'UNAPPROVED_USER' = 'VALID';
      let label = 'VALID QR';
      let reason = 'Cryptographic token valid, active, and holder approved.';

      if (qr['status'] === 'REVOKED') {
        resultStatus = 'REVOKED';
        label = 'REVOKED QR';
        reason = String(qr['revoke_reason'] || 'Credential was revoked by an administrator.');
      } else if (
        qr['status'] === 'EXPIRED' ||
        new Date(qr['expires_at'] as Date | string).getTime() <= now.getTime()
      ) {
        resultStatus = 'EXPIRED';
        label = 'EXPIRED QR';
        reason = `Credential expired on ${new Date(qr['expires_at'] as Date | string).toISOString()}.`;
        if (qr['status'] === 'ACTIVE') {
          await executeSql("UPDATE qr_codes SET status = 'EXPIRED' WHERE id = ?", [qr['id']]);
        }
      } else if (!qr['is_active'] || qr['deleted_at']) {
        resultStatus = 'INACTIVE_USER';
        label = 'INACTIVE USER';
        reason = 'Holder user account is deactivated or archived.';
      } else if (qr['approval_status'] !== 'APPROVED') {
        resultStatus = 'UNAPPROVED_USER';
        label = 'INACTIVE USER';
        reason = `Holder application status is ${String(qr['approval_status'])}.`;
      }

      if (!recentScan) {
        await executeSql(
          `INSERT INTO qr_scan_logs
            (qr_code_id, user_record_id, scanned_by_admin_id, scanned_token_prefix, result_status, reason, ip_address, user_agent, scanned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            qr['id'],
            qr['ur_id'],
            req.auth!.sub,
            tokenPrefix,
            resultStatus,
            reason,
            req.ip || null,
            String(req.headers['user-agent'] || ''),
            nowMysql,
          ],
        );

        if (resultStatus === 'VALID') {
          await executeSql('UPDATE qr_codes SET last_verified_at = ?, scan_count = scan_count + 1 WHERE id = ?', [
            nowMysql,
            qr['id'],
          ]);
        }
      }

      res.json({
        resultStatus,
        label,
        reason,
        duplicatePrevented: Boolean(recentScan),
        scannedAt: nowIso,
        identityComparisonNotice:
          'Physical Identity Check Required: Compare the registered photograph and government ID below with the person presenting this QR.',
        qr: {
          id: qr['id'],
          tokenPrefix,
          issuedAt: qr['issued_at'],
          expiresAt: qr['expires_at'],
          scanCount: Number(qr['scan_count']) + (recentScan || resultStatus !== 'VALID' ? 0 : 1),
        },
        holder: {
          userRecordId: qr['ur_id'],
          registrationId: qr['registration_id'],
          fullName: qr['full_name'],
          email: qr['email'],
          mobile: qr['mobile'],
          city: qr['city'],
          state: qr['state'],
          country: qr['country'],
          profilePhotoUrl: qr['profile_photo_url'],
          idProofType: qr['id_proof_type'],
          approvalStatus: qr['approval_status'],
          dynamicFields: parseJsonSafe<Record<string, unknown>>(qr['dynamic_fields_json'], {}),
        },
      });
    },
  );

  router.get(
    '/admin/scan-logs',
    requireAuth,
    requirePermission('can_scan_qr'),
    async (_req: AuthenticatedRequest, res: Response) => {
      const logs = await queryRows(
        `SELECT sl.*, ur.full_name as holder_name, ur.registration_id, ap.full_name as scanner_name
         FROM qr_scan_logs sl
         LEFT JOIN user_records ur ON ur.id = sl.user_record_id
         LEFT JOIN admin_profiles ap ON ap.user_id = sl.scanned_by_admin_id
         ORDER BY sl.id DESC LIMIT 100`,
      );
      res.json({logs});
    },
  );

  // Admin Notifications
  router.get('/admin/notifications', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
    const items = await queryRows(
      `SELECT * FROM notifications
       WHERE recipient_role IN ('ADMIN', 'SUPER_ADMIN')
       ORDER BY id DESC LIMIT 100`,
    );
    res.json({notifications: items});
  });

  router.post('/admin/notifications/:id/read', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
    await executeSql('UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ?', [
      toMysqlDateTime(),
      Number(req.params['id']),
    ]);
    res.json({success: true});
  });

  router.post('/admin/notifications/read-all', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
    await executeSql(
      "UPDATE notifications SET is_read = 1, read_at = ? WHERE recipient_role IN ('ADMIN', 'SUPER_ADMIN') AND is_read = 0",
      [toMysqlDateTime()],
    );
    res.json({success: true});
  });

  // Excel Export (.xlsx via ExcelJS)
  router.get(
    '/admin/export/excel',
    requireAuth,
    requirePermission('can_export_excel'),
    async (req: AuthenticatedRequest, res: Response) => {
      const status = String(req.query['status'] || '').trim();
      const state = String(req.query['state'] || '').trim();
      const city = String(req.query['city'] || '').trim();
      const dateFrom = String(req.query['dateFrom'] || '').trim();
      const dateTo = String(req.query['dateTo'] || '').trim();

      const {buffer, recordCount, filename} = await buildVerifiedUsersWorkbook({
        status,
        state,
        city,
        dateFrom,
        dateTo,
      });

      await executeSql(
        `INSERT INTO export_history (admin_user_id, admin_email, filters_json, record_count, filename, exported_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          req.auth!.sub,
          req.auth!.email,
          JSON.stringify({status, state, city, dateFrom, dateTo}),
          recordCount,
          filename,
          toMysqlDateTime(),
        ],
      );

      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'EXCEL_EXPORTED',
        'EXPORT',
        filename,
        {recordCount, filters: {status, state, city, dateFrom, dateTo}},
        req.ip,
      );

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    },
  );

  router.get(
    '/admin/export/history',
    requireAuth,
    requirePermission('can_export_excel'),
    async (_req: AuthenticatedRequest, res: Response) => {
      const history = await queryRows('SELECT * FROM export_history ORDER BY id DESC LIMIT 50');
      res.json({history});
    },
  );

  router.post(
    '/admin/export/send-email-now',
    requireAuth,
    requirePermission('can_export_excel'),
    async (req: AuthenticatedRequest, res: Response) => {
      const result = await sendDailyVerificationExcelReport('MANUAL');
      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'DAILY_EXCEL_EMAIL_TRIGGERED',
        'REPORT',
        result.filename,
        {
          recipient: result.recipient,
          recordCount: result.recordCount,
          success: result.success,
          error: result.error || null,
        },
        req.ip,
      );
      res.json(result);
    },
  );

  router.get(
    '/admin/export/scheduled-logs',
    requireAuth,
    requirePermission('can_export_excel'),
    async (_req: AuthenticatedRequest, res: Response) => {
      const logs = await queryRows('SELECT * FROM scheduled_report_logs ORDER BY id DESC LIMIT 30');
      const emailCfg = await getEffectiveEmailDeliveryConfig();
      res.json({
        recipientEmail:
          getEnvValue('DAILY_REPORT_RECIPIENT_EMAIL') ||
          getEnvValue('FIXED_ADMIN_EMAIL') ||
          'kishore.sathayush@gmail.com',
        scheduleIntervalHours: 24,
        smtpConfigured: emailCfg.configured,
        emailDeliveryMode: emailCfg.mode,
        logs,
      });
    },
  );

  // Admin Management (Super Admin only)
  router.get('/admin/admins', requireAuth, requireSuperAdmin, async (_req: AuthenticatedRequest, res: Response) => {
    const admins = await queryRows<Record<string, unknown>>(
      `SELECT ua.id, ua.email, ua.mobile, ua.role, ua.is_active, ua.created_at,
              ap.full_name, ap.department, ap.designation, ap.permissions_json, ap.avatar_url
       FROM user_accounts ua
       JOIN admin_profiles ap ON ap.user_id = ua.id
       WHERE ua.role IN ('ADMIN', 'SUPER_ADMIN') AND ua.deleted_at IS NULL
       ORDER BY ua.id ASC`,
    );

    const availablePermissions = await queryRows('SELECT * FROM permissions ORDER BY id ASC');

    res.json({
      admins: admins.map((a) => ({
        ...a,
        permissions: parseJsonSafe<string[]>(a['permissions_json'], []),
      })),
      availablePermissions,
    });
  });

  router.post('/admin/admins', requireAuth, requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const mobile = String(b.mobile || '').trim();
    const fullName = String(b.fullName || '').trim();
    const department = String(b.department || 'Verification Operations').trim();
    const designation = String(b.designation || 'Verification Officer').trim();
    const password = String(b.password || '');
    const permissions = Array.isArray(b.permissions) ? b.permissions : [];

    if (!email || !mobile || !fullName || password.length < 8) {
      res.status(400).json({error: 'Full name, email, mobile, and password (8+ chars) are required.'});
      return;
    }

    const existing = await queryOne(
      'SELECT id FROM user_accounts WHERE LOWER(email) = ? OR mobile = ?',
      [email, mobile],
    );
    if (existing) {
      res.status(409).json({error: 'Email or mobile already exists.'});
      return;
    }

    const nowMysql = toMysqlDateTime();
    const newId = await withTransaction(async (tx) => {
      const u = await tx.executeSql(
        `INSERT INTO user_accounts
          (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
         VALUES (?, ?, ?, 'ADMIN', 1, 1, ?, ?)`,
        [email, mobile, hashPassword(password), nowMysql, nowMysql],
      );
      const id = Number(u.insertId);
      await tx.executeSql(
        `INSERT INTO admin_profiles
          (user_id, full_name, department, designation, permissions_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, fullName, department, designation, JSON.stringify(permissions), req.auth!.sub, nowMysql],
      );
      return id;
    });

    await writeAuditLog(
      {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
      'ADMIN_ACCOUNT_CREATED',
      'ADMIN_USER',
      newId,
      {email, permissions},
      req.ip,
    );

    res.status(201).json({success: true, id: newId});
  });

  router.patch('/admin/admins/:id', requireAuth, requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const id = Number(req.params['id']);
    if (id === req.auth!.sub && req.body?.isActive === false) {
      res.status(400).json({error: 'You cannot deactivate your own active Super Admin account.'});
      return;
    }

    const existing = await queryOne<{id: number; email: string; role: string}>(
      'SELECT id, email, role FROM user_accounts WHERE id = ?',
      [id],
    );
    if (!existing) {
      res.status(404).json({error: 'Admin account not found.'});
      return;
    }

    const nowMysql = toMysqlDateTime();
    if (typeof req.body?.isActive === 'boolean') {
      await executeSql('UPDATE user_accounts SET is_active = ?, updated_at = ? WHERE id = ?', [
        req.body.isActive ? 1 : 0,
        nowMysql,
        id,
      ]);
    }
    if (Array.isArray(req.body?.permissions) && existing.role === 'ADMIN') {
      await executeSql('UPDATE admin_profiles SET permissions_json = ? WHERE user_id = ?', [
        JSON.stringify(req.body.permissions),
        id,
      ]);
    }

    await writeAuditLog(
      {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
      'ADMIN_PERMISSIONS_UPDATED',
      'ADMIN_USER',
      id,
      {targetEmail: existing.email, body: req.body},
      req.ip,
    );

    res.json({success: true});
  });

  // Audit Logs (Super Admin only)
  router.get('/admin/audit-logs', requireAuth, requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const action = String(req.query['action'] || '').trim();
    const search = String(req.query['search'] || '').trim().toLowerCase();

    const rows = await queryRows<Record<string, unknown>>(
      'SELECT * FROM admin_activity_logs ORDER BY id DESC LIMIT 250',
    );

    const filtered = rows.filter((r) => {
      if (action && r['action'] !== action) return false;
      if (search) {
        const detailsStr =
          typeof r['details_json'] === 'string'
            ? r['details_json']
            : JSON.stringify(r['details_json'] || {});
        const hay = `${r['actor_email']} ${r['action']} ${r['target_type']} ${detailsStr}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    res.json({logs: filtered});
  });

  // System Settings & Dynamic Field Config (Super Admin only)
  router.get('/admin/settings', requireAuth, requireSuperAdmin, async (_req: AuthenticatedRequest, res: Response) => {
    const settingsRows = await queryRows<{
      key: string;
      value: string;
      updated_at: Date | string;
    }>('SELECT `key` AS `key`, `value` AS `value`, updated_at FROM system_settings');
    const settings: Record<string, string> = {};
    for (const s of settingsRows) {
      if (!EMAIL_SETTINGS_KEYS.has(s.key)) {
        settings[s.key] = s.value;
      }
    }

    const fieldConfigs = await queryRows<Record<string, unknown>>(
      'SELECT * FROM user_field_configs ORDER BY sort_order ASC, id ASC',
    );

    res.json({
      settings,
      fieldConfigs: fieldConfigs.map((f) => ({
        ...f,
        options: parseJsonSafe<string[]>(f['options_json'], []),
      })),
    });
  });

  // Admin-only connectivity check for AWS RDS MySQL & active Email Provider
  router.get(
    '/admin/health',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const [mysqlStatus, emailHealth] = await Promise.all([
        checkMysqlConnection(),
        checkEmailProviderHealth(),
      ]);
      const ok = Boolean(mysqlStatus.connected && emailHealth.healthy);
      const strict = String(req.query['strict'] || '').toLowerCase() === 'true';
      res.status(strict && !ok ? 503 : 200).json({
        ok,
        database: mysqlStatus,
        email: emailHealth,
        checkedAt: new Date().toISOString(),
      });
    },
  );

  router.get(
    '/admin/settings/db-status',
    requireAuth,
    requireSuperAdmin,
    async (_req: AuthenticatedRequest, res: Response) => {
      const [mysqlStatus, emailCfg, emailSummary, emailHealth] = await Promise.all([
        checkMysqlConnection(),
        getEffectiveEmailDeliveryConfig(),
        getEmailSettingsMaskedSummary(),
        checkEmailProviderHealth(),
      ]);
      const cfg = getMysqlConfig();
      res.json({
        database: {
          ...mysqlStatus,
          host: mysqlStatus.host || cfg.host,
          database: mysqlStatus.database || cfg.database,
        },
        integrations: {
          smtpConfigured: emailCfg.configured,
          emailOtpConfigured: emailCfg.configured,
          emailDeliveryMode: emailCfg.mode,
          emailConfigSource: emailCfg.configSource,
          smtpHost: emailCfg.smtpHost,
          smtpUser: emailCfg.defaultFromEmail || 'kishore.sathayush@gmail.com',
          dailyReportRecipient:
            getEnvValue('DAILY_REPORT_RECIPIENT_EMAIL') ||
            getEnvValue('FIXED_ADMIN_EMAIL') ||
            'kishore.sathayush@gmail.com',
          s3Configured: Boolean(
            getEnvValue('AWS_ACCESS_KEY_ID') &&
              getEnvValue('AWS_SECRET_ACCESS_KEY') &&
              getEnvValue('AWS_STORAGE_BUCKET_NAME'),
          ),
          s3Bucket: getEnvValue('AWS_STORAGE_BUCKET_NAME'),
          s3Region: getEnvValue('AWS_S3_REGION_NAME'),
          filePath: getEnvValue('FILE_PATH') || getEnvValue('File_path'),
          fixedAdminEmail: getEnvValue('FIXED_ADMIN_EMAIL') || 'kishore.sathayush@gmail.com',
        },
        emailSettings: emailSummary,
        emailHealth,
      });
    },
  );

  router.post(
    '/admin/settings/email',
    requireAuth,
    requireSuperAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const b = req.body || {};
      const provider = String(b.provider || '').trim();
      if (!['https-webhook', 'brevo-https', 'resend-https', 'gmail-smtp'].includes(provider)) {
        res.status(400).json({error: 'Select a valid email delivery provider.'});
        return;
      }

      const upsertSetting = async (key: string, value: string): Promise<void> => {
        const nowMysql = toMysqlDateTime();
        await executeSql(
          `INSERT INTO system_settings (\`key\`, \`value\`, updated_at, updated_by)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
          [key, value, nowMysql, req.auth!.sub],
        );
      };

      const defaultFromEmail = String(b.defaultFromEmail || '').trim();
      if (defaultFromEmail && !/^\S+@\S+\.\S+$/.test(defaultFromEmail)) {
        res.status(400).json({error: 'Enter a valid Default From Email address.'});
        return;
      }

      if (provider === 'https-webhook') {
        const webhookUrl = String(b.webhookUrl || '').trim();
        if (!/^https?:\/\/\S+/i.test(webhookUrl)) {
          res.status(400).json({error: 'Enter a valid https:// Apps Script Webhook URL.'});
          return;
        }
        await upsertSetting('email_webhook_url', webhookUrl);
        if (typeof b.webhookSecret === 'string' && b.webhookSecret.trim()) {
          await upsertSetting('email_webhook_secret', b.webhookSecret.trim());
        }
      } else if (provider === 'brevo-https') {
        const existing = await getEmailSettingsMaskedSummary();
        const brevoApiKey = String(b.brevoApiKey || '').trim();
        if (!brevoApiKey && !existing.hasBrevoKey) {
          res.status(400).json({error: 'Enter your Brevo API Key.'});
          return;
        }
        if (brevoApiKey) {
          await upsertSetting('brevo_api_key', brevoApiKey);
        }
      } else if (provider === 'resend-https') {
        const existing = await getEmailSettingsMaskedSummary();
        const resendApiKey = String(b.resendApiKey || '').trim();
        if (!resendApiKey && !existing.hasResendKey) {
          res.status(400).json({error: 'Enter your Resend API Key.'});
          return;
        }
        if (resendApiKey) {
          await upsertSetting('resend_api_key', resendApiKey);
        }
        if (typeof b.resendFromEmail === 'string') {
          await upsertSetting('resend_from_email', b.resendFromEmail.trim());
        }
      } else if (provider === 'gmail-smtp') {
        const existing = await getEmailSettingsMaskedSummary();
        const smtpHost = String(b.smtpHost || 'smtp.gmail.com').trim() || 'smtp.gmail.com';
        const smtpPort = Number.parseInt(String(b.smtpPort || '587'), 10) || 587;
        const smtpUseTls = b.smtpUseTls !== false ? 'True' : 'False';
        const smtpUser = String(b.smtpUser || '').trim();
        const smtpPassword = String(b.smtpPassword || '').trim();
        if (!smtpUser) {
          res.status(400).json({error: 'SMTP username / Gmail address is required.'});
          return;
        }
        if (!smtpPassword && !existing.hasSmtpPassword) {
          res.status(400).json({error: 'SMTP App Password is required.'});
          return;
        }
        await upsertSetting('smtp_host', smtpHost);
        await upsertSetting('smtp_port', String(smtpPort));
        await upsertSetting('smtp_use_tls', smtpUseTls);
        await upsertSetting('smtp_user', smtpUser);
        if (smtpPassword) {
          await upsertSetting('smtp_password', smtpPassword);
        }
      }

      if (defaultFromEmail) {
        await upsertSetting('default_from_email', defaultFromEmail);
      }
      await upsertSetting('email_preferred_provider', provider);

      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'EMAIL_SETTINGS_UPDATED',
        'SETTINGS',
        'email_delivery',
        {provider, defaultFromEmail: defaultFromEmail || null},
        req.ip,
      );

      const summary = await getEmailSettingsMaskedSummary();
      res.json({success: true, emailSettings: summary});
    },
  );

  router.post(
    '/admin/settings/email/test',
    requireAuth,
    requireSuperAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const rawTarget = String(req.body?.recipientEmail || '').trim().toLowerCase();
      const targetEmail =
        rawTarget ||
        getEnvValue('FIXED_ADMIN_EMAIL') ||
        req.auth!.email;
      if (!/^\S+@\S+\.\S+$/.test(targetEmail)) {
        res.status(400).json({error: 'Enter a valid recipient email address for the test.'});
        return;
      }

      const result = await sendTestEmail(targetEmail);
      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'EMAIL_TEST_DISPATCHED',
        'SETTINGS',
        targetEmail,
        {success: result.success, provider: result.provider, error: result.error || null},
        req.ip,
      );

      res.json(result);
    },
  );

  router.post(
    '/admin/settings/database',
    requireAuth,
    requireSuperAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const b = req.body || {};
      const result = await connectLiveMysqlRuntime({
        host: String(b.host || ''),
        port: Number(b.port || 3306),
        user: String(b.user || ''),
        password: String(b.password || ''),
        database: String(b.database || 'secure_qr_verification'),
        ssl: b.ssl !== false,
        awsAccessKeyId: typeof b.awsAccessKeyId === 'string' ? b.awsAccessKeyId : undefined,
        awsSecretAccessKey:
          typeof b.awsSecretAccessKey === 'string' ? b.awsSecretAccessKey : undefined,
        awsRegion: typeof b.awsRegion === 'string' ? b.awsRegion : undefined,
        awsBucket: typeof b.awsBucket === 'string' ? b.awsBucket : undefined,
        filePath: typeof b.filePath === 'string' ? b.filePath : undefined,
      });

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      // Refresh Super Admin JWT/session against the live RDS user_accounts table
      const liveAccount = await queryOne<{
        id: number;
        email: string;
        mobile: string;
        role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
      }>(
        'SELECT id, email, mobile, role FROM user_accounts WHERE LOWER(email) = ? AND deleted_at IS NULL',
        [req.auth!.email.toLowerCase()],
      );

      let refreshedSession:
        | {accessToken: string; refreshToken: string; user: Record<string, unknown>}
        | undefined;
      if (liveAccount) {
        const allPerms = [
          'can_view_registrations',
          'can_approve_registrations',
          'can_manage_qr',
          'can_scan_qr',
          'can_export_excel',
          'can_manage_users',
        ];
        const accessToken = signAccessToken(
          {
            sub: liveAccount.id,
            email: liveAccount.email,
            role: liveAccount.role,
            permissions: allPerms,
          },
          3600,
        );
        const refreshToken = generateRefreshToken();
        const now = new Date();
        await executeSql(
          `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?)`,
          [
            liveAccount.id,
            sha256Hex(refreshToken),
            toMysqlDateTime(now.getTime() + 7 * 86400000),
            toMysqlDateTime(now),
          ],
        );
        const profile = await queryOne<{full_name: string; avatar_url: string}>(
          'SELECT full_name, avatar_url FROM admin_profiles WHERE user_id = ?',
          [liveAccount.id],
        );
        refreshedSession = {
          accessToken,
          refreshToken,
          user: {
            id: liveAccount.id,
            email: liveAccount.email,
            mobile: liveAccount.mobile,
            role: liveAccount.role,
            permissions: allPerms,
            displayName: profile?.full_name || liveAccount.email,
            avatarUrl:
              profile?.avatar_url || '/assets/images/avatar_admin_portrait_1794911291825.jpg',
            registrationId: null,
            approvalStatus: null,
          },
        };
      }

      await writeAuditLog(
        {
          id: liveAccount?.id ?? req.auth!.sub,
          email: req.auth!.email,
          role: liveAccount?.role ?? req.auth!.role,
        },
        'MYSQL_RDS_RUNTIME_CONNECTED',
        'DATABASE',
        result.database,
        {host: result.host, database: result.database},
        req.ip,
      );

      res.json({
        ...result,
        ...(refreshedSession || {}),
      });
    },
  );

  router.post(
    '/admin/settings/init-mysql',
    requireAuth,
    requireSuperAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const result = await ensureMysqlDatabaseAndSchema();
      await writeAuditLog(
        {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
        'MYSQL_RDS_SCHEMA_INIT',
        'DATABASE',
        result.database,
        {success: result.success, host: result.host, error: result.error || null},
        req.ip,
      );
      res.json(result);
    },
  );

  router.patch('/admin/settings', requireAuth, requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const updates = req.body?.settings;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({error: 'Settings payload required.'});
      return;
    }
    const nowMysql = toMysqlDateTime();
    for (const [k, v] of Object.entries(updates)) {
      if (EMAIL_SETTINGS_KEYS.has(k)) continue;
      await executeSql(
        `INSERT INTO system_settings (\`key\`, \`value\`, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
        [k, String(v), nowMysql, req.auth!.sub],
      );
    }

    await writeAuditLog(
      {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
      'SYSTEM_SETTINGS_UPDATED',
      'SETTINGS',
      'global',
      updates as Record<string, unknown>,
      req.ip,
    );

    res.json({success: true});
  });

  router.post('/admin/field-configs', requireAuth, requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body || {};
    const fieldKey = String(b.fieldKey || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');
    const label = String(b.label || '').trim();
    const fieldType = ['text', 'select', 'date', 'file'].includes(String(b.fieldType))
      ? String(b.fieldType)
      : 'text';
    if (!fieldKey || !label) {
      res.status(400).json({error: 'Field key and label are required.'});
      return;
    }

    const r = await executeSql(
      `INSERT INTO user_field_configs
        (field_key, label, field_type, is_required, is_enabled, is_editable_on_resubmit, options_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fieldKey,
        label,
        fieldType,
        b.isRequired ? 1 : 0,
        b.isEnabled !== false ? 1 : 0,
        b.isEditableOnResubmit !== false ? 1 : 0,
        JSON.stringify(Array.isArray(b.options) ? b.options : []),
        Number(b.sortOrder || 10),
      ],
    );

    res.status(201).json({id: Number(r.insertId)});
  });

  router.patch('/admin/field-configs/:id', requireAuth, requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const id = Number(req.params['id']);
    const b = req.body || {};
    await executeSql(
      `UPDATE user_field_configs
       SET is_required = ?, is_enabled = ?, is_editable_on_resubmit = ?
       WHERE id = ?`,
      [
        b.isRequired ? 1 : 0,
        b.isEnabled ? 1 : 0,
        b.isEditableOnResubmit ? 1 : 0,
        id,
      ],
    );
    res.json({success: true});
  });

  router.delete('/admin/field-configs/:id', requireAuth, requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    await executeSql('DELETE FROM user_field_configs WHERE id = ?', [Number(req.params['id'])]);
    res.json({success: true});
  });

  // OpenAPI 3.0 Spec endpoint
  router.get('/docs', (_req: Request, res: Response) => {
    res.json({
      openapi: '3.0.3',
      info: {
        title: 'Secure QR Verification System API',
        version: '1.0.0',
        description:
          'REST API for user self-registration, OTP verification, admin approval, 256-bit QR issuance, live scanner verification, and Excel export.',
      },
      paths: {
        '/api/v1/auth/register': {post: {summary: 'Submit new user registration with verified email OTP'}},
        '/api/v1/auth/otp/send': {post: {summary: 'Dispatch 6-digit hashed OTP via email'}},
        '/api/v1/auth/otp/verify': {post: {summary: 'Verify 6-digit email OTP'}},
        '/api/v1/auth/password-reset/confirm': {post: {summary: 'Reset password using verified PASSWORD_RESET OTP'}},
        '/api/v1/auth/login': {post: {summary: 'User portal JWT login'}},
        '/api/v1/auth/admin/login': {post: {summary: 'Admin portal JWT login'}},
        '/api/v1/user/dashboard': {get: {summary: 'Retrieve authenticated user application & active QR'}},
        '/api/v1/user/qr/download': {get: {summary: 'Download active QR credential PNG'}},
        '/api/v1/admin/dashboard/stats': {get: {summary: 'Retrieve admin KPI statistics & recent activity'}},
        '/api/v1/admin/registrations': {get: {summary: 'Filterable, paginated registration applications'}},
        '/api/v1/admin/registrations/{id}/approve': {
          post: {summary: 'Approve application and trigger atomic QR issuance'},
        },
        '/api/v1/admin/registrations/{id}/reject': {post: {summary: 'Reject application with mandatory reason'}},
        '/api/v1/admin/verify-qr': {post: {summary: 'Admin-only cryptographic QR verification'}},
        '/api/v1/admin/export/excel': {get: {summary: 'Export filtered records to formatted XLSX'}},
      },
    });
  });

  return router;
}
