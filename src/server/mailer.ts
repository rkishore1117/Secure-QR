import dns from 'node:dns';
import nodemailer from 'nodemailer';
import {executeSql, getEnvValue, queryOne, queryRows, toMysqlDateTime} from './db';
import {buildVerifiedUsersWorkbook} from './excel';

// Prefer IPv4 first on cloud runtimes (Render/containers often lack IPv6 egress)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore on older runtimes
}

let dailyIntervalHandle: ReturnType<typeof setInterval> | null = null;

export type EmailProviderKind =
  | 'https-webhook'
  | 'brevo-https'
  | 'resend-https'
  | 'gmail-smtp'
  | 'console';

export const EMAIL_SETTINGS_KEYS = new Set<string>([
  'email_preferred_provider',
  'email_webhook_url',
  'email_webhook_secret',
  'brevo_api_key',
  'resend_api_key',
  'resend_from_email',
  'smtp_host',
  'smtp_port',
  'smtp_use_tls',
  'smtp_user',
  'smtp_password',
  'default_from_email',
]);

export interface EffectiveEmailRuntimeConfig {
  configured: boolean;
  mode: EmailProviderKind;
  configSource: 'env' | 'database' | 'mixed' | 'none';
  smtpConfigured: boolean;
  httpsConfigured: boolean;
  webhookUrl: string;
  webhookSecret: string;
  brevoApiKey: string;
  resendApiKey: string;
  resendFromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUseTls: boolean;
  smtpUser: string;
  smtpPassword: string;
  defaultFromEmail: string;
}

export interface EmailSettingsMaskedSummary {
  activeProvider: EmailProviderKind;
  configured: boolean;
  configSource: 'env' | 'database' | 'mixed' | 'none';
  preferredProvider: string;
  webhookUrl: string;
  hasWebhookSecret: boolean;
  hasBrevoKey: boolean;
  hasResendKey: boolean;
  resendFromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUseTls: boolean;
  smtpUser: string;
  hasSmtpPassword: boolean;
  defaultFromEmail: string;
}

export interface EmailReportResult {
  success: boolean;
  recipient: string;
  recordCount: number;
  filename: string;
  sentAt: string;
  provider?: EmailProviderKind;
  error?: string;
}

export interface EmailOtpResult {
  dispatched: boolean;
  provider: EmailProviderKind;
  recipient: string;
  error?: string;
}

interface OutgoingEmailPayload {
  fromEmail: string;
  senderName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: {
    filename: string;
    content: Buffer;
    contentType: string;
  }[];
}

export function getEmailDeliveryConfig(): {
  configured: boolean;
  mode: EmailProviderKind;
  smtpConfigured: boolean;
  httpsConfigured: boolean;
} {
  const hasWebhook = Boolean(getEnvValue('EMAIL_WEBHOOK_URL'));
  const hasBrevo = Boolean(getEnvValue('BREVO_API_KEY'));
  const hasResend = Boolean(getEnvValue('RESEND_API_KEY'));
  const hasSmtp = Boolean(
    getEnvValue('EMAIL_HOST_USER') && getEnvValue('EMAIL_HOST_PASSWORD'),
  );

  let mode: EmailProviderKind = 'console';
  if (hasWebhook) mode = 'https-webhook';
  else if (hasBrevo) mode = 'brevo-https';
  else if (hasResend) mode = 'resend-https';
  else if (hasSmtp) mode = 'gmail-smtp';

  return {
    configured: hasWebhook || hasBrevo || hasResend || hasSmtp,
    mode,
    smtpConfigured: hasSmtp,
    httpsConfigured: hasWebhook || hasBrevo || hasResend,
  };
}

async function readDbEmailSettingsMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const rows = await queryRows<{key: string; value: string}>(
      'SELECT `key` AS `key`, `value` AS `value` FROM system_settings',
    );
    for (const row of rows) {
      if (EMAIL_SETTINGS_KEYS.has(row.key) && typeof row.value === 'string' && row.value.trim()) {
        map[row.key] = row.value.trim();
      }
    }
  } catch {
    // system_settings may not exist yet before DB bootstrap completes
  }
  return map;
}

export async function getEffectiveEmailDeliveryConfig(): Promise<EffectiveEmailRuntimeConfig> {
  const db = await readDbEmailSettingsMap();

  const pick = (envKey: string, dbKey: string): {val: string; from: 'env' | 'database' | 'none'} => {
    const envVal = getEnvValue(envKey);
    if (envVal) return {val: envVal, from: 'env'};
    const dbVal = db[dbKey] || '';
    if (dbVal) return {val: dbVal, from: 'database'};
    return {val: '', from: 'none'};
  };

  const webhookUrlPick = pick('EMAIL_WEBHOOK_URL', 'email_webhook_url');
  const webhookSecretPick = pick('EMAIL_WEBHOOK_SECRET', 'email_webhook_secret');
  const brevoPick = pick('BREVO_API_KEY', 'brevo_api_key');
  const resendPick = pick('RESEND_API_KEY', 'resend_api_key');
  const resendFromPick = pick('RESEND_FROM_EMAIL', 'resend_from_email');
  const smtpHostPick = pick('EMAIL_HOST', 'smtp_host');
  const smtpPortPick = pick('EMAIL_PORT', 'smtp_port');
  const smtpTlsPick = pick('EMAIL_USE_TLS', 'smtp_use_tls');
  const smtpUserPick = pick('EMAIL_HOST_USER', 'smtp_user');
  const smtpPassPick = pick('EMAIL_HOST_PASSWORD', 'smtp_password');
  const defaultFromPick = pick('DEFAULT_FROM_EMAIL', 'default_from_email');

  const hasWebhook = Boolean(webhookUrlPick.val);
  const hasBrevo = Boolean(brevoPick.val);
  const hasResend = Boolean(resendPick.val);
  const hasSmtp = Boolean(smtpUserPick.val && smtpPassPick.val);

  const preferred = db['email_preferred_provider'] || '';
  const isAvailable = (p: string): boolean => {
    if (p === 'https-webhook') return hasWebhook;
    if (p === 'brevo-https') return hasBrevo;
    if (p === 'resend-https') return hasResend;
    if (p === 'gmail-smtp') return hasSmtp;
    return false;
  };

  let mode: EmailProviderKind = 'console';
  if (preferred && isAvailable(preferred)) {
    mode = preferred as EmailProviderKind;
  } else if (hasWebhook) {
    mode = 'https-webhook';
  } else if (hasBrevo) {
    mode = 'brevo-https';
  } else if (hasResend) {
    mode = 'resend-https';
  } else if (hasSmtp) {
    mode = 'gmail-smtp';
  }

  const activeSources = new Set<'env' | 'database'>();
  if (mode === 'https-webhook') activeSources.add(webhookUrlPick.from === 'env' ? 'env' : 'database');
  if (mode === 'brevo-https') activeSources.add(brevoPick.from === 'env' ? 'env' : 'database');
  if (mode === 'resend-https') activeSources.add(resendPick.from === 'env' ? 'env' : 'database');
  if (mode === 'gmail-smtp') {
    if (smtpUserPick.from !== 'none') activeSources.add(smtpUserPick.from);
    if (smtpPassPick.from !== 'none') activeSources.add(smtpPassPick.from);
  }

  let configSource: 'env' | 'database' | 'mixed' | 'none' = 'none';
  if (activeSources.size === 1) {
    configSource = activeSources.has('env') ? 'env' : 'database';
  } else if (activeSources.size > 1) {
    configSource = 'mixed';
  }

  return {
    configured: hasWebhook || hasBrevo || hasResend || hasSmtp,
    mode,
    configSource,
    smtpConfigured: hasSmtp,
    httpsConfigured: hasWebhook || hasBrevo || hasResend,
    webhookUrl: webhookUrlPick.val,
    webhookSecret: webhookSecretPick.val,
    brevoApiKey: brevoPick.val,
    resendApiKey: resendPick.val,
    resendFromEmail: resendFromPick.val,
    smtpHost: smtpHostPick.val || 'smtp.gmail.com',
    smtpPort: Number.parseInt(smtpPortPick.val || '587', 10) || 587,
    smtpUseTls: (smtpTlsPick.val || 'True').toLowerCase() === 'true',
    smtpUser: smtpUserPick.val,
    smtpPassword: smtpPassPick.val,
    defaultFromEmail: defaultFromPick.val || smtpUserPick.val || 'kishore.sathayush@gmail.com',
  };
}

export async function getEmailSettingsMaskedSummary(): Promise<EmailSettingsMaskedSummary> {
  const cfg = await getEffectiveEmailDeliveryConfig();
  const db = await readDbEmailSettingsMap();
  return {
    activeProvider: cfg.mode,
    configured: cfg.configured,
    configSource: cfg.configSource,
    preferredProvider: db['email_preferred_provider'] || cfg.mode,
    webhookUrl: cfg.webhookUrl,
    hasWebhookSecret: Boolean(cfg.webhookSecret),
    hasBrevoKey: Boolean(cfg.brevoApiKey),
    hasResendKey: Boolean(cfg.resendApiKey),
    resendFromEmail: cfg.resendFromEmail,
    smtpHost: cfg.smtpHost,
    smtpPort: cfg.smtpPort,
    smtpUseTls: cfg.smtpUseTls,
    smtpUser: cfg.smtpUser,
    hasSmtpPassword: Boolean(cfg.smtpPassword),
    defaultFromEmail: cfg.defaultFromEmail,
  };
}

function createSmtpTransport(cfg: EffectiveEmailRuntimeConfig, portOverride?: number) {
  if (!cfg.smtpUser || !cfg.smtpPassword) {
    return null;
  }
  const port = portOverride ?? cfg.smtpPort;

  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port,
    secure: port === 465,
    requireTLS: cfg.smtpUseTls && port !== 465,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
    auth: {
      user: cfg.smtpUser,
      pass: cfg.smtpPassword,
    },
  });
}

async function sendViaAppsScriptWebhook(
  payload: OutgoingEmailPayload,
  cfg: EffectiveEmailRuntimeConfig,
): Promise<void> {
  if (!cfg.webhookUrl) throw new Error('EMAIL_WEBHOOK_URL is not configured.');

  const res = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      secret: cfg.webhookSecret,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      senderName: payload.senderName,
      attachments: (payload.attachments || []).map((att) => ({
        filename: att.filename,
        contentType: att.contentType,
        base64: att.content.toString('base64'),
      })),
    }),
    signal: AbortSignal.timeout(15000),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Apps Script webhook HTTP ${res.status}: ${bodyText.slice(0, 180)}`);
  }
  try {
    const parsed = JSON.parse(bodyText) as {ok?: boolean; error?: string};
    if (parsed.ok === false) {
      throw new Error(parsed.error || 'Apps Script webhook returned ok=false');
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      if (bodyText.includes('ServiceLogin') || bodyText.includes('accounts.google.com')) {
        throw new Error(
          'Apps Script URL requires Web App access set to "Anyone" (redirected to Google login).',
        );
      }
      return;
    }
    throw err;
  }
}

async function sendViaBrevoHttps(
  payload: OutgoingEmailPayload,
  cfg: EffectiveEmailRuntimeConfig,
): Promise<void> {
  if (!cfg.brevoApiKey) throw new Error('BREVO_API_KEY is not configured.');

  const body: Record<string, unknown> = {
    sender: {name: payload.senderName, email: payload.fromEmail},
    to: [{email: payload.to}],
    subject: payload.subject,
    textContent: payload.text,
    htmlContent: payload.html,
  };

  if (payload.attachments && payload.attachments.length > 0) {
    body['attachment'] = payload.attachments.map((att) => ({
      name: att.filename,
      content: att.content.toString('base64'),
    }));
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': cfg.brevoApiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Brevo API ${res.status}: ${errBody.slice(0, 200)}`);
  }
}

async function sendViaResendHttps(
  payload: OutgoingEmailPayload,
  cfg: EffectiveEmailRuntimeConfig,
): Promise<void> {
  if (!cfg.resendApiKey) throw new Error('RESEND_API_KEY is not configured.');

  const fromHeader = cfg.resendFromEmail || `${payload.senderName} <${payload.fromEmail}>`;
  const body: Record<string, unknown> = {
    from: fromHeader,
    to: [payload.to],
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  };

  if (payload.attachments && payload.attachments.length > 0) {
    body['attachments'] = payload.attachments.map((att) => ({
      filename: att.filename,
      content: att.content.toString('base64'),
    }));
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend API ${res.status}: ${errBody.slice(0, 200)}`);
  }
}

async function sendViaSmtpWithFallback(
  payload: OutgoingEmailPayload,
  cfg: EffectiveEmailRuntimeConfig,
): Promise<void> {
  const primaryTransport = createSmtpTransport(cfg, cfg.smtpPort);
  if (!primaryTransport) {
    throw new Error('Email SMTP credentials (EMAIL_HOST_USER / EMAIL_HOST_PASSWORD) are not configured.');
  }

  const mailOptions = {
    from: `"${payload.senderName}" <${payload.fromEmail}>`,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    attachments: payload.attachments,
  };

  try {
    await primaryTransport.sendMail(mailOptions);
  } catch (primaryErr) {
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    const isNetworkTimeout =
      /timeout|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i.test(msg);

    // Retry once on alternate SSL/TLS port (465 vs 587) before failing
    const altPort = cfg.smtpPort === 465 ? 587 : 465;
    if (isNetworkTimeout) {
      const altTransport = createSmtpTransport(cfg, altPort);
      if (altTransport) {
        try {
          await altTransport.sendMail(mailOptions);
          return;
        } catch {
          throw new Error(
            `${msg} — Outbound SMTP ports 465/587 are blocked on free cloud hosting. Configure an HTTPS provider (EMAIL_WEBHOOK_URL or BREVO_API_KEY) in Admin Settings or Environment Variables.`,
          );
        }
      }
    }
    throw primaryErr;
  }
}

async function dispatchOutgoingEmail(
  payload: OutgoingEmailPayload,
  cfgOverride?: EffectiveEmailRuntimeConfig,
): Promise<{dispatched: boolean; provider: EmailProviderKind; error?: string}> {
  const cfg = cfgOverride ?? (await getEffectiveEmailDeliveryConfig());
  if (!cfg.configured) {
    return {
      dispatched: false,
      provider: 'console',
      error:
        'No email delivery provider is configured. Configure EMAIL_WEBHOOK_URL, BREVO_API_KEY, RESEND_API_KEY, or SMTP credentials in Admin Portal → System Settings (or in deployment Environment Variables).',
    };
  }

  try {
    if (cfg.mode === 'https-webhook') {
      await sendViaAppsScriptWebhook(payload, cfg);
      return {dispatched: true, provider: 'https-webhook'};
    }
    if (cfg.mode === 'brevo-https') {
      await sendViaBrevoHttps(payload, cfg);
      return {dispatched: true, provider: 'brevo-https'};
    }
    if (cfg.mode === 'resend-https') {
      await sendViaResendHttps(payload, cfg);
      return {dispatched: true, provider: 'resend-https'};
    }
    await sendViaSmtpWithFallback(payload, cfg);
    return {dispatched: true, provider: 'gmail-smtp'};
  } catch (err) {
    return {
      dispatched: false,
      provider: cfg.mode,
      error: err instanceof Error ? err.message : 'Email delivery failed',
    };
  }
}

export async function sendTestEmail(
  recipientEmail: string,
): Promise<{success: boolean; provider: EmailProviderKind; recipient: string; error?: string}> {
  const cfg = await getEffectiveEmailDeliveryConfig();
  const result = await dispatchOutgoingEmail(
    {
      fromEmail: cfg.defaultFromEmail,
      senderName: 'Secure QR Verification',
      to: recipientEmail,
      subject: 'Secure QR — Email Delivery Test Successful',
      text: `Hello,\n\nThis is a live test email from your Secure QR Verification System (${cfg.mode}).\nYour OTP verification codes and 24-hour member Excel reports are ready to deliver.\n\nSent at (UTC): ${new Date().toISOString()}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #0F172A; line-height: 1.6; max-width: 520px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px; background: #FFFFFF;">
          <h2 style="margin: 0 0 8px 0; color: #0F172A; font-size: 18px;">Email Delivery Verified</h2>
          <p style="margin: 0 0 12px 0; color: #475569; font-size: 14px;">
            Your Secure QR Verification System successfully delivered a test message via <strong>${cfg.mode}</strong>.
          </p>
          <p style="margin: 0; color: #64748B; font-size: 12px;">
            Timestamp (UTC): ${new Date().toISOString()}
          </p>
        </div>
      `,
    },
    cfg,
  );

  return {
    success: result.dispatched,
    provider: result.provider,
    recipient: recipientEmail,
    ...(result.error ? {error: result.error} : {}),
  };
}

export async function sendVerificationOtpEmail(
  recipientEmail: string,
  otp: string,
  expiryMinutes = 5,
  isResend = false,
  purpose: 'REGISTRATION' | 'PASSWORD_RESET' = 'REGISTRATION',
): Promise<EmailOtpResult> {
  const cfg = await getEffectiveEmailDeliveryConfig();
  const fromEmail = cfg.defaultFromEmail;

  const isReset = purpose === 'PASSWORD_RESET';
  const subject = isReset
    ? isResend
      ? `Resent Password Reset Code (${otp}) — Secure QR`
      : `Password Reset Verification Code (${otp}) — Secure QR`
    : isResend
      ? `Your Resent Verification Code (${otp}) — Secure QR`
      : `Your Verification Code (${otp}) — Secure QR`;
  const heading = isReset ? 'Reset Your Account Password' : 'Verify Your Email Address';
  const intro = isReset
    ? 'Use the 6-digit verification code below to reset the password for your Secure QR account.'
    : 'Use the 6-digit verification code below to finish setting up your Secure QR registration.';

  const result = await dispatchOutgoingEmail(
    {
      fromEmail,
      senderName: 'Secure QR Verification',
      to: recipientEmail,
      subject,
      text: `Hello,\n\nYour one-time verification code ${isReset ? 'to reset your Secure QR account password' : 'to verify your Secure QR account email'} is: ${otp}\n\nThis code is valid for ${expiryMinutes} minutes. Please do not share it with anyone.\n\nIf you did not request this code, you can safely ignore this email.\n\nThank you,\nTeam Sathayush`,
      html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #0F172A; line-height: 1.6; max-width: 520px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 12px; padding: 28px; background: #FFFFFF;">
        <h2 style="margin: 0 0 10px 0; color: #0F172A; font-size: 20px;">${heading}</h2>
        <p style="margin: 0 0 18px 0; color: #475569; font-size: 14px;">
          ${intro}
        </p>
        <div style="background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 10px; padding: 18px; text-align: center; margin: 20px 0;">
          <span style="font-family: 'SFMono-Regular', Consolas, monospace; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #0F172A;">${otp}</span>
        </div>
        <p style="margin: 0 0 8px 0; color: #475569; font-size: 13px;">
          This code expires in <strong>${expiryMinutes} minutes</strong>. Never share your verification code with anyone.
        </p>
        <p style="margin: 18px 0 0 0; color: #64748B; font-size: 12px; border-top: 1px solid #E2E8F0; padding-top: 14px;">
          Sent by Team Sathayush · Secure QR Verification System
        </p>
      </div>
    `,
    },
    cfg,
  );

  return {
    dispatched: result.dispatched,
    provider: result.provider,
    recipient: recipientEmail,
    ...(result.error ? {error: result.error} : {}),
  };
}

export async function sendDailyVerificationExcelReport(
  triggerType: 'SCHEDULED_24H' | 'MANUAL' = 'SCHEDULED_24H',
): Promise<EmailReportResult> {
  const cfg = await getEffectiveEmailDeliveryConfig();
  const recipient =
    getEnvValue('DAILY_REPORT_RECIPIENT_EMAIL') ||
    getEnvValue('FIXED_ADMIN_EMAIL') ||
    'kishore.sathayush@gmail.com';
  const fromEmail = cfg.defaultFromEmail;
  const now = new Date();
  const sentAtIso = now.toISOString();
  const sentAtMysql = toMysqlDateTime(now);

  const {buffer, recordCount, filename} = await buildVerifiedUsersWorkbook({status: 'ALL'});

  const result = await dispatchOutgoingEmail(
    {
      fromEmail,
      senderName: 'Secure QR Team',
      to: recipient,
      subject: `Daily Member Verification Report — ${sentAtIso.slice(0, 10)}`,
      text: `Hello Kishore,\n\nAttached is today's verified member Excel report (${filename}) with ${recordCount} member record(s), covering registration details, approval status, and QR pass validity.\n\nGenerated at (UTC): ${sentAtIso}\nSent via: ${triggerType === 'MANUAL' ? 'Manual Admin Request' : 'Automated 24-Hour Schedule'}\n\nWarm regards,\nSecure QR Verification Team`,
      html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #0F172A; line-height: 1.6; max-width: 600px;">
        <h2 style="margin-bottom: 8px; color: #0F172A;">Daily Member Verification Summary</h2>
        <p>Hello Kishore,</p>
        <p>Attached is today's updated Excel workbook (<strong>${filename}</strong>) containing all member profiles, approval statuses, and QR pass details.</p>
        <table style="border-collapse: collapse; margin: 16px 0; font-size: 14px;">
          <tr>
            <td style="padding: 6px 12px 6px 0; color: #475569;"><strong>Total Members Included:</strong></td>
            <td style="padding: 6px 0;">${recordCount}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; color: #475569;"><strong>Report Generated (UTC):</strong></td>
            <td style="padding: 6px 0;">${sentAtIso}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; color: #475569;"><strong>Dispatch Type:</strong></td>
            <td style="padding: 6px 0;">${triggerType === 'MANUAL' ? 'Sent Manually by Admin' : 'Automated 24-Hour Schedule'}</td>
          </tr>
        </table>
        <p style="color: #475569; font-size: 13px;">Warm regards,<br/>Secure QR Verification Team</p>
      </div>
    `,
      attachments: [
        {
          filename,
          content: buffer,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
    },
    cfg,
  );

  if (result.dispatched) {
    await executeSql(
      `INSERT INTO scheduled_report_logs
        (recipient_email, record_count, filename, status, error_message, trigger_type, sent_at)
       VALUES (?, ?, ?, 'SENT', NULL, ?, ?)`,
      [recipient, recordCount, filename, triggerType, sentAtMysql],
    );

    await executeSql(
      `INSERT INTO admin_activity_logs
        (actor_user_id, actor_email, actor_role, action, target_type, target_id, details_json, created_at)
       VALUES (NULL, 'system-scheduler', 'SUPER_ADMIN', 'DAILY_EXCEL_EMAIL_SENT', 'REPORT', ?, ?, ?)`,
      [filename, JSON.stringify({recipient, recordCount, triggerType, provider: result.provider}), sentAtMysql],
    );

    return {
      success: true,
      recipient,
      recordCount,
      filename,
      sentAt: sentAtIso,
      provider: result.provider,
    };
  }

  const errMsg = result.error || 'Email delivery failed';
  await executeSql(
    `INSERT INTO scheduled_report_logs
      (recipient_email, record_count, filename, status, error_message, trigger_type, sent_at)
     VALUES (?, ?, ?, 'FAILED', ?, ?, ?)`,
    [recipient, recordCount, filename, errMsg, triggerType, sentAtMysql],
  );
  return {
    success: false,
    recipient,
    recordCount,
    filename,
    sentAt: sentAtIso,
    provider: result.provider,
    error: errMsg,
  };
}

export async function startDailyReportScheduler(): Promise<void> {
  if (dailyIntervalHandle) return;
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  try {
    const last = await queryOne<{sent_at: Date | string}>(
      "SELECT sent_at FROM scheduled_report_logs WHERE status = 'SENT' ORDER BY id DESC LIMIT 1",
    );
    if (last) {
      const elapsed = Date.now() - new Date(last.sent_at).getTime();
      if (elapsed >= TWENTY_FOUR_HOURS_MS) {
        void sendDailyVerificationExcelReport('SCHEDULED_24H');
      }
    }
  } catch {
    // ignore startup check failure
  }

  dailyIntervalHandle = setInterval(() => {
    void sendDailyVerificationExcelReport('SCHEDULED_24H');
  }, TWENTY_FOUR_HOURS_MS);
}
