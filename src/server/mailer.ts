import {executeSql, getEnvValue, queryOne, queryRows, toMysqlDateTime} from './db';
import {
  defaultEmailDeliveryService,
  type EmailProviderKind,
  type EmailTransportContext,
  type OutgoingEmailPayload,
} from './email-transport';
import {buildVerifiedUsersWorkbook} from './excel';

export type {EmailProviderKind};

let dailyIntervalHandle: ReturnType<typeof setInterval> | null = null;

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

export type EffectiveEmailRuntimeConfig = EmailTransportContext;

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
  configured: boolean;
  provider: EmailProviderKind;
  attemptedProviders?: EmailProviderKind[];
  switchedOver?: boolean;
  recipient: string;
  error?: string;
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

  const isCloudRuntime = Boolean(
    process.env['RENDER'] ||
      process.env['RENDER_SERVICE_ID'] ||
      process.env['K_SERVICE'] ||
      process.env['CLOUD_RUN_JOB'],
  );

  const hasWebhook = Boolean(webhookUrlPick.val);
  const hasBrevo = Boolean(brevoPick.val);
  const hasResend = Boolean(resendPick.val);
  const hasSmtp = Boolean(smtpUserPick.val && smtpPassPick.val);

  const preferred = db['email_preferred_provider'] || '';

  const draftCtx: EmailTransportContext = {
    configured: hasWebhook || hasBrevo || hasResend || hasSmtp,
    mode: 'console',
    configSource: 'none',
    preferredProvider: preferred,
    smtpConfigured: hasSmtp,
    httpsConfigured: hasWebhook || hasBrevo || hasResend,
    isCloudRuntime,
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

  const chain = defaultEmailDeliveryService.resolveTransportChain(draftCtx);
  const primaryMode: EmailProviderKind = chain[0]?.kind ?? 'console';

  const activeSources = new Set<'env' | 'database'>();
  if (primaryMode === 'https-webhook') {
    activeSources.add(webhookUrlPick.from === 'env' ? 'env' : 'database');
  } else if (primaryMode === 'brevo-https') {
    activeSources.add(brevoPick.from === 'env' ? 'env' : 'database');
  } else if (primaryMode === 'resend-https') {
    activeSources.add(resendPick.from === 'env' ? 'env' : 'database');
  } else if (primaryMode === 'gmail-smtp') {
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
    ...draftCtx,
    mode: primaryMode,
    configSource,
  };
}

export async function getEmailSettingsMaskedSummary(): Promise<EmailSettingsMaskedSummary> {
  const cfg = await getEffectiveEmailDeliveryConfig();
  return {
    activeProvider: cfg.mode,
    configured: cfg.configured,
    configSource: cfg.configSource,
    preferredProvider: cfg.preferredProvider || cfg.mode,
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

async function dispatchOutgoingEmail(
  payload: OutgoingEmailPayload,
  cfgOverride?: EffectiveEmailRuntimeConfig,
) {
  const cfg = cfgOverride ?? (await getEffectiveEmailDeliveryConfig());
  return defaultEmailDeliveryService.send(payload, cfg);
}

export async function sendTestEmail(
  recipientEmail: string,
): Promise<{
  success: boolean;
  provider: EmailProviderKind;
  attemptedProviders?: EmailProviderKind[];
  switchedOver?: boolean;
  recipient: string;
  error?: string;
}> {
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
    attemptedProviders: result.attemptedProviders,
    switchedOver: result.switchedOver,
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
    configured: cfg.configured,
    provider: result.provider,
    attemptedProviders: result.attemptedProviders,
    switchedOver: result.switchedOver,
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
