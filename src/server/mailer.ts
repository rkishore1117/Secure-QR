import nodemailer from 'nodemailer';
import {getDb} from './db';
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

function createSmtpTransport() {
  const host = process.env['EMAIL_HOST'] || 'smtp.gmail.com';
  const port = Number.parseInt(process.env['EMAIL_PORT'] || '587', 10) || 587;
  const useTls = (process.env['EMAIL_USE_TLS'] || 'True').toLowerCase() === 'true';
  const user = process.env['EMAIL_HOST_USER'] || '';
  const pass = process.env['EMAIL_HOST_PASSWORD'] || '';

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: useTls && port !== 465,
    connectionTimeout: 4000,
    greetingTimeout: 4000,
    socketTimeout: 6000,
    auth: {
      user,
      pass,
    },
  });
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
    'sathayushtechsolutions@gmail.com';
  const sentAt = new Date().toISOString();

  const {buffer, recordCount, filename} = await buildVerifiedUsersWorkbook({status: 'ALL'});
  const db = getDb();

  const transport = createSmtpTransport();
  if (!transport) {
    const errMsg = 'SMTP credentials (EMAIL_HOST_USER / EMAIL_HOST_PASSWORD) are not configured.';
    db.prepare(
      `INSERT INTO scheduled_report_logs
        (recipient_email, record_count, filename, status, error_message, trigger_type, sent_at)
       VALUES (?, ?, ?, 'FAILED', ?, ?, ?)`,
    ).run(recipient, recordCount, filename, errMsg, triggerType, sentAt);
    return {success: false, recipient, recordCount, filename, sentAt, error: errMsg};
  }

  try {
    await transport.sendMail({
      from: `"Secure QR Team" <${fromEmail}>`,
      to: recipient,
      subject: `Daily Member Verification Report — ${sentAt.slice(0, 10)}`,
      text: `Hello Kishore,\n\nAttached is today's verified member Excel report (${filename}) with ${recordCount} member record(s), covering registration details, approval status, and QR pass validity.\n\nGenerated at (UTC): ${sentAt}\nSent via: ${triggerType === 'MANUAL' ? 'Manual Admin Request' : 'Automated 24-Hour Schedule'}\n\nWarm regards,\nSecure QR Verification Team`,
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
              <td style="padding: 6px 0;">${sentAt}</td>
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

    db.prepare(
      `INSERT INTO scheduled_report_logs
        (recipient_email, record_count, filename, status, error_message, trigger_type, sent_at)
       VALUES (?, ?, ?, 'SENT', NULL, ?, ?)`,
    ).run(recipient, recordCount, filename, triggerType, sentAt);

    db.prepare(
      `INSERT INTO admin_activity_logs
        (actor_user_id, actor_email, actor_role, action, target_type, target_id, details_json, created_at)
       VALUES (NULL, 'system-scheduler', 'SUPER_ADMIN', 'DAILY_EXCEL_EMAIL_SENT', 'REPORT', ?, ?, ?)`,
    ).run(
      filename,
      JSON.stringify({recipient, recordCount, triggerType}),
      sentAt,
    );

    return {success: true, recipient, recordCount, filename, sentAt};
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'SMTP delivery failed';
    db.prepare(
      `INSERT INTO scheduled_report_logs
        (recipient_email, record_count, filename, status, error_message, trigger_type, sent_at)
       VALUES (?, ?, ?, 'FAILED', ?, ?, ?)`,
    ).run(recipient, recordCount, filename, errMsg, triggerType, sentAt);
    return {success: false, recipient, recordCount, filename, sentAt, error: errMsg};
  }
}

export function startDailyReportScheduler(): void {
  if (dailyIntervalHandle) return;
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  // Check if >24h elapsed since last successful report on startup
  try {
    const last = getDb()
      .prepare("SELECT sent_at FROM scheduled_report_logs WHERE status = 'SENT' ORDER BY id DESC LIMIT 1")
      .get() as {sent_at: string} | undefined;
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
