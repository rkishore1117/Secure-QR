import express, {type Request, type Response, type NextFunction} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {getDb, getUploadsDir, withTransaction} from './db';
import {buildVerifiedUsersWorkbook} from './excel';
import {dispatchOtpSms} from './sms';
import {sendDailyVerificationExcelReport} from './mailer';
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
  if (process.env['APP_URL'] && process.env['APP_URL'] !== 'MY_APP_URL') {
    return process.env['APP_URL'];
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

function getSetting(key: string, fallback: string): string {
  const row = getDb()
    .prepare('SELECT value FROM system_settings WHERE key = ?')
    .get(key) as {value: string} | undefined;
  return row ? row.value : fallback;
}

function writeAuditLog(
  actor: {id?: number | null; email: string; role: string},
  action: string,
  targetType: string,
  targetId: string | number | null,
  details: Record<string, unknown>,
  ip?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO admin_activity_logs
        (actor_user_id, actor_email, actor_role, action, target_type, target_id, details_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      actor.id ?? null,
      actor.email,
      actor.role,
      action,
      targetType,
      targetId !== null ? String(targetId) : null,
      JSON.stringify(details),
      ip ?? null,
      new Date().toISOString(),
    );
}

function createNotification(params: {
  recipientUserId?: number | null;
  recipientRole?: 'ADMIN' | 'SUPER_ADMIN' | null;
  type: string;
  title: string;
  message: string;
  linkPath?: string;
  metadata?: Record<string, unknown>;
}): void {
  const now = new Date().toISOString();
  const res = getDb()
    .prepare(
      `INSERT INTO notifications
        (recipient_user_id, recipient_role, type, title, message, link_path, metadata_json, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      params.recipientUserId ?? null,
      params.recipientRole ?? null,
      params.type,
      params.title,
      params.message,
      params.linkPath ?? null,
      JSON.stringify(params.metadata ?? {}),
      now,
    );

  const payload = {
    event: 'notification',
    notification: {
      id: Number(res.lastInsertRowid),
      type: params.type,
      title: params.title,
      message: params.message,
      linkPath: params.linkPath ?? null,
      metadata: params.metadata ?? {},
      isRead: false,
      createdAt: now,
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

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
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

  const user = getDb()
    .prepare('SELECT id, email, role, is_active, deleted_at FROM user_accounts WHERE id = ?')
    .get(decoded.sub) as
    | {id: number; email: string; role: 'SUPER_ADMIN' | 'ADMIN' | 'USER'; is_active: number; deleted_at: string | null}
    | undefined;

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
    const adminProfile = getDb()
      .prepare('SELECT permissions_json FROM admin_profiles WHERE user_id = ?')
      .get(user.id) as {permissions_json: string} | undefined;
    permissions = adminProfile ? (JSON.parse(adminProfile.permissions_json) as string[]) : [];
  }

  req.auth = {
    ...decoded,
    role: user.role,
    permissions,
  };
  next();
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
  const validityDays = Number.parseInt(getSetting('qr_validity_days', '365'), 10) || 365;
  const allowMultiple = getSetting('allow_multiple_active_qr', 'false') === 'true';

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
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + validityDays * 86400000).toISOString();

  const qrId = withTransaction((tx) => {
    if (!allowMultiple) {
      tx.prepare(
        `UPDATE qr_codes
         SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, revoke_reason = 'Superseded by newly issued QR credential'
         WHERE user_record_id = ? AND status = 'ACTIVE'`,
      ).run(issuedAt, issuedByAdminId, userRecordId);
    }

    const res = tx
      .prepare(
        `INSERT INTO qr_codes
          (user_record_id, token_hash, token_prefix, verification_url, qr_png_data_url, status, issued_at, expires_at, issued_by)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      )
      .run(
        userRecordId,
        tokenHash,
        tokenPrefix,
        verificationUrl,
        qrPngDataUrl,
        issuedAt,
        expiresAt,
        issuedByAdminId,
      );

    return Number(res.lastInsertRowid);
  });

  return {
    id: qrId,
    tokenPrefix,
    verificationUrl,
    qrPngDataUrl,
    status: 'ACTIVE',
    issuedAt,
    expiresAt,
  };
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // Serve uploaded files safely (prevent path traversal)
  router.get('/uploads/:filename', (req: Request, res: Response) => {
    const filename = path.basename(String(req.params['filename'] || ''));
    const fullPath = path.join(getUploadsDir(), filename);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({error: 'File not found'});
      return;
    }
    res.sendFile(fullPath);
  });

  // Public field configuration & settings
  router.get('/public/field-configs', (_req: Request, res: Response) => {
    const rows = getDb()
      .prepare(
        'SELECT * FROM user_field_configs WHERE is_enabled = 1 ORDER BY sort_order ASC, id ASC',
      )
      .all() as {
      id: number;
      field_key: string;
      label: string;
      field_type: string;
      is_required: number;
      is_enabled: number;
      is_editable_on_resubmit: number;
      options_json: string;
      sort_order: number;
    }[];

    res.json({
      organizationName: getSetting('organization_name', 'Secure QR Verification Authority'),
      idProofRequired: getSetting('id_proof_required', 'true') === 'true',
      fields: rows.map((r) => ({
        id: r.id,
        fieldKey: r.field_key,
        label: r.label,
        fieldType: r.field_type,
        isRequired: Boolean(r.is_required),
        isEditableOnResubmit: Boolean(r.is_editable_on_resubmit),
        options: JSON.parse(r.options_json) as string[],
        sortOrder: r.sort_order,
      })),
    });
  });

  // Public non-PII verification status check (never exposes user PII!)
  router.get('/public/verify-info', (req: Request, res: Response) => {
    const tokenParam = String(req.query['token'] || '');
    if (!tokenParam) {
      res.status(400).json({status: 'INVALID', message: 'Verification token is missing.'});
      return;
    }
    const rawToken = extractTokenFromInput(tokenParam);
    const tokenHash = sha256Hex(rawToken);
    const qr = getDb()
      .prepare(
        `SELECT q.status, q.expires_at, q.issued_at, ur.approval_status, ua.is_active, ua.deleted_at
         FROM qr_codes q
         JOIN user_records ur ON ur.id = q.user_record_id
         JOIN user_accounts ua ON ua.id = ur.user_id
         WHERE q.token_hash = ?`,
      )
      .get(tokenHash) as
      | {
          status: string;
          expires_at: string;
          issued_at: string;
          approval_status: string;
          is_active: number;
          deleted_at: string | null;
        }
      | undefined;

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
  router.post('/auth/check-availability', (req: Request, res: Response) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const mobile = String(req.body?.mobile || '').trim();
    const db = getDb();

    const emailTaken = email
      ? Boolean(db.prepare('SELECT id FROM user_accounts WHERE lower(email) = ?').get(email))
      : false;
    const mobileTaken = mobile
      ? Boolean(db.prepare('SELECT id FROM user_accounts WHERE mobile = ?').get(mobile))
      : false;

    res.json({emailAvailable: !emailTaken, mobileAvailable: !mobileTaken});
  });

  // Send OTP (stored ONLY as HMAC-SHA256 hash)
  router.post(
    '/auth/otp/send',
    rateLimit('otp_send', 8, 15 * 60 * 1000),
    async (req: Request, res: Response) => {
      const mobile = String(req.body?.mobile || '').trim();
      const purpose = String(req.body?.purpose || 'REGISTRATION').toUpperCase();
      if (!/^\+?[0-9]{8,16}$/.test(mobile)) {
        res.status(400).json({error: 'Enter a valid mobile number (8-16 digits, optional + prefix).'});
        return;
      }

      const db = getDb();
      if (purpose === 'REGISTRATION') {
        const existingMobile = db
          .prepare('SELECT id FROM user_accounts WHERE mobile = ?')
          .get(mobile);
        if (existingMobile) {
          res.status(409).json({error: 'This mobile number is already registered.'});
          return;
        }
      }

      // Enforce 30-second resend cooldown & max 5 OTPs per 30 mins
      const recentOtps = db
        .prepare(
          `SELECT id, created_at FROM otp_verifications
           WHERE mobile = ? AND created_at >= ?
           ORDER BY id DESC`,
        )
        .all(mobile, new Date(Date.now() - 30 * 60 * 1000).toISOString()) as {
        id: number;
        created_at: string;
      }[];

      if (recentOtps.length >= 5) {
        res.status(429).json({
          error: 'OTP resend limit reached for this mobile number. Try again in 30 minutes.',
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

      const expiryMinutes = Number.parseInt(getSetting('otp_expiry_minutes', '5'), 10) || 5;
      const maxAttempts = Number.parseInt(getSetting('max_otp_attempts', '5'), 10) || 5;
      const otp = generateNumericOtp();
      const otpHash = hashOtp(mobile, otp);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000).toISOString();

      const insertRes = db
        .prepare(
          `INSERT INTO otp_verifications
            (mobile, purpose, otp_hash, expires_at, attempts, max_attempts, ip_address, created_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(mobile, purpose, otpHash, expiresAt, maxAttempts, req.ip || null, now.toISOString());

      const isResend = recentOtps.length > 0;
      const smsResult = await dispatchOtpSms(mobile, otp, isResend);
      const allowDevHint =
        process.env['NODE_ENV'] !== 'production' &&
        (process.env['ALLOW_DEV_OTP_HINT'] ?? 'true') === 'true';

      if (smsResult.provider === 'console' && process.env['NODE_ENV'] !== 'production') {
        console.log(`[DEV SMS GATEWAY] OTP for ${mobile}: ${otp} (expires in ${expiryMinutes}m)`);
      }

      res.json({
        otpRequestId: Number(insertRes.lastInsertRowid),
        mobile,
        expiresInSeconds: expiryMinutes * 60,
        message: smsResult.dispatched
          ? 'Verification OTP dispatched via SMS gateway.'
          : 'Verification OTP generated.',
        smsProvider: smsResult.provider,
        smsDispatched: smsResult.dispatched,
        ...(allowDevHint ? {devOtpHint: otp} : {}),
      });
    },
  );

  // Verify OTP
  router.post(
    '/auth/otp/verify',
    rateLimit('otp_verify', 15, 15 * 60 * 1000),
    (req: Request, res: Response) => {
      const mobile = String(req.body?.mobile || '').trim();
      const otp = String(req.body?.otp || '').trim();
      if (!mobile || !/^\d{6}$/.test(otp)) {
        res.status(400).json({error: 'Mobile number and 6-digit OTP are required.'});
        return;
      }

      const db = getDb();
      const latest = db
        .prepare(
          `SELECT * FROM otp_verifications
           WHERE mobile = ? AND used_at IS NULL
           ORDER BY id DESC LIMIT 1`,
        )
        .get(mobile) as
        | {
            id: number;
            otp_hash: string;
            expires_at: string;
            attempts: number;
            max_attempts: number;
            verified_at: string | null;
          }
        | undefined;

      if (!latest) {
        res.status(400).json({error: 'No active OTP request found. Please request a new OTP.'});
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

      const providedHash = hashOtp(mobile, otp);
      if (providedHash !== latest.otp_hash) {
        db.prepare('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?').run(latest.id);
        const remaining = latest.max_attempts - (latest.attempts + 1);
        res.status(400).json({
          error: `Invalid OTP. ${Math.max(remaining, 0)} attempt(s) remaining.`,
        });
        return;
      }

      const now = new Date().toISOString();
      db.prepare('UPDATE otp_verifications SET verified_at = ? WHERE id = ?').run(now, latest.id);

      res.json({
        verified: true,
        otpVerificationId: latest.id,
        verifiedAt: now,
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
      const dob = b.dob ? String(b.dob).trim() : null;
      const gender = b.gender ? String(b.gender).trim() : null;
      const address = String(b.address || '').trim();
      const city = String(b.city || '').trim();
      const district = String(b.district || '').trim();
      const state = String(b.state || '').trim();
      const country = String(b.country || '').trim();
      const postalCode = String(b.postalCode || '').trim();
      const idProofType = String(b.idProofType || 'National ID').trim();
      const consentAccepted = Boolean(b.consentAccepted);
      const dynamicFields = (b.dynamicFields && typeof b.dynamicFields === 'object') ? b.dynamicFields : {};

      if (!fullName || !email || !mobile || password.length < 8 || !address || !city || !district || !state || !country || !postalCode) {
        res.status(400).json({error: 'Please fill in all required details and set a password with at least 8 characters.'});
        return;
      }
      if (!consentAccepted) {
        res.status(400).json({error: 'Please accept the privacy notice before submitting your application.'});
        return;
      }
      if (!otpVerificationId) {
        res.status(400).json({error: 'Please verify your mobile number with the SMS code first.'});
        return;
      }

      const db = getDb();
      const otpRec = db
        .prepare(
          'SELECT id, mobile, verified_at, used_at FROM otp_verifications WHERE id = ? AND mobile = ?',
        )
        .get(otpVerificationId, mobile) as
        | {id: number; mobile: string; verified_at: string | null; used_at: string | null}
        | undefined;

      if (!otpRec || !otpRec.verified_at || otpRec.used_at) {
        res.status(400).json({error: 'Your mobile verification has expired or was already used. Please request a fresh code.'});
        return;
      }

      const dup = db
        .prepare('SELECT id FROM user_accounts WHERE lower(email) = ? OR mobile = ?')
        .get(email, mobile);
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
      } else if (getSetting('id_proof_required', 'true') === 'true') {
        res.status(400).json({error: 'Please upload a photo or PDF of your ID proof.'});
        return;
      }

      const now = new Date().toISOString();
      const year = new Date().getFullYear();

      const result = withTransaction((tx) => {
        tx.prepare('UPDATE otp_verifications SET used_at = ? WHERE id = ?').run(now, otpRec.id);

        const userRes = tx
          .prepare(
            `INSERT INTO user_accounts
              (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
             VALUES (?, ?, ?, 'USER', 1, 1, ?, ?)`,
          )
          .run(email, mobile, hashPassword(password), now, now);
        const userId = Number(userRes.lastInsertRowid);
        const registrationId = `SQR-${year}-${String(100000 + userId).padStart(6, '0')}`;

        const recRes = tx
          .prepare(
            `INSERT INTO user_records
              (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
               profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
               approval_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'PENDING', ?, ?)`,
          )
          .run(
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
            now,
            now,
            now,
          );
        const userRecordId = Number(recRes.lastInsertRowid);

        tx.prepare(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at)
           VALUES (?, 'INITIAL', 'PENDING', 'Self-registration submitted with verified mobile OTP.', ?)`,
        ).run(userRecordId, now);

        return {userId, userRecordId, registrationId};
      });

      createNotification({
        recipientRole: 'ADMIN',
        type: 'NEW_REGISTRATION',
        title: 'New Registration Pending Review',
        message: `${fullName} (${result.registrationId}) registered from ${city}, ${state}.`,
        linkPath: '/admin/registrations',
        metadata: {userRecordId: result.userRecordId, registrationId: result.registrationId},
      });

      createNotification({
        recipientUserId: result.userId,
        type: 'REGISTRATION_RECEIVED',
        title: 'Registration Received',
        message: `Application ${result.registrationId} is pending administrator review.`,
        linkPath: '/user/home',
        metadata: {registrationId: result.registrationId},
      });

      writeAuditLog(
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
        submittedAt: now,
        message: 'Registration submitted successfully. Your application is awaiting administrator approval.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed.';
      res.status(400).json({error: message});
    }
  });

  // Login helper for both User & Admin endpoints
  function handleLogin(expectedPortal: 'USER' | 'ADMIN') {
    return (req: Request, res: Response): void => {
      const identifier = String(req.body?.email || req.body?.identifier || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      if (!identifier || !password) {
        res.status(400).json({error: 'Email/mobile and password are required.'});
        return;
      }

      const db = getDb();
      const account = db
        .prepare(
          `SELECT * FROM user_accounts
           WHERE (lower(email) = ? OR mobile = ?) AND deleted_at IS NULL`,
        )
        .get(identifier, identifier) as
        | {
            id: number;
            email: string;
            mobile: string;
            password_hash: string;
            role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
            is_active: number;
            is_mobile_verified: number;
          }
        | undefined;

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
        const profile = db
          .prepare('SELECT * FROM admin_profiles WHERE user_id = ?')
          .get(account.id) as
          | {full_name: string; avatar_url: string; permissions_json: string}
          | undefined;
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
              ? (JSON.parse(profile.permissions_json) as string[])
              : [];
      } else {
        const rec = db
          .prepare('SELECT full_name, profile_photo_url, registration_id, approval_status FROM user_records WHERE user_id = ?')
          .get(account.id) as
          | {full_name: string; profile_photo_url: string; registration_id: string; approval_status: string}
          | undefined;
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
      db.prepare(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        account.id,
        sha256Hex(refreshToken),
        new Date(now.getTime() + 7 * 86400000).toISOString(),
        now.toISOString(),
      );

      writeAuditLog(
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

  router.post('/auth/refresh', (req: Request, res: Response) => {
    const refreshToken = String(req.body?.refreshToken || '');
    if (!refreshToken) {
      res.status(400).json({error: 'Refresh token required.'});
      return;
    }
    const db = getDb();
    const tokenHash = sha256Hex(refreshToken);
    const row = db
      .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .get(tokenHash) as
      | {id: number; user_id: number; expires_at: string}
      | undefined;

    if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
      res.status(401).json({error: 'Refresh token is invalid or expired.'});
      return;
    }

    const account = db
      .prepare('SELECT id, email, role, is_active, deleted_at FROM user_accounts WHERE id = ?')
      .get(row.user_id) as
      | {id: number; email: string; role: 'SUPER_ADMIN' | 'ADMIN' | 'USER'; is_active: number; deleted_at: string | null}
      | undefined;

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
      const profile = db
        .prepare('SELECT permissions_json FROM admin_profiles WHERE user_id = ?')
        .get(account.id) as {permissions_json: string} | undefined;
      permissions = profile ? (JSON.parse(profile.permissions_json) as string[]) : [];
    }

    const accessToken = signAccessToken(
      {sub: account.id, email: account.email, role: account.role, permissions},
      3600,
    );
    res.json({accessToken});
  });

  router.post('/auth/logout', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const refreshToken = String(req.body?.refreshToken || '');
    if (refreshToken) {
      getDb()
        .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?')
        .run(new Date().toISOString(), sha256Hex(refreshToken));
    }
    res.json({success: true});
  });

  router.get('/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const auth = req.auth!;
    const db = getDb();
    const account = db
      .prepare('SELECT id, email, mobile, role, is_active, is_mobile_verified, created_at FROM user_accounts WHERE id = ?')
      .get(auth.sub) as Record<string, unknown>;

    if (auth.role === 'ADMIN' || auth.role === 'SUPER_ADMIN') {
      const profile = db
        .prepare('SELECT full_name, department, designation, avatar_url FROM admin_profiles WHERE user_id = ?')
        .get(auth.sub) as
        | {full_name: string; department: string; designation: string; avatar_url: string}
        | undefined;
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

    const rec = db
      .prepare('SELECT full_name, profile_photo_url, registration_id, approval_status FROM user_records WHERE user_id = ?')
      .get(auth.sub) as
      | {full_name: string; profile_photo_url: string; registration_id: string; approval_status: string}
      | undefined;
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

  router.get('/user/dashboard', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const userId = req.auth!.sub;
    const db = getDb();
    const record = db
      .prepare(
        `SELECT ur.*, ua.email, ua.mobile, ua.is_mobile_verified, ua.is_active
         FROM user_records ur
         JOIN user_accounts ua ON ua.id = ur.user_id
         WHERE ur.user_id = ? AND ur.deleted_at IS NULL`,
      )
      .get(userId) as Record<string, unknown> | undefined;

    if (!record) {
      res.status(404).json({error: 'User registration record not found.'});
      return;
    }

    const activeQr = db
      .prepare(
        `SELECT id, token_prefix, verification_url, qr_png_data_url, status, issued_at, expires_at, scan_count, last_verified_at
         FROM qr_codes
         WHERE user_record_id = ? AND status = 'ACTIVE'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(record['id'] as number) as Record<string, unknown> | undefined;

    const unreadNotifications = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM notifications WHERE recipient_user_id = ? AND is_read = 0')
        .get(userId) as {cnt: number}
    ).cnt;

    const recentNotifications = db
      .prepare(
        `SELECT id, type, title, message, link_path, is_read, created_at
         FROM notifications
         WHERE recipient_user_id = ?
         ORDER BY id DESC LIMIT 5`,
      )
      .all(userId);

    const history = db
      .prepare(
        `SELECT id, request_type, status, notes, submitted_at, processed_at
         FROM registration_requests
         WHERE user_record_id = ?
         ORDER BY id DESC`,
      )
      .all(record['id'] as number);

    res.json({
      record: {
        ...record,
        dynamicFields: JSON.parse(String(record['dynamic_fields_json'] || '{}')),
      },
      activeQr: activeQr || null,
      unreadNotifications,
      recentNotifications,
      history,
      organizationName: getSetting('organization_name', 'Secure QR Verification Authority'),
    });
  });

  router.patch('/user/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.auth!.sub;
      const db = getDb();
      const record = db
        .prepare('SELECT * FROM user_records WHERE user_id = ?')
        .get(userId) as Record<string, unknown> | undefined;
      if (!record) {
        res.status(404).json({error: 'Record not found.'});
        return;
      }

      const b = req.body || {};
      const now = new Date().toISOString();
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

      db.prepare(
        `UPDATE user_records
         SET full_name = ?, dob = ?, gender = ?, address = ?, city = ?, district = ?, state = ?, country = ?, postal_code = ?,
             profile_photo_url = ?, id_proof_type = ?, id_proof_url = ?, dynamic_fields_json = ?, updated_at = ?
         WHERE user_id = ?`,
      ).run(
        String(b.fullName ?? record['full_name']).trim(),
        b.dob !== undefined ? b.dob : record['dob'],
        b.gender !== undefined ? b.gender : record['gender'],
        String(b.address ?? record['address']).trim(),
        String(b.city ?? record['city']).trim(),
        String(b.district ?? record['district']).trim(),
        String(b.state ?? record['state']).trim(),
        String(b.country ?? record['country']).trim(),
        String(b.postalCode ?? record['postal_code']).trim(),
        profilePhotoUrl,
        String(b.idProofType ?? record['id_proof_type']),
        idProofUrl,
        b.dynamicFields ? JSON.stringify(b.dynamicFields) : String(record['dynamic_fields_json']),
        now,
        userId,
      );

      res.json({success: true, updatedAt: now});
    } catch (err) {
      res.status(400).json({error: err instanceof Error ? err.message : 'Update failed'});
    }
  });

  router.post('/user/resubmit', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.auth!.sub;
      const db = getDb();
      const record = db
        .prepare('SELECT * FROM user_records WHERE user_id = ?')
        .get(userId) as Record<string, unknown> | undefined;

      if (!record) {
        res.status(404).json({error: 'Registration record not found.'});
        return;
      }
      if (record['approval_status'] !== 'RESUBMISSION_REQUIRED') {
        res.status(400).json({error: 'Only applications marked for update can be resubmitted.'});
        return;
      }

      const b = req.body || {};
      const now = new Date().toISOString();
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

      withTransaction((tx) => {
        tx.prepare(
          `UPDATE user_records
           SET full_name = ?, dob = ?, gender = ?, address = ?, city = ?, district = ?, state = ?, country = ?, postal_code = ?,
               profile_photo_url = ?, id_proof_type = ?, id_proof_url = ?, dynamic_fields_json = ?,
               approval_status = 'PENDING', resubmission_note = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(
          String(b.fullName ?? record['full_name']).trim(),
          b.dob ?? record['dob'],
          b.gender ?? record['gender'],
          String(b.address ?? record['address']).trim(),
          String(b.city ?? record['city']).trim(),
          String(b.district ?? record['district']).trim(),
          String(b.state ?? record['state']).trim(),
          String(b.country ?? record['country']).trim(),
          String(b.postalCode ?? record['postal_code']).trim(),
          profilePhotoUrl,
          String(b.idProofType ?? record['id_proof_type']),
          idProofUrl,
          b.dynamicFields ? JSON.stringify(b.dynamicFields) : String(record['dynamic_fields_json']),
          now,
          record['id'] as number,
        );

        tx.prepare(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at)
           VALUES (?, 'RESUBMISSION', 'PENDING', ?, ?)`,
        ).run(
          record['id'] as number,
          String(b.resubmissionComment || 'Applicant updated requested details and resubmitted.'),
          now,
        );
      });

      createNotification({
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

  router.get('/user/qr/download', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const userId = req.auth!.sub;
    const db = getDb();
    const record = db
      .prepare('SELECT id, registration_id, approval_status FROM user_records WHERE user_id = ?')
      .get(userId) as {id: number; registration_id: string; approval_status: string} | undefined;

    if (!record || record.approval_status !== 'APPROVED') {
      res.status(403).json({error: 'Only approved users can download an active QR credential.'});
      return;
    }

    const qr = db
      .prepare(
        `SELECT qr_png_data_url, status, expires_at FROM qr_codes
         WHERE user_record_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1`,
      )
      .get(record.id) as {qr_png_data_url: string; status: string; expires_at: string} | undefined;

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

  router.get('/user/notifications', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const items = getDb()
      .prepare('SELECT * FROM notifications WHERE recipient_user_id = ? ORDER BY id DESC LIMIT 100')
      .all(req.auth!.sub);
    res.json({notifications: items});
  });

  router.post('/user/notifications/:id/read', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        'UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ? AND recipient_user_id = ?',
      )
      .run(now, Number(req.params['id']), req.auth!.sub);
    res.json({success: true});
  });

  router.post('/user/notifications/read-all', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        'UPDATE notifications SET is_read = 1, read_at = ? WHERE recipient_user_id = ? AND is_read = 0',
      )
      .run(now, req.auth!.sub);
    res.json({success: true});
  });

  router.post('/user/change-password', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 8) {
      res.status(400).json({error: 'New password must be at least 8 characters long.'});
      return;
    }
    const db = getDb();
    const account = db
      .prepare('SELECT password_hash FROM user_accounts WHERE id = ?')
      .get(req.auth!.sub) as {password_hash: string} | undefined;
    if (!account || !verifyPassword(currentPassword, account.password_hash)) {
      res.status(400).json({error: 'Current password is incorrect.'});
      return;
    }
    db.prepare('UPDATE user_accounts SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(newPassword),
      new Date().toISOString(),
      req.auth!.sub,
    );
    res.json({success: true});
  });

  // =========================================================================
  // ADMIN PORTAL APIs
  // =========================================================================

  router.get('/admin/dashboard/stats', requireAuth, requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
    const db = getDb();
    // Auto-expire past-due active QRs
    db.prepare(
      `UPDATE qr_codes SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ?`,
    ).run(new Date().toISOString());

    const totalUsers = (
      db
        .prepare("SELECT COUNT(*) as c FROM user_accounts WHERE role = 'USER' AND deleted_at IS NULL")
        .get() as {c: number}
    ).c;
    const pendingRegistrations = (
      db
        .prepare("SELECT COUNT(*) as c FROM user_records WHERE approval_status = 'PENDING' AND deleted_at IS NULL")
        .get() as {c: number}
    ).c;
    const approvedUsers = (
      db
        .prepare("SELECT COUNT(*) as c FROM user_records WHERE approval_status = 'APPROVED' AND deleted_at IS NULL")
        .get() as {c: number}
    ).c;
    const rejectedUsers = (
      db
        .prepare("SELECT COUNT(*) as c FROM user_records WHERE approval_status = 'REJECTED' AND deleted_at IS NULL")
        .get() as {c: number}
    ).c;
    const resubmissionRequests = (
      db
        .prepare("SELECT COUNT(*) as c FROM user_records WHERE approval_status = 'RESUBMISSION_REQUIRED' AND deleted_at IS NULL")
        .get() as {c: number}
    ).c;
    const activeQrCodes = (
      db.prepare("SELECT COUNT(*) as c FROM qr_codes WHERE status = 'ACTIVE'").get() as {c: number}
    ).c;
    const expiredQrCodes = (
      db.prepare("SELECT COUNT(*) as c FROM qr_codes WHERE status = 'EXPIRED'").get() as {c: number}
    ).c;
    const revokedQrCodes = (
      db.prepare("SELECT COUNT(*) as c FROM qr_codes WHERE status = 'REVOKED'").get() as {c: number}
    ).c;
    const totalQrScans = (
      db.prepare('SELECT COUNT(*) as c FROM qr_scan_logs').get() as {c: number}
    ).c;

    const recentRegistrations = db
      .prepare(
        `SELECT ur.id, ur.registration_id, ur.full_name, ur.city, ur.state, ur.approval_status, ur.created_at, ur.profile_photo_url, ua.email
         FROM user_records ur
         JOIN user_accounts ua ON ua.id = ur.user_id
         WHERE ur.deleted_at IS NULL
         ORDER BY ur.id DESC LIMIT 6`,
      )
      .all();

    const recentScans = db
      .prepare(
        `SELECT sl.id, sl.result_status, sl.reason, sl.scanned_token_prefix, sl.scanned_at,
                ur.full_name as holder_name, ur.registration_id,
                ap.full_name as scanner_name
         FROM qr_scan_logs sl
         LEFT JOIN user_records ur ON ur.id = sl.user_record_id
         LEFT JOIN admin_profiles ap ON ap.user_id = sl.scanned_by_admin_id
         ORDER BY sl.id DESC LIMIT 6`,
      )
      .all();

    const unreadNotifications = (
      db
        .prepare("SELECT COUNT(*) as c FROM notifications WHERE recipient_role IN ('ADMIN', 'SUPER_ADMIN') AND is_read = 0")
        .get() as {c: number}
    ).c;

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
    (req: AuthenticatedRequest, res: Response) => {
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
        where.push('lower(ur.state) = lower(?)');
        params.push(state);
      }
      if (city) {
        where.push('lower(ur.city) = lower(?)');
        params.push(city);
      }
      if (dateFrom) {
        where.push('ur.created_at >= ?');
        params.push(dateFrom);
      }
      if (dateTo) {
        where.push('ur.created_at <= ?');
        params.push(`${dateTo}T23:59:59.999Z`);
      }
      if (search) {
        where.push(
          '(lower(ur.full_name) LIKE ? OR lower(ur.registration_id) LIKE ? OR lower(ua.email) LIKE ? OR ua.mobile LIKE ?)',
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

      const db = getDb();
      const whereSql = where.join(' AND ');
      const total = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM user_records ur JOIN user_accounts ua ON ua.id = ur.user_id WHERE ${whereSql}`,
          )
          .get(...params) as {c: number}
      ).c;

      const rows = db
        .prepare(
          `SELECT ur.*, ua.email, ua.mobile, ua.is_active, ua.is_mobile_verified,
                  (SELECT status FROM qr_codes q WHERE q.user_record_id = ur.id ORDER BY q.id DESC LIMIT 1) as latest_qr_status,
                  (SELECT expires_at FROM qr_codes q WHERE q.user_record_id = ur.id ORDER BY q.id DESC LIMIT 1) as latest_qr_expires_at
           FROM user_records ur
           JOIN user_accounts ua ON ua.id = ur.user_id
           WHERE ${whereSql}
           ORDER BY ${sortCol} ${sortDir}
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];

      const states = db
        .prepare('SELECT DISTINCT state FROM user_records WHERE deleted_at IS NULL ORDER BY state ASC')
        .all() as {state: string}[];
      const cities = db
        .prepare('SELECT DISTINCT city FROM user_records WHERE deleted_at IS NULL ORDER BY city ASC')
        .all() as {city: string}[];

      res.json({
        items: rows.map((r) => ({
          ...r,
          dynamicFields: JSON.parse(String(r['dynamic_fields_json'] || '{}')),
        })),
        total,
        page,
        pageSize,
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
    (req: AuthenticatedRequest, res: Response) => {
      const id = Number(req.params['id']);
      const db = getDb();
      const row = db
        .prepare(
          `SELECT ur.*, ua.email, ua.mobile, ua.is_active, ua.is_mobile_verified
           FROM user_records ur
           JOIN user_accounts ua ON ua.id = ur.user_id
           WHERE ur.id = ? AND ur.deleted_at IS NULL`,
        )
        .get(id) as Record<string, unknown> | undefined;

      if (!row) {
        res.status(404).json({error: 'Registration record not found.'});
        return;
      }

      const history = db
        .prepare(
          `SELECT rr.*, ap.full_name as admin_name
           FROM registration_requests rr
           LEFT JOIN admin_profiles ap ON ap.user_id = rr.processed_by
           WHERE rr.user_record_id = ?
           ORDER BY rr.id DESC`,
        )
        .all(id);

      const qrs = db
        .prepare(
          `SELECT id, token_prefix, status, issued_at, expires_at, revoked_at, revoke_reason, scan_count, last_verified_at
           FROM qr_codes WHERE user_record_id = ? ORDER BY id DESC`,
        )
        .all(id);

      res.json({
        record: {
          ...row,
          dynamicFields: JSON.parse(String(row['dynamic_fields_json'] || '{}')),
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
      const db = getDb();

      const record = db
        .prepare(
          `SELECT ur.*, ua.email FROM user_records ur
           JOIN user_accounts ua ON ua.id = ur.user_id
           WHERE ur.id = ? AND ur.deleted_at IS NULL`,
        )
        .get(id) as
        | {id: number; user_id: number; registration_id: string; full_name: string; email: string; approval_status: string}
        | undefined;

      if (!record) {
        res.status(404).json({error: 'Registration not found.'});
        return;
      }

      const existingActiveQr = db
        .prepare("SELECT id FROM qr_codes WHERE user_record_id = ? AND status = 'ACTIVE'")
        .get(record.id);

      if (record.approval_status === 'APPROVED' && existingActiveQr) {
        res.status(409).json({error: 'Application is already approved with an active QR code.'});
        return;
      }

      const now = new Date().toISOString();
      withTransaction((tx) => {
        tx.prepare(
          `UPDATE user_records
           SET approval_status = 'APPROVED', rejection_reason = NULL, resubmission_note = NULL,
               reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(adminId, now, now, record.id);

        tx.prepare(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
           VALUES (?, 'INITIAL', 'APPROVED', ?, ?, ?, ?)`,
        ).run(record.id, String(req.body?.note || 'Approved by administrator.'), now, adminId, now);
      });

      try {
        const qr = await generateAndSaveQr(record.id, adminId, getBaseUrl(req));

        createNotification({
          recipientUserId: record.user_id,
          type: 'REGISTRATION_APPROVED',
          title: 'Application Approved',
          message: `Your registration (${record.registration_id}) has been approved.`,
          linkPath: '/user/home',
          metadata: {registrationId: record.registration_id},
        });

        createNotification({
          recipientUserId: record.user_id,
          type: 'QR_GENERATED',
          title: 'Active QR Credential Ready',
          message: `Your cryptographic QR credential and ID card are now ready for download.`,
          linkPath: '/user/qr-card',
          metadata: {registrationId: record.registration_id, tokenPrefix: qr.tokenPrefix},
        });

        writeAuditLog(
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
        // Recoverable state: approved, QR retry allowed without duplicates
        res.status(500).json({
          error: 'Application marked APPROVED, but QR generation encountered an error. You may safely retry QR issuance.',
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
    (req: AuthenticatedRequest, res: Response) => {
      const id = Number(req.params['id']);
      const reason = String(req.body?.reason || '').trim();
      if (!reason) {
        res.status(400).json({error: 'A rejection reason is required.'});
        return;
      }

      const db = getDb();
      const record = db
        .prepare('SELECT id, user_id, registration_id, full_name FROM user_records WHERE id = ? AND deleted_at IS NULL')
        .get(id) as {id: number; user_id: number; registration_id: string; full_name: string} | undefined;

      if (!record) {
        res.status(404).json({error: 'Registration not found.'});
        return;
      }

      const now = new Date().toISOString();
      withTransaction((tx) => {
        tx.prepare(
          `UPDATE user_records
           SET approval_status = 'REJECTED', rejection_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(reason, req.auth!.sub, now, now, record.id);

        tx.prepare(
          `UPDATE qr_codes
           SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, revoke_reason = 'Application rejected'
           WHERE user_record_id = ? AND status = 'ACTIVE'`,
        ).run(now, req.auth!.sub, record.id);

        tx.prepare(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
           VALUES (?, 'INITIAL', 'REJECTED', ?, ?, ?, ?)`,
        ).run(record.id, reason, now, req.auth!.sub, now);
      });

      createNotification({
        recipientUserId: record.user_id,
        type: 'REGISTRATION_REJECTED',
        title: 'Application Rejected',
        message: reason,
        linkPath: '/user/home',
        metadata: {registrationId: record.registration_id},
      });

      writeAuditLog(
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
    (req: AuthenticatedRequest, res: Response) => {
      const id = Number(req.params['id']);
      const note = String(req.body?.note || '').trim();
      if (!note) {
        res.status(400).json({error: 'Correction instructions are required for resubmission.'});
        return;
      }

      const db = getDb();
      const record = db
        .prepare('SELECT id, user_id, registration_id FROM user_records WHERE id = ? AND deleted_at IS NULL')
        .get(id) as {id: number; user_id: number; registration_id: string} | undefined;

      if (!record) {
        res.status(404).json({error: 'Registration not found.'});
        return;
      }

      const now = new Date().toISOString();
      withTransaction((tx) => {
        tx.prepare(
          `UPDATE user_records
           SET approval_status = 'RESUBMISSION_REQUIRED', resubmission_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(note, req.auth!.sub, now, now, record.id);

        tx.prepare(
          `INSERT INTO registration_requests
            (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
           VALUES (?, 'INITIAL', 'RESUBMISSION_REQUIRED', ?, ?, ?, ?)`,
        ).run(record.id, note, now, req.auth!.sub, now);
      });

      createNotification({
        recipientUserId: record.user_id,
        type: 'RESUBMISSION_REQUIRED',
        title: 'Resubmission Required',
        message: note,
        linkPath: '/user/profile',
        metadata: {registrationId: record.registration_id},
      });

      writeAuditLog(
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
    (req: AuthenticatedRequest, res: Response) => {
      const search = String(req.query['search'] || '').trim().toLowerCase();
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT ua.id as account_id, ua.email, ua.mobile, ua.is_active, ua.is_mobile_verified, ua.created_at as account_created_at,
                  ur.id as record_id, ur.registration_id, ur.full_name, ur.city, ur.state, ur.country, ur.approval_status, ur.profile_photo_url
           FROM user_accounts ua
           JOIN user_records ur ON ur.user_id = ua.id
           WHERE ua.role = 'USER' AND ua.deleted_at IS NULL
           ORDER BY ua.id DESC`,
        )
        .all() as Record<string, unknown>[];

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
    (req: AuthenticatedRequest, res: Response) => {
      const accountId = Number(req.params['accountId']);
      const isActive = Boolean(req.body?.isActive);
      const db = getDb();
      const target = db
        .prepare("SELECT id, email FROM user_accounts WHERE id = ? AND role = 'USER'")
        .get(accountId) as {id: number; email: string} | undefined;
      if (!target) {
        res.status(404).json({error: 'User account not found.'});
        return;
      }

      const now = new Date().toISOString();
      db.prepare('UPDATE user_accounts SET is_active = ?, updated_at = ? WHERE id = ?').run(
        isActive ? 1 : 0,
        now,
        accountId,
      );

      writeAuditLog(
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
    (_req: AuthenticatedRequest, res: Response) => {
      const db = getDb();
      db.prepare(
        `UPDATE qr_codes SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ?`,
      ).run(new Date().toISOString());

      const qrs = db
        .prepare(
          `SELECT q.id, q.user_record_id, q.token_prefix, q.verification_url, q.qr_png_data_url, q.status,
                  q.issued_at, q.expires_at, q.revoked_at, q.revoke_reason, q.last_verified_at, q.scan_count,
                  ur.registration_id, ur.full_name, ur.city, ur.state, ur.approval_status, ur.profile_photo_url,
                  ua.email, ua.is_active
           FROM qr_codes q
           JOIN user_records ur ON ur.id = q.user_record_id
           JOIN user_accounts ua ON ua.id = ur.user_id
           ORDER BY q.id DESC`,
        )
        .all();

      res.json({qrs});
    },
  );

  router.post(
    '/admin/qrs/generate/:userRecordId',
    requireAuth,
    requirePermission('can_manage_qr'),
    async (req: AuthenticatedRequest, res: Response) => {
      const userRecordId = Number(req.params['userRecordId']);
      const record = getDb()
        .prepare('SELECT id, user_id, registration_id, approval_status FROM user_records WHERE id = ? AND deleted_at IS NULL')
        .get(userRecordId) as
        | {id: number; user_id: number; registration_id: string; approval_status: string}
        | undefined;

      if (!record) {
        res.status(404).json({error: 'User record not found.'});
        return;
      }
      if (record.approval_status !== 'APPROVED') {
        res.status(400).json({error: 'Only APPROVED users can receive active QR codes.'});
        return;
      }

      const qr = await generateAndSaveQr(record.id, req.auth!.sub, getBaseUrl(req));
      createNotification({
        recipientUserId: record.user_id,
        type: 'QR_GENERATED',
        title: 'New QR Credential Issued',
        message: `A new active QR credential (${qr.tokenPrefix}...) has been issued for ${record.registration_id}.`,
        linkPath: '/user/qr-card',
      });
      writeAuditLog(
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
    (req: AuthenticatedRequest, res: Response) => {
      const qrId = Number(req.params['id']);
      const reason = String(req.body?.reason || 'Revoked by administrator').trim();
      const db = getDb();
      const qr = db
        .prepare(
          `SELECT q.*, ur.user_id, ur.registration_id
           FROM qr_codes q
           JOIN user_records ur ON ur.id = q.user_record_id
           WHERE q.id = ?`,
        )
        .get(qrId) as
        | {id: number; user_id: number; registration_id: string; token_prefix: string; status: string}
        | undefined;

      if (!qr) {
        res.status(404).json({error: 'QR code not found.'});
        return;
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE qr_codes SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?`,
      ).run(now, req.auth!.sub, reason, qrId);

      createNotification({
        recipientUserId: qr.user_id,
        type: 'QR_REVOKED',
        title: 'QR Credential Revoked',
        message: `Your QR credential for ${qr.registration_id} was revoked. Reason: ${reason}`,
        linkPath: '/user/qr-card',
      });

      writeAuditLog(
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
      const db = getDb();
      const existing = db
        .prepare(
          `SELECT q.user_record_id, ur.user_id, ur.registration_id, ur.approval_status
           FROM qr_codes q
           JOIN user_records ur ON ur.id = q.user_record_id
           WHERE q.id = ?`,
        )
        .get(qrId) as
        | {user_record_id: number; user_id: number; registration_id: string; approval_status: string}
        | undefined;

      if (!existing) {
        res.status(404).json({error: 'QR code not found.'});
        return;
      }
      if (existing.approval_status !== 'APPROVED') {
        res.status(400).json({error: 'Cannot regenerate QR for an unapproved user.'});
        return;
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE qr_codes SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, revoke_reason = 'Regenerated by administrator' WHERE id = ? AND status = 'ACTIVE'`,
      ).run(now, req.auth!.sub, qrId);

      const newQr = await generateAndSaveQr(existing.user_record_id, req.auth!.sub, getBaseUrl(req));
      createNotification({
        recipientUserId: existing.user_id,
        type: 'QR_GENERATED',
        title: 'QR Credential Regenerated',
        message: `Your previous QR was retired and a new active QR credential (${newQr.tokenPrefix}...) was issued.`,
        linkPath: '/user/qr-card',
      });
      writeAuditLog(
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
    (req: AuthenticatedRequest, res: Response) => {
      const rawPayload = String(req.body?.payload || '').trim();
      if (!rawPayload) {
        res.status(400).json({error: 'QR token or verification URL payload is required.'});
        return;
      }

      const rawToken = extractTokenFromInput(rawPayload);
      const tokenHash = sha256Hex(rawToken);
      const tokenPrefix = tokenHash.slice(0, 12);
      const db = getDb();
      const now = new Date();
      const nowIso = now.toISOString();

      const qr = db
        .prepare(
          `SELECT q.*, ur.id as ur_id, ur.registration_id, ur.full_name, ur.profile_photo_url, ur.city, ur.state,
                  ur.country, ur.approval_status, ur.dynamic_fields_json, ur.id_proof_type,
                  ua.email, ua.mobile, ua.is_active, ua.deleted_at
           FROM qr_codes q
           JOIN user_records ur ON ur.id = q.user_record_id
           JOIN user_accounts ua ON ua.id = ur.user_id
           WHERE q.token_hash = ?`,
        )
        .get(tokenHash) as Record<string, unknown> | undefined;

      if (!qr) {
        db.prepare(
          `INSERT INTO qr_scan_logs
            (qr_code_id, user_record_id, scanned_by_admin_id, scanned_token_prefix, result_status, reason, ip_address, user_agent, scanned_at)
           VALUES (NULL, NULL, ?, ?, 'INVALID', 'No matching QR credential hash found.', ?, ?, ?)`,
        ).run(
          req.auth!.sub,
          tokenPrefix,
          req.ip || null,
          String(req.headers['user-agent'] || ''),
          nowIso,
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
      const recentScan = db
        .prepare(
          `SELECT id, scanned_at FROM qr_scan_logs
           WHERE qr_code_id = ? AND scanned_by_admin_id = ? AND scanned_at >= ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(
          qr['id'] as number,
          req.auth!.sub,
          new Date(now.getTime() - 10_000).toISOString(),
        ) as {id: number; scanned_at: string} | undefined;

      let resultStatus: 'VALID' | 'EXPIRED' | 'REVOKED' | 'INACTIVE_USER' | 'UNAPPROVED_USER' = 'VALID';
      let label = 'VALID QR';
      let reason = 'Cryptographic token valid, active, and holder approved.';

      if (qr['status'] === 'REVOKED') {
        resultStatus = 'REVOKED';
        label = 'REVOKED QR';
        reason = String(qr['revoke_reason'] || 'Credential was revoked by an administrator.');
      } else if (
        qr['status'] === 'EXPIRED' ||
        new Date(String(qr['expires_at'])).getTime() <= now.getTime()
      ) {
        resultStatus = 'EXPIRED';
        label = 'EXPIRED QR';
        reason = `Credential expired on ${String(qr['expires_at'])}.`;
        if (qr['status'] === 'ACTIVE') {
          db.prepare("UPDATE qr_codes SET status = 'EXPIRED' WHERE id = ?").run(qr['id'] as number);
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
        db.prepare(
          `INSERT INTO qr_scan_logs
            (qr_code_id, user_record_id, scanned_by_admin_id, scanned_token_prefix, result_status, reason, ip_address, user_agent, scanned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          qr['id'] as number,
          qr['ur_id'] as number,
          req.auth!.sub,
          tokenPrefix,
          resultStatus,
          reason,
          req.ip || null,
          String(req.headers['user-agent'] || ''),
          nowIso,
        );

        if (resultStatus === 'VALID') {
          db.prepare(
            'UPDATE qr_codes SET last_verified_at = ?, scan_count = scan_count + 1 WHERE id = ?',
          ).run(nowIso, qr['id'] as number);
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
          dynamicFields: JSON.parse(String(qr['dynamic_fields_json'] || '{}')),
        },
      });
    },
  );

  router.get(
    '/admin/scan-logs',
    requireAuth,
    requirePermission('can_scan_qr'),
    (_req: AuthenticatedRequest, res: Response) => {
      const logs = getDb()
        .prepare(
          `SELECT sl.*, ur.full_name as holder_name, ur.registration_id, ap.full_name as scanner_name
           FROM qr_scan_logs sl
           LEFT JOIN user_records ur ON ur.id = sl.user_record_id
           LEFT JOIN admin_profiles ap ON ap.user_id = sl.scanned_by_admin_id
           ORDER BY sl.id DESC LIMIT 100`,
        )
        .all();
      res.json({logs});
    },
  );

  // Admin Notifications
  router.get('/admin/notifications', requireAuth, requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
    const items = getDb()
      .prepare(
        `SELECT * FROM notifications
         WHERE recipient_role IN ('ADMIN', 'SUPER_ADMIN')
         ORDER BY id DESC LIMIT 100`,
      )
      .all();
    res.json({notifications: items});
  });

  router.post('/admin/notifications/:id/read', requireAuth, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
    getDb()
      .prepare('UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ?')
      .run(new Date().toISOString(), Number(req.params['id']));
    res.json({success: true});
  });

  router.post('/admin/notifications/read-all', requireAuth, requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
    getDb()
      .prepare(
        "UPDATE notifications SET is_read = 1, read_at = ? WHERE recipient_role IN ('ADMIN', 'SUPER_ADMIN') AND is_read = 0",
      )
      .run(new Date().toISOString());
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

      getDb()
        .prepare(
          `INSERT INTO export_history (admin_user_id, admin_email, filters_json, record_count, filename, exported_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          req.auth!.sub,
          req.auth!.email,
          JSON.stringify({status, state, city, dateFrom, dateTo}),
          recordCount,
          filename,
          new Date().toISOString(),
        );

      writeAuditLog(
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
    (_req: AuthenticatedRequest, res: Response) => {
      const history = getDb()
        .prepare('SELECT * FROM export_history ORDER BY id DESC LIMIT 50')
        .all();
      res.json({history});
    },
  );

  router.post(
    '/admin/export/send-email-now',
    requireAuth,
    requirePermission('can_export_excel'),
    async (req: AuthenticatedRequest, res: Response) => {
      const result = await sendDailyVerificationExcelReport('MANUAL');
      writeAuditLog(
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
    (_req: AuthenticatedRequest, res: Response) => {
      const logs = getDb()
        .prepare('SELECT * FROM scheduled_report_logs ORDER BY id DESC LIMIT 30')
        .all();
      res.json({
        recipientEmail:
          process.env['DAILY_REPORT_RECIPIENT_EMAIL'] ||
          process.env['FIXED_ADMIN_EMAIL'] ||
          'kishore.sathayush@gmail.com',
        scheduleIntervalHours: 24,
        smtpConfigured: Boolean(
          process.env['EMAIL_HOST_USER'] && process.env['EMAIL_HOST_PASSWORD'],
        ),
        logs,
      });
    },
  );

  // Admin Management (Super Admin only)
  router.get('/admin/admins', requireAuth, requireSuperAdmin, (_req: AuthenticatedRequest, res: Response) => {
    const db = getDb();
    const admins = db
      .prepare(
        `SELECT ua.id, ua.email, ua.mobile, ua.role, ua.is_active, ua.created_at,
                ap.full_name, ap.department, ap.designation, ap.permissions_json, ap.avatar_url
         FROM user_accounts ua
         JOIN admin_profiles ap ON ap.user_id = ua.id
         WHERE ua.role IN ('ADMIN', 'SUPER_ADMIN') AND ua.deleted_at IS NULL
         ORDER BY ua.id ASC`,
      )
      .all() as Record<string, unknown>[];

    const availablePermissions = db.prepare('SELECT * FROM permissions ORDER BY id ASC').all();

    res.json({
      admins: admins.map((a) => ({
        ...a,
        permissions: JSON.parse(String(a['permissions_json'] || '[]')),
      })),
      availablePermissions,
    });
  });

  router.post('/admin/admins', requireAuth, requireSuperAdmin, (req: AuthenticatedRequest, res: Response) => {
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

    const db = getDb();
    const existing = db
      .prepare('SELECT id FROM user_accounts WHERE lower(email) = ? OR mobile = ?')
      .get(email, mobile);
    if (existing) {
      res.status(409).json({error: 'Email or mobile already exists.'});
      return;
    }

    const now = new Date().toISOString();
    const newId = withTransaction((tx) => {
      const u = tx
        .prepare(
          `INSERT INTO user_accounts
            (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
           VALUES (?, ?, ?, 'ADMIN', 1, 1, ?, ?)`,
        )
        .run(email, mobile, hashPassword(password), now, now);
      const id = Number(u.lastInsertRowid);
      tx.prepare(
        `INSERT INTO admin_profiles
          (user_id, full_name, department, designation, permissions_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, fullName, department, designation, JSON.stringify(permissions), req.auth!.sub, now);
      return id;
    });

    writeAuditLog(
      {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
      'ADMIN_ACCOUNT_CREATED',
      'ADMIN_USER',
      newId,
      {email, permissions},
      req.ip,
    );

    res.status(201).json({success: true, id: newId});
  });

  router.patch('/admin/admins/:id', requireAuth, requireSuperAdmin, (req: AuthenticatedRequest, res: Response) => {
    const id = Number(req.params['id']);
    if (id === req.auth!.sub && req.body?.isActive === false) {
      res.status(400).json({error: 'You cannot deactivate your own active Super Admin account.'});
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT id, email, role FROM user_accounts WHERE id = ?').get(id) as
      | {id: number; email: string; role: string}
      | undefined;
    if (!existing) {
      res.status(404).json({error: 'Admin account not found.'});
      return;
    }

    const now = new Date().toISOString();
    if (typeof req.body?.isActive === 'boolean') {
      db.prepare('UPDATE user_accounts SET is_active = ?, updated_at = ? WHERE id = ?').run(
        req.body.isActive ? 1 : 0,
        now,
        id,
      );
    }
    if (Array.isArray(req.body?.permissions) && existing.role === 'ADMIN') {
      db.prepare('UPDATE admin_profiles SET permissions_json = ? WHERE user_id = ?').run(
        JSON.stringify(req.body.permissions),
        id,
      );
    }

    writeAuditLog(
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
  router.get('/admin/audit-logs', requireAuth, requireSuperAdmin, (req: AuthenticatedRequest, res: Response) => {
    const action = String(req.query['action'] || '').trim();
    const search = String(req.query['search'] || '').trim().toLowerCase();

    const rows = getDb()
      .prepare('SELECT * FROM admin_activity_logs ORDER BY id DESC LIMIT 250')
      .all() as Record<string, unknown>[];

    const filtered = rows.filter((r) => {
      if (action && r['action'] !== action) return false;
      if (search) {
        const hay = `${r['actor_email']} ${r['action']} ${r['target_type']} ${r['details_json']}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    res.json({logs: filtered});
  });

  // System Settings & Dynamic Field Config (Super Admin only)
  router.get('/admin/settings', requireAuth, requireSuperAdmin, (_req: AuthenticatedRequest, res: Response) => {
    const settingsRows = getDb().prepare('SELECT key, value, updated_at FROM system_settings').all() as {
      key: string;
      value: string;
      updated_at: string;
    }[];
    const settings: Record<string, string> = {};
    for (const s of settingsRows) settings[s.key] = s.value;

    const fieldConfigs = getDb()
      .prepare('SELECT * FROM user_field_configs ORDER BY sort_order ASC, id ASC')
      .all() as Record<string, unknown>[];

    res.json({
      settings,
      fieldConfigs: fieldConfigs.map((f) => ({
        ...f,
        options: JSON.parse(String(f['options_json'] || '[]')),
      })),
    });
  });

  router.get(
    '/admin/settings/db-status',
    requireAuth,
    requireSuperAdmin,
    async (_req: AuthenticatedRequest, res: Response) => {
      const mysqlStatus = await checkMysqlConnection();
      res.json({
        database: mysqlStatus,
        integrations: {
          smtpConfigured: Boolean(
            process.env['EMAIL_HOST_USER'] && process.env['EMAIL_HOST_PASSWORD'],
          ),
          smtpHost: process.env['EMAIL_HOST'] || 'smtp.gmail.com',
          smtpUser: process.env['EMAIL_HOST_USER'] || '',
          dailyReportRecipient:
            process.env['DAILY_REPORT_RECIPIENT_EMAIL'] ||
            process.env['FIXED_ADMIN_EMAIL'] ||
            'kishore.sathayush@gmail.com',
          smsConfigured: Boolean(
            process.env['SMS_USER'] &&
              process.env['SMS_PASSWORD'] &&
              process.env['SMS_TEMPLATE_ID'],
          ),
          smsSender: process.env['SMS_SENDER'] || '',
          smsTemplateId: process.env['SMS_TEMPLATE_ID'] || '',
          reSmsTemplateId: process.env['RE_SMS_TEMPLATE_ID'] || '',
          s3Configured: Boolean(
            process.env['AWS_ACCESS_KEY_ID'] &&
              process.env['AWS_SECRET_ACCESS_KEY'] &&
              process.env['AWS_STORAGE_BUCKET_NAME'],
          ),
          s3Bucket: process.env['AWS_STORAGE_BUCKET_NAME'] || '',
          s3Region: process.env['AWS_S3_REGION_NAME'] || '',
          filePath: process.env['FILE_PATH'] || '',
          fixedAdminEmail: process.env['FIXED_ADMIN_EMAIL'] || 'kishore.sathayush@gmail.com',
        },
      });
    },
  );

  router.post(
    '/admin/settings/init-mysql',
    requireAuth,
    requireSuperAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const result = await ensureMysqlDatabaseAndSchema();
      writeAuditLog(
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

  router.patch('/admin/settings', requireAuth, requireSuperAdmin, (req: AuthenticatedRequest, res: Response) => {
    const updates = req.body?.settings;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({error: 'Settings payload required.'});
      return;
    }
    const now = new Date().toISOString();
    const stmt = getDb().prepare(
      `INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    );
    for (const [k, v] of Object.entries(updates)) {
      stmt.run(k, String(v), now, req.auth!.sub);
    }

    writeAuditLog(
      {id: req.auth!.sub, email: req.auth!.email, role: req.auth!.role},
      'SYSTEM_SETTINGS_UPDATED',
      'SETTINGS',
      'global',
      updates as Record<string, unknown>,
      req.ip,
    );

    res.json({success: true});
  });

  router.post('/admin/field-configs', requireAuth, requireSuperAdmin, (req: AuthenticatedRequest, res: Response) => {
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

    const r = getDb()
      .prepare(
        `INSERT INTO user_field_configs
          (field_key, label, field_type, is_required, is_enabled, is_editable_on_resubmit, options_json, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fieldKey,
        label,
        fieldType,
        b.isRequired ? 1 : 0,
        b.isEnabled !== false ? 1 : 0,
        b.isEditableOnResubmit !== false ? 1 : 0,
        JSON.stringify(Array.isArray(b.options) ? b.options : []),
        Number(b.sortOrder || 10),
      );

    res.status(201).json({id: Number(r.lastInsertRowid)});
  });

  router.patch('/admin/field-configs/:id', requireAuth, requireSuperAdmin, (req: AuthenticatedRequest, res: Response) => {
    const id = Number(req.params['id']);
    const b = req.body || {};
    getDb()
      .prepare(
        `UPDATE user_field_configs
         SET is_required = ?, is_enabled = ?, is_editable_on_resubmit = ?
         WHERE id = ?`,
      )
      .run(
        b.isRequired ? 1 : 0,
        b.isEnabled ? 1 : 0,
        b.isEditableOnResubmit ? 1 : 0,
        id,
      );
    res.json({success: true});
  });

  router.delete('/admin/field-configs/:id', requireAuth, requireSuperAdmin, (req: AuthenticatedRequest, res: Response) => {
    getDb().prepare('DELETE FROM user_field_configs WHERE id = ?').run(Number(req.params['id']));
    res.json({success: true});
  });

  // OpenAPI 3.0 Spec endpoint
  router.get('/docs', (_req: Request, res: Response) => {
    res.json({
      openapi: '3.0.3',
      info: {
        title: 'Secure QR Verification System API',
        version: '1.0.0',
        description: 'REST API for user self-registration, OTP verification, admin approval, 256-bit QR issuance, live scanner verification, and Excel export.',
      },
      paths: {
        '/api/v1/auth/register': {post: {summary: 'Submit new user registration with verified OTP'}},
        '/api/v1/auth/otp/send': {post: {summary: 'Dispatch 6-digit hashed OTP'}},
        '/api/v1/auth/otp/verify': {post: {summary: 'Verify 6-digit OTP'}},
        '/api/v1/auth/login': {post: {summary: 'User portal JWT login'}},
        '/api/v1/auth/admin/login': {post: {summary: 'Admin portal JWT login'}},
        '/api/v1/user/dashboard': {get: {summary: 'Retrieve authenticated user application & active QR'}},
        '/api/v1/user/qr/download': {get: {summary: 'Download active QR credential PNG'}},
        '/api/v1/admin/dashboard/stats': {get: {summary: 'Retrieve admin KPI statistics & recent activity'}},
        '/api/v1/admin/registrations': {get: {summary: 'Filterable, paginated registration applications'}},
        '/api/v1/admin/registrations/{id}/approve': {post: {summary: 'Approve application and trigger atomic QR issuance'}},
        '/api/v1/admin/registrations/{id}/reject': {post: {summary: 'Reject application with mandatory reason'}},
        '/api/v1/admin/verify-qr': {post: {summary: 'Admin-only cryptographic QR verification'}},
        '/api/v1/admin/export/excel': {get: {summary: 'Export filtered records to formatted XLSX'}},
      },
    });
  });

  return router;
}
