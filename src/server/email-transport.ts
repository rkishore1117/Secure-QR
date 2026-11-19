import dns from 'node:dns';
import nodemailer from 'nodemailer';

// Prefer IPv4 first on cloud runtimes (Render/Cloud Run containers often lack IPv6 egress)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore on older runtimes
}

export type EmailProviderKind =
  | 'https-webhook'
  | 'brevo-https'
  | 'resend-https'
  | 'gmail-smtp'
  | 'console';

export interface OutgoingEmailPayload {
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

export interface EmailTransportContext {
  configured: boolean;
  mode: EmailProviderKind;
  configSource: 'env' | 'database' | 'mixed' | 'none';
  preferredProvider: string;
  smtpConfigured: boolean;
  httpsConfigured: boolean;
  isCloudRuntime: boolean;
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

export interface EmailDispatchOutcome {
  dispatched: boolean;
  provider: EmailProviderKind;
  attemptedProviders: EmailProviderKind[];
  switchedOver: boolean;
  error?: string;
}

export interface EmailProviderHealthResult {
  configured: boolean;
  healthy: boolean;
  provider: EmailProviderKind;
  detail: string;
}

function sanitizeEmailErrorMessage(raw: string, ctx: EmailTransportContext): string {
  let clean = raw;
  const secrets = [ctx.brevoApiKey, ctx.resendApiKey, ctx.webhookSecret, ctx.smtpPassword];
  for (const s of secrets) {
    if (s && s.length >= 4) {
      clean = clean.split(s).join('[REDACTED]');
    }
  }
  return clean.slice(0, 300);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|abort|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|fetch failed/i.test(
    msg,
  );
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs = 12000,
  maxAttempts = 2,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok && isRetryableStatus(res.status) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isRetryableNetworkError(err)) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('HTTPS email request failed');
}

/**
 * Abstraction implemented by every concrete email transport (HTTPS relays & SMTP).
 */
export interface EmailTransport {
  readonly kind: Exclude<EmailProviderKind, 'console'>;
  readonly transportType: 'https' | 'smtp';
  readonly displayName: string;
  isAvailable(ctx: EmailTransportContext): boolean;
  send(payload: OutgoingEmailPayload, ctx: EmailTransportContext): Promise<void>;
  verify?(ctx: EmailTransportContext): Promise<{healthy: boolean; detail: string}>;
}

/**
 * Google Apps Script / Custom HTTPS JSON Relay (Port 443).
 */
export class AppsScriptWebhookTransport implements EmailTransport {
  readonly kind = 'https-webhook' as const;
  readonly transportType = 'https' as const;
  readonly displayName = 'Apps Script HTTPS Relay';

  isAvailable(ctx: EmailTransportContext): boolean {
    return Boolean(ctx.webhookUrl && /^https?:\/\//i.test(ctx.webhookUrl));
  }

  async verify(ctx: EmailTransportContext): Promise<{healthy: boolean; detail: string}> {
    if (!this.isAvailable(ctx)) {
      return {healthy: false, detail: 'EMAIL_WEBHOOK_URL is not configured.'};
    }
    return {healthy: true, detail: 'Apps Script HTTPS webhook endpoint URL configured.'};
  }

  async send(payload: OutgoingEmailPayload, ctx: EmailTransportContext): Promise<void> {
    if (!ctx.webhookUrl) {
      throw new Error('EMAIL_WEBHOOK_URL is not configured.');
    }

    const res = await fetchWithRetry(ctx.webhookUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        secret: ctx.webhookSecret,
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
}

/**
 * Brevo (formerly Sendinblue) Transactional Email API over HTTPS (Port 443).
 * Preferred provider for cloud runtimes (Render Free Tier / Cloud Run) where SMTP ports 465/587 are blocked.
 */
export class BrevoHttpsTransport implements EmailTransport {
  readonly kind = 'brevo-https' as const;
  readonly transportType = 'https' as const;
  readonly displayName = 'Brevo HTTPS API';

  isAvailable(ctx: EmailTransportContext): boolean {
    return Boolean(ctx.brevoApiKey);
  }

  async verify(ctx: EmailTransportContext): Promise<{healthy: boolean; detail: string}> {
    if (!ctx.brevoApiKey) {
      return {healthy: false, detail: 'BREVO_API_KEY is not configured.'};
    }
    try {
      const res = await fetchWithRetry(
        'https://api.brevo.com/v3/account',
        {
          method: 'GET',
          headers: {
            'api-key': ctx.brevoApiKey,
            Accept: 'application/json',
          },
        },
        6000,
        2,
      );
      if (!res.ok) {
        return {healthy: false, detail: `Brevo authentication failed (HTTP ${res.status}).`};
      }
      return {healthy: true, detail: 'Brevo HTTPS API key authenticated and reachable.'};
    } catch (err) {
      return {
        healthy: false,
        detail: sanitizeEmailErrorMessage(
          err instanceof Error ? err.message : 'Brevo API unreachable',
          ctx,
        ),
      };
    }
  }

  async send(payload: OutgoingEmailPayload, ctx: EmailTransportContext): Promise<void> {
    if (!ctx.brevoApiKey) {
      throw new Error('BREVO_API_KEY is not configured.');
    }

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

    const res = await fetchWithRetry('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': ctx.brevoApiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Brevo API ${res.status}: ${errBody.slice(0, 200)}`);
    }
  }
}

/**
 * Resend Transactional Email API over HTTPS (Port 443).
 */
export class ResendHttpsTransport implements EmailTransport {
  readonly kind = 'resend-https' as const;
  readonly transportType = 'https' as const;
  readonly displayName = 'Resend HTTPS API';

  isAvailable(ctx: EmailTransportContext): boolean {
    return Boolean(ctx.resendApiKey);
  }

  async verify(ctx: EmailTransportContext): Promise<{healthy: boolean; detail: string}> {
    if (!ctx.resendApiKey) {
      return {healthy: false, detail: 'RESEND_API_KEY is not configured.'};
    }
    try {
      const res = await fetchWithRetry(
        'https://api.resend.com/domains',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${ctx.resendApiKey}`,
          },
        },
        6000,
        2,
      );
      if (!res.ok) {
        return {healthy: false, detail: `Resend authentication failed (HTTP ${res.status}).`};
      }
      return {healthy: true, detail: 'Resend HTTPS API key authenticated and reachable.'};
    } catch (err) {
      return {
        healthy: false,
        detail: sanitizeEmailErrorMessage(
          err instanceof Error ? err.message : 'Resend API unreachable',
          ctx,
        ),
      };
    }
  }

  async send(payload: OutgoingEmailPayload, ctx: EmailTransportContext): Promise<void> {
    if (!ctx.resendApiKey) {
      throw new Error('RESEND_API_KEY is not configured.');
    }

    const fromHeader = ctx.resendFromEmail || `${payload.senderName} <${payload.fromEmail}>`;
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

    const res = await fetchWithRetry('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Resend API ${res.status}: ${errBody.slice(0, 200)}`);
    }
  }
}

/**
 * Standard SMTP Transport (Nodemailer) with automatic 587/465 STARTTLS/SSL retry.
 */
export class SmtpNodemailerTransport implements EmailTransport {
  readonly kind = 'gmail-smtp' as const;
  readonly transportType = 'smtp' as const;
  readonly displayName = 'SMTP Relay';

  isAvailable(ctx: EmailTransportContext): boolean {
    return Boolean(ctx.smtpUser && ctx.smtpPassword);
  }

  private createTransport(ctx: EmailTransportContext, portOverride?: number) {
    const port = portOverride ?? ctx.smtpPort;
    const host = ctx.smtpHost || 'smtp.gmail.com';
    const pass = host.toLowerCase().includes('gmail.com')
      ? ctx.smtpPassword.replace(/\s+/g, '')
      : ctx.smtpPassword;
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: ctx.smtpUseTls && port !== 465,
      connectionTimeout: 7000,
      greetingTimeout: 7000,
      socketTimeout: 9000,
      auth: {
        user: ctx.smtpUser,
        pass,
      },
    });
  }

  async verify(ctx: EmailTransportContext): Promise<{healthy: boolean; detail: string}> {
    if (!this.isAvailable(ctx)) {
      return {
        healthy: false,
        detail: 'SMTP credentials (EMAIL_HOST_USER / EMAIL_HOST_PASSWORD) are not configured.',
      };
    }
    try {
      await this.createTransport(ctx, ctx.smtpPort).verify();
      return {
        healthy: true,
        detail: `SMTP handshake verified (${ctx.smtpHost}:${ctx.smtpPort}).`,
      };
    } catch (err) {
      return {
        healthy: false,
        detail: sanitizeEmailErrorMessage(
          err instanceof Error ? err.message : 'SMTP verification failed',
          ctx,
        ),
      };
    }
  }

  async send(payload: OutgoingEmailPayload, ctx: EmailTransportContext): Promise<void> {
    if (!this.isAvailable(ctx)) {
      throw new Error('SMTP credentials (EMAIL_HOST_USER / EMAIL_HOST_PASSWORD) are not configured.');
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
      await this.createTransport(ctx, ctx.smtpPort).sendMail(mailOptions);
    } catch (primaryErr) {
      const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const isNetworkTimeout =
        /timeout|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i.test(msg);

      if (isNetworkTimeout) {
        const altPort = ctx.smtpPort === 465 ? 587 : 465;
        try {
          await this.createTransport(ctx, altPort).sendMail(mailOptions);
          return;
        } catch {
          throw new Error(
            `${msg} — Outbound SMTP ports 465/587 are blocked in this cloud runtime. Use an HTTPS relay (Brevo API Key or Google Apps Script Webhook) on port 443.`,
          );
        }
      }
      throw primaryErr;
    }
  }
}

/**
 * Orchestrates registered transports and automatically switches between SMTP and HTTPS relays
 * based on runtime environment, configuration availability, and transport health/failover.
 */
export class EmailDeliveryService {
  private readonly transports: EmailTransport[];

  constructor(transports?: EmailTransport[]) {
    this.transports = transports ?? [
      new BrevoHttpsTransport(),
      new AppsScriptWebhookTransport(),
      new ResendHttpsTransport(),
      new SmtpNodemailerTransport(),
    ];
  }

  /**
   * Orders available transports cleanly:
   * 1. Explicit preferred provider (if available), EXCEPT on cloud runtimes where HTTPS relays
   *    are prioritized when preferred is unset.
   * 2. All HTTPS relays (Brevo, Apps Script, Resend) — guaranteed to work over port 443 on Render Free.
   * 3. SMTP fallback — works locally and on VPS/paid instances with open ports 587/465.
   */
  resolveTransportChain(ctx: EmailTransportContext): EmailTransport[] {
    const available = this.transports.filter((t) => t.isAvailable(ctx));
    if (available.length === 0) return [];

    const ordered: EmailTransport[] = [];
    const pushIfNew = (t: EmailTransport | undefined) => {
      if (t && !ordered.some((existing) => existing.kind === t.kind)) {
        ordered.push(t);
      }
    };

    if (ctx.preferredProvider) {
      const preferred = available.find((t) => t.kind === ctx.preferredProvider);
      if (preferred) {
        pushIfNew(preferred);
      }
    }

    // Add remaining HTTPS transports first (safe across Render/Cloud Run port 443)
    for (const t of available) {
      if (t.transportType === 'https') pushIfNew(t);
    }

    // Add remaining SMTP transports as fallback (or primary locally)
    for (const t of available) {
      if (t.transportType === 'smtp') pushIfNew(t);
    }

    return ordered;
  }

  async verifyPrimaryProvider(ctx: EmailTransportContext): Promise<EmailProviderHealthResult> {
    const chain = this.resolveTransportChain(ctx);
    if (chain.length === 0) {
      return {
        configured: false,
        healthy: false,
        provider: 'console',
        detail:
          'No email delivery provider is configured (set BREVO_API_KEY, EMAIL_WEBHOOK_URL, RESEND_API_KEY, or SMTP credentials).',
      };
    }

    for (const transport of chain) {
      if (!transport.verify) {
        return {
          configured: true,
          healthy: true,
          provider: transport.kind,
          detail: `${transport.displayName} is configured.`,
        };
      }
      const check = await transport.verify(ctx);
      if (check.healthy) {
        return {
          configured: true,
          healthy: true,
          provider: transport.kind,
          detail: check.detail,
        };
      }
      if (transport === chain[chain.length - 1]) {
        return {
          configured: true,
          healthy: false,
          provider: transport.kind,
          detail: check.detail,
        };
      }
    }

    return {
      configured: true,
      healthy: false,
      provider: chain[0]?.kind ?? 'console',
      detail: 'Email provider verification failed.',
    };
  }

  async send(
    payload: OutgoingEmailPayload,
    ctx: EmailTransportContext,
  ): Promise<EmailDispatchOutcome> {
    const chain = this.resolveTransportChain(ctx);
    if (chain.length === 0) {
      console.error('[EMAIL DELIVERY ERROR] No email provider configured.');
      return {
        dispatched: false,
        provider: 'console',
        attemptedProviders: [],
        switchedOver: false,
        error:
          'No email delivery provider is configured. Set BREVO_API_KEY, EMAIL_WEBHOOK_URL, RESEND_API_KEY, or SMTP credentials in Admin Portal → System Settings or Environment Variables.',
      };
    }

    const attempted: EmailProviderKind[] = [];
    const errors: string[] = [];
    const recipientDomain = payload.to.includes('@') ? payload.to.split('@')[1] : 'unknown';

    for (let i = 0; i < chain.length; i++) {
      const transport = chain[i];
      attempted.push(transport.kind);
      try {
        await transport.send(payload, ctx);
        return {
          dispatched: true,
          provider: transport.kind,
          attemptedProviders: attempted,
          switchedOver: i > 0,
        };
      } catch (err) {
        const msg = sanitizeEmailErrorMessage(
          err instanceof Error ? err.message : String(err),
          ctx,
        );
        console.error(
          `[EMAIL DELIVERY FAILURE] provider=${transport.kind} recipientDomain=${recipientDomain} error=${msg}`,
        );
        errors.push(`${transport.displayName}: ${msg}`);
      }
    }

    return {
      dispatched: false,
      provider: attempted[0] ?? 'console',
      attemptedProviders: attempted,
      switchedOver: attempted.length > 1,
      error: errors.join(' | '),
    };
  }
}

export const defaultEmailDeliveryService = new EmailDeliveryService();
