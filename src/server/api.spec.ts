import {describe, it, expect, beforeAll} from 'vitest';
import express from 'express';
import http from 'node:http';
import {
  generateNumericOtp,
  generateSecureQrToken,
  hashOtp,
  hashPassword,
  sha256Hex,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from './crypto';
import {ensureSeeded, executeSql, queryOne} from './db';
import {
  EmailDeliveryService,
  type EmailTransport,
  type EmailTransportContext,
} from './email-transport';
import {createApiRouter} from './routes';

async function requestJson(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
): Promise<{status: number; data: Record<string, unknown>; headers: Headers; raw: ArrayBuffer}> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const raw = await res.arrayBuffer();
  let data: Record<string, unknown> = {};
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
  }
  return {status: res.status, data, headers: res.headers, raw};
}

describe('Secure QR Verification System — Crypto & API Integration', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    try {
      (process as unknown as {loadEnvFile?: () => void}).loadEnvFile?.();
    } catch {
      // Optional .env file
    }
    await ensureSeeded('http://localhost:3000');

    const app = express();
    app.use(express.json({limit: '4mb'}));
    app.use('/api/v1', createApiRouter());

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as {port: number};
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    return () => {
      server.close();
    };
  }, 30000);

  it('hashes and verifies passwords with scrypt timing-safe equality', () => {
    const hash = hashPassword('Str0ngPass!2026');
    expect(hash).toContain(':');
    expect(verifyPassword('Str0ngPass!2026', hash)).toBe(true);
    expect(verifyPassword('WrongPass', hash)).toBe(false);
  });

  it('generates 256-bit QR tokens and verifies HMAC-hashed OTPs', () => {
    const token = generateSecureQrToken();
    expect(token.length).toBeGreaterThanOrEqual(42);
    expect(sha256Hex(token)).toHaveLength(64);

    const otp = generateNumericOtp();
    expect(otp).toMatch(/^\d{6}$/);
    expect(hashOtp('+15551234567', otp)).toBe(hashOtp('+15551234567', otp));
    expect(hashOtp('+15551234567', otp)).not.toBe(hashOtp('+15559999999', otp));
  });

  it('signs and verifies HS256 JWT access tokens', () => {
    const fixedEmail = process.env['FIXED_ADMIN_EMAIL'] || 'kishore.sathayush@gmail.com';
    const jwt = signAccessToken({
      sub: 1,
      email: fixedEmail,
      role: 'SUPER_ADMIN',
      permissions: ['can_scan_qr'],
    });
    const decoded = verifyAccessToken(jwt);
    expect(decoded?.sub).toBe(1);
    expect(decoded?.email).toBe(fixedEmail);
    expect(decoded?.role).toBe('SUPER_ADMIN');
    expect(verifyAccessToken(`${jwt}tampered`)).toBeNull();
  });

  it('switches automatically between SMTP and HTTPS relays based on availability and failover', async () => {
    const baseCtx: EmailTransportContext = {
      configured: true,
      mode: 'gmail-smtp',
      configSource: 'env',
      preferredProvider: 'gmail-smtp',
      smtpConfigured: true,
      httpsConfigured: true,
      isCloudRuntime: true,
      webhookUrl: '',
      webhookSecret: '',
      brevoApiKey: 'test-brevo-key',
      resendApiKey: '',
      resendFromEmail: '',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 587,
      smtpUseTls: true,
      smtpUser: 'sender@example.com',
      smtpPassword: 'app-password',
      defaultFromEmail: 'sender@example.com',
    };

    const failingSmtp: EmailTransport = {
      kind: 'gmail-smtp',
      transportType: 'smtp',
      displayName: 'Mock SMTP',
      isAvailable: (ctx) => Boolean(ctx.smtpUser && ctx.smtpPassword),
      send: async () => {
        throw new Error('ETIMEDOUT port 587 blocked on free tier');
      },
    };
    const workingBrevo: EmailTransport = {
      kind: 'brevo-https',
      transportType: 'https',
      displayName: 'Mock Brevo HTTPS',
      isAvailable: (ctx) => Boolean(ctx.brevoApiKey),
      send: async () => {
        return;
      },
    };

    const svc = new EmailDeliveryService([failingSmtp, workingBrevo]);
    const payload = {
      fromEmail: 'sender@example.com',
      senderName: 'Secure QR',
      to: 'member@example.com',
      subject: 'Test',
      text: 'Hello',
      html: '<p>Hello</p>',
    };

    // 1. Fails over from preferred SMTP timeout to Brevo HTTPS automatically
    const failoverRes = await svc.send(payload, baseCtx);
    expect(failoverRes.dispatched).toBe(true);
    expect(failoverRes.provider).toBe('brevo-https');
    expect(failoverRes.switchedOver).toBe(true);
    expect(failoverRes.attemptedProviders).toEqual(['gmail-smtp', 'brevo-https']);

    // 2. Without explicit SMTP preference, prioritizes HTTPS relays first
    const defaultChain = svc.resolveTransportChain({...baseCtx, preferredProvider: ''});
    expect(defaultChain.map((t) => t.kind)).toEqual(['brevo-https', 'gmail-smtp']);

    // 3. Returns clean unconfigured outcome when neither transport has credentials
    const noneRes = await svc.send(payload, {
      ...baseCtx,
      brevoApiKey: '',
      smtpUser: '',
      smtpPassword: '',
      configured: false,
    });
    expect(noneRes.dispatched).toBe(false);
    expect(noneRes.provider).toBe('console');
  });

  it('enforces RBAC, completes OTP -> Registration -> Admin Approval -> QR Verification -> Revoke -> Excel Export', async () => {
    const uniqueSuffix = Date.now().toString().slice(-6);
    const mobile = `+15559${uniqueSuffix}`;
    const email = `applicant.${uniqueSuffix}@test.org`;
    const fixedEmail = process.env['FIXED_ADMIN_EMAIL'] || 'kishore.sathayush@gmail.com';
    const fixedPassword = process.env['FIXED_ADMIN_PASSWORD'] || 'Admin@955';
    const fixedMobile = process.env['FIXED_ADMIN_MOBILE'] || '+919550000955';

    try {
      const healthRes = await requestJson(baseUrl, '/api/v1/public/health');
      expect(healthRes.status).toBe(200);
      expect(typeof healthRes.data['databaseConnected']).toBe('boolean');
      expect(typeof healthRes.data['emailConfigured']).toBe('boolean');

      // 1. Duplicate check works against existing Fixed Super Admin account
      const dupRes = await requestJson(baseUrl, '/api/v1/auth/check-availability', {
        method: 'POST',
        body: JSON.stringify({email: fixedEmail, mobile: fixedMobile}),
      });
      expect(dupRes.status).toBe(200);
      expect(dupRes.data['emailAvailable']).toBe(false);
      expect(dupRes.data['mobileAvailable']).toBe(false);

      // 2. Send Email OTP & Verify Email OTP
      const sendOtpRes = await requestJson(baseUrl, '/api/v1/auth/otp/send', {
        method: 'POST',
        body: JSON.stringify({email, purpose: 'REGISTRATION'}),
      });
      expect(sendOtpRes.status).toBe(200);
      expect(sendOtpRes.data['emailDispatched']).toBe(true);
      expect(['gmail-smtp', 'https-webhook', 'brevo-https', 'resend-https']).toContain(
        sendOtpRes.data['emailProvider'],
      );
      const hintOtp = String(sendOtpRes.data['devOtpHint']);
      expect(hintOtp).toMatch(/^\d{6}$/);

      // Invalid OTP attempt increments failure
      const badVerify = await requestJson(baseUrl, '/api/v1/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({email, otp: '000000'}),
      });
      expect(badVerify.status).toBe(400);

      const goodVerify = await requestJson(baseUrl, '/api/v1/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({email, otp: hintOtp}),
      });
      expect(goodVerify.status).toBe(200);
      const otpVerificationId = Number(goodVerify.data['otpVerificationId']);

      // 3. Submit Registration (1x1 transparent PNG data URL)
      const samplePng =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

      const regRes = await requestJson(baseUrl, '/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          fullName: 'Test Applicant',
          email,
          password: 'Password@2026',
          mobile,
          otpVerificationId,
          address: '100 Market St',
          city: 'San Francisco',
          district: 'SF',
          state: 'California',
          country: 'United States',
          postalCode: '94105',
          idProofType: 'National Passport',
          profilePhotoData: samplePng,
          idProofData: samplePng,
          dynamicFields: {organization: 'QA Labs', access_tier: 'Standard Member'},
          consentAccepted: true,
        }),
      });
      expect(regRes.status).toBe(201);
      expect(regRes.data['status']).toBe('PENDING');
      const regId = String(regRes.data['registrationId']);

      // 4. User Login & RBAC check (User must be denied Admin routes)
      const userLogin = await requestJson(baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({identifier: email, password: 'Password@2026'}),
      });
      expect(userLogin.status).toBe(200);
      const userToken = String(userLogin.data['accessToken']);

      const forbiddenAdmin = await requestJson(baseUrl, '/api/v1/admin/dashboard/stats', {
        headers: {Authorization: `Bearer ${userToken}`},
      });
      expect(forbiddenAdmin.status).toBe(403);

      // Pending user cannot download QR yet
      const pendingQrDownload = await requestJson(baseUrl, '/api/v1/user/qr/download', {
        headers: {Authorization: `Bearer ${userToken}`},
      });
      expect(pendingQrDownload.status).toBe(403);

      // 5. Fixed Super Admin Login, Find Pending Record, Approve & Issue QR
      const adminLogin = await requestJson(baseUrl, '/api/v1/auth/admin/login', {
        method: 'POST',
        body: JSON.stringify({identifier: fixedEmail, password: fixedPassword}),
      });
      expect(adminLogin.status).toBe(200);
      const adminToken = String(adminLogin.data['accessToken']);

      const listRes = await requestJson(
        baseUrl,
        `/api/v1/admin/registrations?search=${encodeURIComponent(regId)}`,
        {headers: {Authorization: `Bearer ${adminToken}`}},
      );
      expect(listRes.status).toBe(200);
      expect(listRes.data['counts']).toBeTruthy();
    const items = listRes.data['items'] as {id: number}[];
    expect(items.length).toBe(1);
    const recordId = items[0].id;

    const approveRes = await requestJson(baseUrl, `/api/v1/admin/registrations/${recordId}/approve`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${adminToken}`},
      body: JSON.stringify({note: 'Automated test approval'}),
    });
    expect(approveRes.status).toBe(200);
    expect(approveRes.data['status']).toBe('APPROVED');

    // 6. User fetches dashboard & active QR verification URL, downloads QR PNG
    const userDash = await requestJson(baseUrl, '/api/v1/user/dashboard', {
      headers: {Authorization: `Bearer ${userToken}`},
    });
    expect(userDash.status).toBe(200);
    const activeQr = userDash.data['activeQr'] as {id: number; verification_url: string};
    expect(activeQr).toBeTruthy();

    const qrPng = await requestJson(baseUrl, '/api/v1/user/qr/download', {
      headers: {Authorization: `Bearer ${userToken}`},
    });
    expect(qrPng.status).toBe(200);
    expect(qrPng.headers.get('content-type')).toContain('image/png');

    // 7. Admin verifies QR -> VALID QR, Invalid token -> INVALID QR, Revoke -> REVOKED QR
    const verifyValid = await requestJson(baseUrl, '/api/v1/admin/verify-qr', {
      method: 'POST',
      headers: {Authorization: `Bearer ${adminToken}`},
      body: JSON.stringify({payload: activeQr.verification_url}),
    });
    expect(verifyValid.status).toBe(200);
    expect(verifyValid.data['resultStatus']).toBe('VALID');

    const verifyInvalid = await requestJson(baseUrl, '/api/v1/admin/verify-qr', {
      method: 'POST',
      headers: {Authorization: `Bearer ${adminToken}`},
      body: JSON.stringify({payload: 'https://example.com/verify?token=nonexistent_fake_token'}),
    });
    expect(verifyInvalid.status).toBe(200);
    expect(verifyInvalid.data['resultStatus']).toBe('INVALID');

    const revokeRes = await requestJson(baseUrl, `/api/v1/admin/qrs/${activeQr.id}/revoke`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${adminToken}`},
      body: JSON.stringify({reason: 'Test revocation'}),
    });
    expect(revokeRes.status).toBe(200);

    const verifyRevoked = await requestJson(baseUrl, '/api/v1/admin/verify-qr', {
      method: 'POST',
      headers: {Authorization: `Bearer ${adminToken}`},
      body: JSON.stringify({payload: activeQr.verification_url}),
    });
    expect(verifyRevoked.status).toBe(200);
    expect(verifyRevoked.data['resultStatus']).toBe('REVOKED');

    // 8. Admin Excel Export returns valid XLSX binary
    const excelRes = await requestJson(baseUrl, '/api/v1/admin/export/excel?status=APPROVED', {
      headers: {Authorization: `Bearer ${adminToken}`},
    });
    expect(excelRes.status).toBe(200);
    expect(excelRes.headers.get('content-type')).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(excelRes.raw.byteLength).toBeGreaterThan(1000);

    // 9. Forgot Password / Reset flow
    const resetMissingRes = await requestJson(baseUrl, '/api/v1/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({email: `missing.${uniqueSuffix}@test.org`, purpose: 'PASSWORD_RESET'}),
    });
    expect(resetMissingRes.status).toBe(404);

    const resetOtpSend = await requestJson(baseUrl, '/api/v1/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({email, purpose: 'PASSWORD_RESET'}),
    });
    expect(resetOtpSend.status).toBe(200);
    expect(resetOtpSend.data['emailDispatched']).toBe(true);
    const resetHintOtp = String(resetOtpSend.data['devOtpHint']);
    expect(resetHintOtp).toMatch(/^\d{6}$/);

    const resetOtpVerify = await requestJson(baseUrl, '/api/v1/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({email, otp: resetHintOtp, purpose: 'PASSWORD_RESET'}),
    });
    expect(resetOtpVerify.status).toBe(200);
    const resetVerificationId = Number(resetOtpVerify.data['otpVerificationId']);

    const resetConfirm = await requestJson(baseUrl, '/api/v1/auth/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify({
        email,
        otpVerificationId: resetVerificationId,
        newPassword: 'NewPassword@2026',
      }),
    });
    expect(resetConfirm.status).toBe(200);
    expect(resetConfirm.data['success']).toBe(true);

    const oldPassLogin = await requestJson(baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({identifier: email, password: 'Password@2026'}),
    });
    expect(oldPassLogin.status).toBe(401);

    const newPassLogin = await requestJson(baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({identifier: email, password: 'NewPassword@2026'}),
    });
    expect(newPassLogin.status).toBe(200);
    } finally {
      // Clean up synthetic test applicant records in strict dependency order so RDS stays clean
      const testAcc = await queryOne<{id: number}>(
        'SELECT id FROM user_accounts WHERE LOWER(email) = ?',
        [email],
      );
      if (testAcc) {
        const testRec = await queryOne<{id: number}>(
          'SELECT id FROM user_records WHERE user_id = ?',
          [testAcc.id],
        );
        if (testRec) {
          await executeSql('DELETE FROM qr_scan_logs WHERE user_record_id = ?', [testRec.id]);
          await executeSql('DELETE FROM qr_codes WHERE user_record_id = ?', [testRec.id]);
          await executeSql('DELETE FROM registration_requests WHERE user_record_id = ?', [testRec.id]);
          await executeSql('DELETE FROM user_records WHERE id = ?', [testRec.id]);
        }
        await executeSql('DELETE FROM refresh_tokens WHERE user_id = ?', [testAcc.id]);
        await executeSql('DELETE FROM notifications WHERE recipient_user_id = ?', [testAcc.id]);
        await executeSql('DELETE FROM user_accounts WHERE id = ?', [testAcc.id]);
      }
      await executeSql('DELETE FROM otp_verifications WHERE LOWER(email) = ?', [email]);
    }
  }, 45000);

  it('authenticates fixed Super Admin, inspects DB/gateway status, and logs 24h Excel email dispatch', async () => {
    const fixedEmail = process.env['FIXED_ADMIN_EMAIL'] || 'kishore.sathayush@gmail.com';
    const fixedPassword = process.env['FIXED_ADMIN_PASSWORD'] || '';
    expect(fixedPassword.length).toBeGreaterThan(0);

    const fixedLogin = await requestJson(baseUrl, '/api/v1/auth/admin/login', {
      method: 'POST',
      body: JSON.stringify({identifier: fixedEmail, password: fixedPassword}),
    });
    expect(fixedLogin.status).toBe(200);
    const fixedToken = String(fixedLogin.data['accessToken']);
    expect(fixedToken.length).toBeGreaterThan(20);

    const dbStatus = await requestJson(baseUrl, '/api/v1/admin/settings/db-status', {
      headers: {Authorization: `Bearer ${fixedToken}`},
    });
    expect(dbStatus.status).toBe(200);
    const dbInfo = dbStatus.data['database'] as Record<string, unknown>;
    const integrations = dbStatus.data['integrations'] as Record<string, unknown>;
    const emailSettings = dbStatus.data['emailSettings'] as Record<string, unknown>;
    expect(dbInfo['connected']).toBe(true);
    expect(dbInfo['database']).toBe('secure_qr_verification');
    expect(integrations['fixedAdminEmail']).toBe('kishore.sathayush@gmail.com');
    expect(integrations['emailOtpConfigured']).toBe(true);
    expect(integrations['smtpUser']).toBe('kishore.sathayush@gmail.com');
    expect(integrations['s3Configured']).toBe(true);
    expect(integrations['filePath']).toBe('https://sathayushstorage.s3.ap-south-1.amazonaws.com/sathayush/');
    expect(emailSettings).toBeTruthy();
    expect(typeof emailSettings['hasSmtpPassword']).toBe('boolean');
    expect(emailSettings['smtpPassword']).toBeUndefined();

    const sysSettings = await requestJson(baseUrl, '/api/v1/admin/settings', {
      headers: {Authorization: `Bearer ${fixedToken}`},
    });
    expect(sysSettings.status).toBe(200);
    const settingsObj = sysSettings.data['settings'] as Record<string, string>;
    expect(settingsObj['smtp_password']).toBeUndefined();
    expect(settingsObj['brevo_api_key']).toBeUndefined();

    const badEmailProvider = await requestJson(baseUrl, '/api/v1/admin/settings/email', {
      method: 'POST',
      headers: {Authorization: `Bearer ${fixedToken}`},
      body: JSON.stringify({provider: 'invalid-provider'}),
    });
    expect(badEmailProvider.status).toBe(400);

    const initMysql = await requestJson(baseUrl, '/api/v1/admin/settings/init-mysql', {
      method: 'POST',
      headers: {Authorization: `Bearer ${fixedToken}`},
    });
    expect(initMysql.status).toBe(200);
    expect(initMysql.data['database']).toBe('secure_qr_verification');

    const sendEmailRes = await requestJson(baseUrl, '/api/v1/admin/export/send-email-now', {
      method: 'POST',
      headers: {Authorization: `Bearer ${fixedToken}`},
    });
    expect(sendEmailRes.status).toBe(200);
    expect(sendEmailRes.data['recipient']).toBe('kishore.sathayush@gmail.com');
    expect(Number(sendEmailRes.data['recordCount'])).toBeGreaterThanOrEqual(0);

    const logsRes = await requestJson(baseUrl, '/api/v1/admin/export/scheduled-logs', {
      headers: {Authorization: `Bearer ${fixedToken}`},
    });
    expect(logsRes.status).toBe(200);
    expect(logsRes.data['recipientEmail']).toBe('kishore.sathayush@gmail.com');
    expect(logsRes.data['scheduleIntervalHours']).toBe(24);
    expect(typeof logsRes.data['emailDeliveryMode']).toBe('string');
    const logs = logsRes.data['logs'] as Record<string, unknown>[];
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]['trigger_type']).toBe('MANUAL');
  }, 30000);
});
