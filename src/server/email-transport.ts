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

/**
 * Abstraction implemented by every concrete email transport (HTTPS relays & SMTP).
 */
export interface EmailTransport {
  readonly kind: Exclude<EmailProviderKind, 'console'>;
  readonly transportType: 'https' | 'smtp';
  readonly displayName: string;
  isAvailable(ctx: EmailTransportContext): boolean;
  send(payload: OutgoingEmailPayload, ctx: EmailTransportContext): Promise<void>;
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

  async send(payload: OutgoingEmailPayload, ctx: EmailTransportContext): Promise<void> {
    if (!ctx.webhookUrl) {
      throw new Error('EMAIL_WEBHOOK_URL is not configured.');
    }

    const res = await fetch(ctx.webhookUrl, {
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
}

/**
 * Brevo (formerly Sendinblue) Transactional Email API over HTTPS (Port 443).
 * Ideal for Render Free Tier where outbound SMTP ports 465/587 are blocked.
 */
export class BrevoHttpsTransport implements EmailTransport {
  readonly kind = 'brevo-https' as const;
  readonly transportType = 'https' as const;
  readonly displayName = 'Brevo HTTPS API';

  isAvailable(ctx: EmailTransportContext): boolean {
    return Boolean(ctx.brevoApiKey);
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

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': ctx.brevoApiKey,
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

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.resendApiKey}`,
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
    return nodemailer.createTransport({
      host: ctx.smtpHost || 'smtp.gmail.com',
      port,
      secure: port === 465,
      requireTLS: ctx.smtpUseTls && port !== 465,
      connectionTimeout: 7000,
      greetingTimeout: 7000,
      socketTimeout: 9000,
      auth: {
        user: ctx.smtpUser,
        pass: ctx.smtpPassword,
      },
    });
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
   *    are prioritized if preferred isn't explicitly forcing SMTP over an available HTTPS relay.
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
        // On cloud free runtimes (Render/Cloud Run), prefer HTTPS if both HTTPS & SMTP exist unless user explicitly saved gmail-smtp
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

  async send(
    payload: OutgoingEmailPayload,
    ctx: EmailTransportContext,
  ): Promise<EmailDispatchOutcome> {
    const chain = this.resolveTransportChain(ctx);
    if (chain.length === 0) {
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
        const msg = err instanceof Error ? err.message : String(err);
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
