/**
 * Google Apps Script Web App Relay for Secure QR Verification System
 * -------------------------------------------------------------------
 * Why: Render Free Web Services block outbound SMTP ports (25, 465, 587),
 * causing "Connection timeout" on smtp.gmail.com.
 *
 * This script runs inside your Gmail account (kishore.sathayush@gmail.com)
 * and accepts HTTPS POST requests on port 443 (never blocked by Render).
 *
 * Setup (2 minutes, 100% Free):
 * 1. Sign into https://script.google.com with kishore.sathayush@gmail.com
 * 2. Click "New project", paste this entire file, and save.
 * 3. Replace RELAY_SECRET below with a strong random string (and set the
 *    exact same value as EMAIL_WEBHOOK_SECRET in Render Environment Variables).
 * 4. Click Deploy -> New deployment -> Select type: "Web app"
 *    - Execute as: "Me (kishore.sathayush@gmail.com)"
 *    - Who has access: "Anyone"
 * 5. Authorize Gmail permissions and copy the Web App URL (ends with /exec).
 * 6. Paste that URL into Render as EMAIL_WEBHOOK_URL.
 */

var RELAY_SECRET = 'change-this-to-your-random-secret';

function doPost(e) {
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (RELAY_SECRET && RELAY_SECRET !== 'change-this-to-your-random-secret') {
      if (payload.secret !== RELAY_SECRET) {
        return jsonResponse({ ok: false, error: 'Unauthorized relay secret.' });
      }
    }

    var to = String(payload.to || '').trim();
    var subject = String(payload.subject || 'Secure QR Notification');
    var textBody = String(payload.text || '');
    var htmlBody = String(payload.html || '');
    var senderName = String(payload.senderName || 'Secure QR Verification');

    if (!to) {
      return jsonResponse({ ok: false, error: 'Missing recipient email.' });
    }

    var options = {
      name: senderName,
      htmlBody: htmlBody || undefined,
    };

    if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
      options.attachments = payload.attachments.map(function (att) {
        var bytes = Utilities.base64Decode(String(att.base64 || ''));
        return Utilities.newBlob(
          bytes,
          att.contentType || 'application/octet-stream',
          att.filename || 'attachment.xlsx'
        );
      });
    }

    GmailApp.sendEmail(to, subject, textBody, options);
    return jsonResponse({ ok: true, to: to });
  } catch (err) {
    return jsonResponse({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

function doGet() {
  return jsonResponse({ ok: true, service: 'Secure QR Gmail HTTPS Relay' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
