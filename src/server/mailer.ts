import dns from 'node:dns';
import nodemailer from 'nodemailer';
import {executeSql, getEnvValue, queryOne, toMysqlDateTime} from './db';
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

function createSmtpTransport(portOverride?: number) {
  const host = getEnvValue('EMAIL_HOST') || 'smtp.gmail.com';
  const port = portOverride ?? (Number.parseInt(getEnvValue('EMAIL_PORT') || '587', 10) || 587);
  const useTls = (getEnvValue('EMAIL_USE_TLS') || 'True').toLowerCase() === 'true';
  const user = getEnvValue('EMAIL_HOST_USER');
  const pass = getEnvValue('EMAIL_HOST_PASSWORD');

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: useTls && port !== 465,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
    auth: {
      user,
      pass,
    },
  });
}

async function sendViaAppsScriptWebhook(payload: OutgoingEmailPayload): Promise<void> {
  const webhookUrl = getEnvValue('EMAIL_WEBHOOK_URL');
  if (!webhookUrl) throw new Error('EMAIL_WEBHOOK_URL is not configured.');

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      secret: getEnvValue('EMAIL_WEBHOOK_SECRET'),
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
      // Non-JSON 200 HTML/text page should be flagged if it looks like Google sign-in page
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

async function sendViaBrevoHttps(payload: OutgoingEmailPayload): Promise<void> {
  const apiKey = getEnvValue('BREVO_API_KEY');
  if (!apiKey) throw new Error('BREVO_API_KEY is not configured.');

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
      'api-key': apiKey,
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

async function sendViaResendHttps(payload: OutgoingEmailPayload): Promise<void> {
  const apiKey = getEnvValue('RESEND_API_KEY');
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured.');

  const fromHeader = getEnvValue('RESEND_FROM_EMAIL') || `${payload.senderName} <${payload.fromEmail}>`;
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
      Authorization: `Bearer ${apiKey}`,
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

async function sendViaSmtpWithFallback(payload: OutgoingEmailPayload): Promise<void> {
  const configuredPort = Number.parseInt(getEnvValue('EMAIL_PORT') || '587', 10) || 587;
  const primaryTransport = createSmtpTransport(configuredPort);
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
    const altPort = configuredPort === 465 ? 587 : 465;
    if (isNetworkTimeout) {
      const altTransport = createSmtpTransport(altPort);
      if (altTransport) {
        try {
          await altTransport.sendMail(mailOptions);
          return;
        } catch {
          throw new Error(
            `${msg} — Outbound SMTP ports 465/587 are blocked on Render Free Web Services. Set EMAIL_WEBHOOK_URL (Google Apps Script) or BREVO_API_KEY in Environment Variables to send via HTTPS (port 443).`,
          );
        }
      }
    }
    throw primaryErr;
  }
}

async function dispatchOutgoingEmail(
  payload: OutgoingEmailPayload,
): Promise<{dispatched: boolean; provider: EmailProviderKind; error?: string}> {
  const cfg = getEmailDeliveryConfig();
  if (!cfg.configured) {
    return {
      dispatched: false,
      provider: 'console',
      error:
        'No email delivery provider is configured (set EMAIL_WEBHOOK_URL, BREVO_API_KEY, RESEND_API_KEY, or EMAIL_HOST_USER/EMAIL_HOST_PASSWORD in your environment variables or .env).',
    };
  }

  try {
    if (cfg.mode === 'https-webhook') {
      await sendViaAppsScriptWebhook(payload);
      return {dispatched: true, provider: 'https-webhook'};
    }
    if (cfg.mode === 'brevo-https') {
      await sendViaBrevoHttps(payload);
      return {dispatched: true, provider: 'brevo-https'};
    }
    if (cfg.mode === 'resend-https') {
      await sendViaResendHttps(payload);
      return {dispatched: true, provider: 'resend-https'};
    }
    await sendViaSmtpWithFallback(payload);
    return {dispatched: true, provider: 'gmail-smtp'};
  } catch (err) {
    return {
      dispatched: false,
      provider: cfg.mode,
      error: err instanceof Error ? err.message : 'Email delivery failed',
    };
  }
}

export async function sendVerificationOtpEmail(
  recipientEmail: string,
  otp: string,
  expiryMinutes = 5,
  isResend = false,
  purpose: 'REGISTRATION' | 'PASSWORD_RESET' = 'REGISTRATION',
): Promise<EmailOtpResult> {
  const fromEmail =
    getEnvValue('DEFAULT_FROM_EMAIL') ||
    getEnvValue('EMAIL_HOST_USER') ||
    'kishore.sathayush@gmail.com';

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

  const result = await dispatchOutgoingEmail({
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
  });

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
  const recipient =
    getEnvValue('DAILY_REPORT_RECIPIENT_EMAIL') ||
    getEnvValue('FIXED_ADMIN_EMAIL') ||
    'kishore.sathayush@gmail.com';
  const fromEmail =
    getEnvValue('DEFAULT_FROM_EMAIL') ||
    getEnvValue('EMAIL_HOST_USER') ||
    'kishore.sathayush@gmail.com';
  const now = new Date();
  const sentAtIso = now.toISOString();
  const sentAtMysql = toMysqlDateTime(now);

  const {buffer, recordCount, filename} = await buildVerifiedUsersWorkbook({status: 'ALL'});

  const result = await dispatchOutgoingEmail({
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
  });

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
