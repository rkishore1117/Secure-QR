import nodemailer from 'nodemailer';
import {executeSql, queryOne, toMysqlDateTime} from './db';
import {buildVerifiedUsersWorkbook} from './excel';

let dailyIntervalHandle: ReturnType<typeof setInterval> | null = null;

export interface EmailReportResult {
  success: boolean;
  recipient: string;
  recordCount: number;
  filename: string;
  sentAt: string;
  error?: string;
}

export interface EmailOtpResult {
  dispatched: boolean;
  provider: 'gmail-smtp' | 'console';
  recipient: string;
  error?: string;
}

function createSmtpTransport() {
  const host = process.env['EMAIL_HOST'] || 'smtp.gmail.com';
  const port = Number.parseInt(process.env['EMAIL_PORT'] || '587', 10) || 587;
  const useTls = (process.env['EMAIL_USE_TLS'] || 'True').toLowerCase() === 'true';
  const user = (process.env['EMAIL_HOST_USER'] || '').trim();
  const pass = process.env['EMAIL_HOST_PASSWORD'] || '';

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

export async function sendVerificationOtpEmail(
  recipientEmail: string,
  otp: string,
  expiryMinutes = 5,
  isResend = false,
): Promise<EmailOtpResult> {
  const fromEmail =
    (process.env['DEFAULT_FROM_EMAIL'] || '').trim() ||
    (process.env['EMAIL_HOST_USER'] || '').trim() ||
    'kishore.sathayush@gmail.com';

  const transport = createSmtpTransport();
  if (!transport) {
    return {
      dispatched: false,
      provider: 'console',
      recipient: recipientEmail,
      error: 'Email SMTP credentials (EMAIL_HOST_USER / EMAIL_HOST_PASSWORD) are not configured.',
    };
  }

  try {
    await transport.sendMail({
      from: `"Secure QR Verification" <${fromEmail}>`,
      to: recipientEmail,
      subject: isResend
        ? `Your Resent Verification Code (${otp}) — Secure QR`
        : `Your Verification Code (${otp}) — Secure QR`,
      text: `Hello,\n\nYour one-time verification code to verify your Secure QR account email is: ${otp}\n\nThis code is valid for ${expiryMinutes} minutes. Please do not share it with anyone.\n\nIf you did not request this code, you can safely ignore this email.\n\nThank you,\nTeam Sathayush`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #0F172A; line-height: 1.6; max-width: 520px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 12px; padding: 28px; background: #FFFFFF;">
          <h2 style="margin: 0 0 10px 0; color: #0F172A; font-size: 20px;">Verify Your Email Address</h2>
          <p style="margin: 0 0 18px 0; color: #475569; font-size: 14px;">
            Use the 6-digit verification code below to finish setting up your Secure QR registration.
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
      dispatched: true,
      provider: 'gmail-smtp',
      recipient: recipientEmail,
    };
  } catch (err) {
    return {
      dispatched: false,
      provider: 'gmail-smtp',
      recipient: recipientEmail,
      error: err instanceof Error ? err.message : 'SMTP email delivery failed',
    };
  }
}

export async function sendDailyVerificationExcelReport(
  triggerType: 'SCHEDULED_24H' | 'MANUAL' = 'SCHEDULED_24H',
): Promise<EmailReportResult> {
  const recipient =
    process.env['DAILY_REPORT_RECIPIENT_EMAIL'] ||
    process.env['FIXED_ADMIN_EMAIL'] ||
    'kishore.sathayush@gmail.com';
  const fromEmail =
    process.env['DEFAULT_FROM_EMAIL'] ||
    process.env['EMAIL_HOST_USER'] ||
    'kishore.sathayush@gmail.com';
  const now = new Date();
  const sentAtIso = now.toISOString();
  const sentAtMysql = toMysqlDateTime(now);

  const {buffer, recordCount, filename} = await buildVerifiedUsersWorkbook({status: 'ALL'});

  const transport = createSmtpTransport();
  if (!transport) {
    const errMsg = 'SMTP credentials (EMAIL_HOST_USER / EMAIL_HOST_PASSWORD) are not configured.';
    await executeSql(
      `INSERT INTO scheduled_report_logs
        (recipient_email, record_count, filename, status, error_message, trigger_type, sent_at)
       VALUES (?, ?, ?, 'FAILED', ?, ?, ?)`,
      [recipient, recordCount, filename, errMsg, triggerType, sentAtMysql],
    );
    return {success: false, recipient, recordCount, filename, sentAt: sentAtIso, error: errMsg};
  }

  try {
    await transport.sendMail({
      from: `"Secure QR Team" <${fromEmail}>`,
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
      [filename, JSON.stringify({recipient, recordCount, triggerType}), sentAtMysql],
    );

    return {success: true, recipient, recordCount, filename, sentAt: sentAtIso};
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'SMTP delivery failed';
    await executeSql(
      `INSERT INTO scheduled_report_logs
        (recipient_email, record_count, filename, status, error_message, trigger_type, sent_at)
       VALUES (?, ?, ?, 'FAILED', ?, ?, ?)`,
      [recipient, recordCount, filename, errMsg, triggerType, sentAtMysql],
    );
    return {success: false, recipient, recordCount, filename, sentAt: sentAtIso, error: errMsg};
  }
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
