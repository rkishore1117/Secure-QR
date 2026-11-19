import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {FormBuilder, ReactiveFormsModule, Validators} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {ToastService} from '../../core/services/toast.service';

@Component({
  selector: 'app-admin-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="space-y-6">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">System Settings &amp; Dynamic Fields</h1>
        <p class="mt-1 text-sm text-slate-600">
          Configure QR credential validity, OTP expiration, organization identity, email delivery gateways, and dynamic registration form fields.
        </p>
      </div>

      <!-- Global System Settings -->
      <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <h2 class="text-sm font-bold text-[#0F172A] font-display">Security &amp; Credential Parameters</h2>
        <form [formGroup]="settingsForm" (ngSubmit)="saveSettings()" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label for="s-org" class="block text-xs font-semibold text-slate-700 mb-1">Organization Name</label>
            <input id="s-org" type="text" formControlName="organization_name" class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>
          <div>
            <label for="s-qrdays" class="block text-xs font-semibold text-slate-700 mb-1">QR Validity (Days)</label>
            <input id="s-qrdays" type="number" formControlName="qr_validity_days" class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs" />
          </div>
          <div>
            <label for="s-otpmin" class="block text-xs font-semibold text-slate-700 mb-1">OTP Expiry (Minutes)</label>
            <input id="s-otpmin" type="number" formControlName="otp_expiry_minutes" class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs" />
          </div>
          <div>
            <label for="s-otpatt" class="block text-xs font-semibold text-slate-700 mb-1">Max OTP Attempts</label>
            <input id="s-otpatt" type="number" formControlName="max_otp_attempts" class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs" />
          </div>
          <div>
            <label for="s-idreq" class="block text-xs font-semibold text-slate-700 mb-1">ID Proof Required</label>
            <select id="s-idreq" formControlName="id_proof_required" class="w-full h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs">
              <option value="true">Required</option>
              <option value="false">Optional</option>
            </select>
          </div>
          <div>
            <label for="s-multiqr" class="block text-xs font-semibold text-slate-700 mb-1">Allow Multiple Active QRs</label>
            <select id="s-multiqr" formControlName="allow_multiple_active_qr" class="w-full h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs">
              <option value="false">Single Active QR per User</option>
              <option value="true">Multiple Active QRs Allowed</option>
            </select>
          </div>
          <div class="sm:col-span-2 lg:col-span-3 flex justify-end">
            <button
              type="submit"
              class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
            >
              <mat-icon class="text-[18px]!">save</mat-icon>
              <span>Save Settings</span>
            </button>
          </div>
        </form>
      </section>

      <!-- Runtime Email Delivery Configuration (Before & After Publish) -->
      <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-sm font-bold text-[#0F172A] font-display">Email Delivery Gateway (OTP &amp; 24h Excel Reports)</h2>
            <p class="mt-0.5 text-xs text-slate-600">
              Configure email delivery here so published environments work even when <code class="font-mono text-[11px]">.env</code> is not present. Use an HTTPS gateway on Render Free or Cloud Run.
            </p>
          </div>
          @if (integrationStatus(); as st) {
            <span
              class="rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold"
              [class.bg-emerald-50]="st.integrations.emailOtpConfigured"
              [class.text-emerald-800]="st.integrations.emailOtpConfigured"
              [class.bg-amber-50]="!st.integrations.emailOtpConfigured"
              [class.text-amber-800]="!st.integrations.emailOtpConfigured"
            >
              {{
                st.integrations.emailOtpConfigured
                  ? 'Active: ' + (st.integrations.emailDeliveryMode || 'configured') + ' (' + (st.integrations.emailConfigSource || 'env') + ')'
                  : 'Not Configured'
              }}
            </span>
          }
        </div>

        <form [formGroup]="emailForm" (ngSubmit)="saveEmailConfig()" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label for="em-provider" class="block text-xs font-semibold text-slate-700 mb-1">Delivery Provider</label>
            <select id="em-provider" formControlName="provider" class="w-full h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs">
              <option value="https-webhook">Google Apps Script HTTPS Webhook (Recommended for Render/Cloud)</option>
              <option value="brevo-https">Brevo HTTPS API (Port 443)</option>
              <option value="resend-https">Resend HTTPS API (Port 443)</option>
              <option value="gmail-smtp">Gmail / Custom SMTP (Ports 587 / 465)</option>
            </select>
          </div>

          <div>
            <label for="em-from" class="block text-xs font-semibold text-slate-700 mb-1">Default From Email</label>
            <input
              id="em-from"
              type="email"
              formControlName="defaultFromEmail"
              placeholder="kishore.sathayush@gmail.com"
              class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs"
            />
          </div>

          @if (emailForm.value.provider === 'https-webhook') {
            <div class="sm:col-span-2">
              <label for="em-webhook-url" class="block text-xs font-semibold text-slate-700 mb-1">
                Apps Script / Relay Webhook URL (https://...)
              </label>
              <input
                id="em-webhook-url"
                type="url"
                formControlName="webhookUrl"
                placeholder="https://script.google.com/macros/s/.../exec"
                class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs"
              />
            </div>
            <div class="sm:col-span-2">
              <label for="em-webhook-sec" class="block text-xs font-semibold text-slate-700 mb-1">
                Webhook Secret {{ integrationStatus()?.emailSettings?.hasWebhookSecret ? '(Saved — leave blank to keep existing)' : '(Optional)' }}
              </label>
              <input
                id="em-webhook-sec"
                type="password"
                formControlName="webhookSecret"
                autocomplete="new-password"
                placeholder="Shared secret token checked by Apps Script"
                class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs"
              />
            </div>
          }

          @if (emailForm.value.provider === 'brevo-https') {
            <div class="sm:col-span-2">
              <label for="em-brevo-key" class="block text-xs font-semibold text-slate-700 mb-1">
                Brevo API Key {{ integrationStatus()?.emailSettings?.hasBrevoKey ? '(Saved — leave blank to keep existing)' : '' }}
              </label>
              <input
                id="em-brevo-key"
                type="password"
                formControlName="brevoApiKey"
                autocomplete="new-password"
                placeholder="xkeysib-..."
                class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs"
              />
            </div>
          }

          @if (emailForm.value.provider === 'resend-https') {
            <div>
              <label for="em-resend-key" class="block text-xs font-semibold text-slate-700 mb-1">
                Resend API Key {{ integrationStatus()?.emailSettings?.hasResendKey ? '(Saved — leave blank to keep existing)' : '' }}
              </label>
              <input
                id="em-resend-key"
                type="password"
                formControlName="resendApiKey"
                autocomplete="new-password"
                placeholder="re_..."
                class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs"
              />
            </div>
            <div>
              <label for="em-resend-from" class="block text-xs font-semibold text-slate-700 mb-1">
                Verified Sender Header (Optional)
              </label>
              <input
                id="em-resend-from"
                type="text"
                formControlName="resendFromEmail"
                placeholder="Secure QR <noreply@yourdomain.com>"
                class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs"
              />
            </div>
          }

          @if (emailForm.value.provider === 'gmail-smtp') {
            <div>
              <label for="em-smtp-host" class="block text-xs font-semibold text-slate-700 mb-1">SMTP Host</label>
              <input id="em-smtp-host" type="text" formControlName="smtpHost" class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs" />
            </div>
            <div>
              <label for="em-smtp-port" class="block text-xs font-semibold text-slate-700 mb-1">SMTP Port</label>
              <input id="em-smtp-port" type="number" formControlName="smtpPort" class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs" />
            </div>
            <div>
              <label for="em-smtp-user" class="block text-xs font-semibold text-slate-700 mb-1">SMTP Username / Gmail Address</label>
              <input id="em-smtp-user" type="email" formControlName="smtpUser" placeholder="kishore.sathayush@gmail.com" class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs" />
            </div>
            <div>
              <label for="em-smtp-pass" class="block text-xs font-semibold text-slate-700 mb-1">
                Gmail App Password {{ integrationStatus()?.emailSettings?.hasSmtpPassword ? '(Saved — leave blank to keep existing)' : '' }}
              </label>
              <input
                id="em-smtp-pass"
                type="password"
                formControlName="smtpPassword"
                autocomplete="new-password"
                placeholder="16-character Google App Password"
                class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs"
              />
            </div>
          }

          <div class="sm:col-span-2 flex flex-col gap-3 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="email"
                formControlName="testRecipient"
                placeholder="Test recipient email (optional)"
                aria-label="Test email recipient"
                class="h-10 w-full sm:max-w-xs rounded-lg border border-slate-300 px-3 text-xs"
              />
              <button
                type="button"
                (click)="sendTestEmail()"
                [disabled]="testingEmail()"
                class="touch-target inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-4 py-2 text-xs font-semibold text-[#0F172A] hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap"
              >
                <mat-icon class="text-[18px]!">send</mat-icon>
                <span>{{ testingEmail() ? 'Sending Test...' : 'Send Test Email' }}</span>
              </button>
            </div>

            <button
              type="submit"
              [disabled]="savingEmail()"
              class="touch-target inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50 whitespace-nowrap"
            >
              <mat-icon class="text-[18px]!">save</mat-icon>
              <span>{{ savingEmail() ? 'Saving...' : 'Save Email Gateway' }}</span>
            </button>
          </div>
        </form>
      </section>

      <!-- Dynamic Registration Fields Config -->
      <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
        <h2 class="text-sm font-bold text-[#0F172A] font-display">Dynamic User Registration Fields</h2>

        <form [formGroup]="fieldForm" (ngSubmit)="addField()" class="grid grid-cols-1 gap-3 sm:grid-cols-4 items-end">
          <div>
            <label for="df-key" class="block text-xs font-semibold text-slate-700 mb-1">Field Key</label>
            <input id="df-key" type="text" formControlName="fieldKey" placeholder="e.g., badge_zone" class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs" />
          </div>
          <div>
            <label for="df-label" class="block text-xs font-semibold text-slate-700 mb-1">Display Label</label>
            <input id="df-label" type="text" formControlName="label" placeholder="e.g., Facility Zone" class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>
          <div>
            <label for="df-type" class="block text-xs font-semibold text-slate-700 mb-1">Field Type</label>
            <select id="df-type" formControlName="fieldType" class="w-full h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs">
              <option value="text">Text</option>
              <option value="date">Date</option>
              <option value="select">Select Dropdown</option>
            </select>
          </div>
          <div class="flex items-center justify-between gap-3">
            <label class="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input type="checkbox" formControlName="isRequired" class="h-4 w-4 rounded border-slate-300" />
              <span>Required</span>
            </label>
            <button
              type="submit"
              class="touch-target inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#1E3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0F172A] whitespace-nowrap"
            >
              <mat-icon class="text-[18px]!">add</mat-icon>
              <span>Add Field</span>
            </button>
          </div>
          @if (fieldForm.value.fieldType === 'select') {
            <div class="sm:col-span-4">
              <label for="df-options" class="block text-xs font-semibold text-slate-700 mb-1">
                Dropdown Options (comma-separated)
              </label>
              <input
                id="df-options"
                type="text"
                formControlName="optionsText"
                placeholder="e.g., Zone A, Zone B, All Access"
                class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs"
              />
            </div>
          }
        </form>

        <div class="divide-y divide-slate-100 border-t border-slate-200 pt-2">
          @for (f of fieldConfigs(); track f['id']) {
            <div class="flex flex-wrap items-center justify-between gap-3 py-3 text-xs">
              <div>
                <p class="font-semibold text-slate-900">{{ f['label'] }}</p>
                <p class="font-mono text-[11px] text-slate-500">
                  {{ f['field_key'] }} · {{ f['field_type'] }} · {{ f['is_required'] ? 'Required' : 'Optional' }}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  (click)="toggleFieldEnabled(f)"
                  class="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold hover:bg-slate-50"
                >
                  {{ f['is_enabled'] ? 'Enabled' : 'Disabled' }}
                </button>
                <button
                  type="button"
                  (click)="deleteField(Number(f['id']))"
                  class="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 font-semibold text-red-700 hover:bg-red-100"
                >
                  Remove
                </button>
              </div>
            </div>
          }
        </div>
      </section>

      <!-- Configured Infrastructure & Gateways (Read-Only) -->
      @if (integrationStatus()) {
        @let status = integrationStatus()!;
        <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 class="text-sm font-bold text-[#0F172A] font-display">Connected Services &amp; Cloud Storage</h2>
              <p class="mt-0.5 text-xs text-slate-600">Live overview of your separate MySQL database, email OTP verification, S3 media path, and automated mailer.</p>
            </div>
            <span class="font-mono text-[11px] font-semibold text-slate-500">
              Primary Admin: {{ status.integrations.fixedAdminEmail }}
            </span>
          </div>

          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-2">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <p class="font-semibold text-[#0F172A]">Separate Secure QR Database (MySQL RDS)</p>
                  <p class="mt-0.5 font-mono text-slate-600 break-all">{{ status.database.host || 'Not Set (Mock Fallback)' }} / {{ status.database.database }}</p>
                </div>
                <button
                  type="button"
                  (click)="initMysqlDb()"
                  [disabled]="initializingDb()"
                  class="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#0F172A] hover:bg-slate-100 disabled:opacity-50"
                >
                  {{ initializingDb() ? 'Initializing...' : 'Create / Verify DB' }}
                </button>
              </div>
              <p [class.text-emerald-700]="status.database.connected" [class.text-amber-700]="!status.database.connected" class="font-semibold">
                {{ status.database.connected ? 'Connected to ' + status.database.database + ' (' + status.database.activeEngine + ')' : 'MySQL RDS unavailable — ' + (status.database.error || 'set DB_HOST/DB_USER/DB_PASSWORD in environment') }}
              </p>
            </div>

            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-1">
              <p class="font-semibold text-[#0F172A]">24-Hour Automated Excel Email</p>
              <p class="font-mono text-slate-600 break-all">{{ status.integrations.emailDeliveryMode || status.integrations.smtpHost }} ({{ status.integrations.smtpUser || 'Unset' }})</p>
              <p class="text-slate-700">Daily summary sent to: <span class="font-mono font-semibold">{{ status.integrations.dailyReportRecipient }}</span></p>
            </div>

            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-1">
              <p class="font-semibold text-[#0F172A]">Email OTP Verification</p>
              <p class="font-mono text-slate-600 break-all">
                Sender: {{ status.integrations.smtpUser || 'Not Set' }} · Mode: {{ status.integrations.emailDeliveryMode || 'console' }}
              </p>
              <p
                [class.text-emerald-700]="status.emailHealth ? status.emailHealth.healthy : status.integrations.emailOtpConfigured"
                [class.text-amber-700]="status.emailHealth ? !status.emailHealth.healthy : !status.integrations.emailOtpConfigured"
                class="font-semibold"
              >
                {{
                  status.emailHealth
                    ? status.emailHealth.detail
                    : status.integrations.emailOtpConfigured
                      ? 'Active (Registration & Reset OTP Emails Enabled)'
                      : 'Email Provider Not Configured — Set Gateway Above'
                }}
              </p>
            </div>

            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-1">
              <p class="font-semibold text-[#0F172A]">AWS S3 Image &amp; Document Storage</p>
              <p class="font-mono text-slate-600 break-all">{{ status.integrations.s3Bucket || 'Local' }} ({{ status.integrations.s3Region || 'local' }})</p>
              <p class="font-mono text-[11px] text-slate-500 break-all">{{ status.integrations.filePath || 'Local /api/v1/uploads/' }}</p>
            </div>
          </div>
        </section>
      }
    </div>
  `,
})
export class AdminSettings implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  protected readonly Number = Number;
  protected readonly fieldConfigs = signal<Record<string, unknown>[]>([]);
  protected readonly initializingDb = signal(false);
  protected readonly savingEmail = signal(false);
  protected readonly testingEmail = signal(false);
  protected readonly integrationStatus = signal<{
    database: {configured: boolean; connected: boolean; host: string; database: string; activeEngine: string; error?: string};
    integrations: {
      smtpConfigured: boolean;
      emailOtpConfigured: boolean;
      emailDeliveryMode?: string;
      emailConfigSource?: string;
      smtpHost: string;
      smtpUser: string;
      dailyReportRecipient: string;
      s3Configured: boolean;
      s3Bucket: string;
      s3Region: string;
      filePath: string;
      fixedAdminEmail: string;
    };
    emailSettings?: {
      activeProvider: string;
      configured: boolean;
      configSource: string;
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
    };
    emailHealth?: {
      configured: boolean;
      healthy: boolean;
      provider: string;
      configSource: string;
      detail: string;
      checkedAt: string;
    };
  } | null>(null);

  protected readonly settingsForm = this.fb.group({
    organization_name: [''],
    qr_validity_days: ['365'],
    otp_expiry_minutes: ['5'],
    max_otp_attempts: ['5'],
    id_proof_required: ['true'],
    allow_multiple_active_qr: ['false'],
  });

  protected readonly emailForm = this.fb.group({
    provider: ['https-webhook'],
    defaultFromEmail: ['kishore.sathayush@gmail.com'],
    webhookUrl: [''],
    webhookSecret: [''],
    brevoApiKey: [''],
    resendApiKey: [''],
    resendFromEmail: [''],
    smtpHost: ['smtp.gmail.com'],
    smtpPort: [587],
    smtpUser: [''],
    smtpPassword: [''],
    testRecipient: [''],
  });

  protected readonly fieldForm = this.fb.group({
    fieldKey: ['', Validators.required],
    label: ['', Validators.required],
    fieldType: ['text'],
    isRequired: [false],
    optionsText: [''],
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getSystemSettings());
      this.settingsForm.patchValue(res.settings);
      this.fieldConfigs.set(res.fieldConfigs);
      try {
        const status = await firstValueFrom(this.api.getIntegrationStatus());
        this.integrationStatus.set(status);
        if (status.emailSettings) {
          const es = status.emailSettings;
          const selectedProvider =
            es.preferredProvider && es.preferredProvider !== 'console'
              ? es.preferredProvider
              : es.activeProvider !== 'console'
                ? es.activeProvider
                : 'https-webhook';
          this.emailForm.patchValue({
            provider: selectedProvider,
            defaultFromEmail: es.defaultFromEmail || 'kishore.sathayush@gmail.com',
            webhookUrl: es.webhookUrl || '',
            resendFromEmail: es.resendFromEmail || '',
            smtpHost: es.smtpHost || 'smtp.gmail.com',
            smtpPort: es.smtpPort || 587,
            smtpUser: es.smtpUser || '',
            testRecipient: this.emailForm.value.testRecipient || status.integrations.fixedAdminEmail,
          });
        }
      } catch {
        // optional integration status check
      }
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not load system settings.';
      this.toast.error('Load Failed', msg);
    }
  }

  async saveEmailConfig(): Promise<void> {
    this.savingEmail.set(true);
    try {
      const v = this.emailForm.value;
      await firstValueFrom(
        this.api.saveEmailConfig({
          provider: v.provider,
          defaultFromEmail: v.defaultFromEmail,
          webhookUrl: v.webhookUrl,
          webhookSecret: v.webhookSecret,
          brevoApiKey: v.brevoApiKey,
          resendApiKey: v.resendApiKey,
          resendFromEmail: v.resendFromEmail,
          smtpHost: v.smtpHost,
          smtpPort: v.smtpPort,
          smtpUseTls: true,
          smtpUser: v.smtpUser,
          smtpPassword: v.smtpPassword,
        }),
      );
      this.emailForm.patchValue({
        webhookSecret: '',
        brevoApiKey: '',
        resendApiKey: '',
        smtpPassword: '',
      });
      this.toast.success('Email Gateway Saved', 'Email delivery configuration updated.');
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not save email gateway.';
      this.toast.error('Save Failed', msg);
    } finally {
      this.savingEmail.set(false);
    }
  }

  async sendTestEmail(): Promise<void> {
    this.testingEmail.set(true);
    try {
      const target = String(this.emailForm.value.testRecipient || '').trim();
      const res = await firstValueFrom(this.api.sendTestEmail(target || undefined));
      if (res.success) {
        this.toast.success('Test Email Sent', `Delivered to ${res.recipient} via ${res.provider}.`);
      } else {
        this.toast.error('Test Email Failed', res.error || 'Email delivery failed.');
      }
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Unable to dispatch test email.';
      this.toast.error('Test Error', msg);
    } finally {
      this.testingEmail.set(false);
    }
  }

  async initMysqlDb(): Promise<void> {
    this.initializingDb.set(true);
    try {
      const res = await firstValueFrom(this.api.initMysqlDatabase());
      if (res.success) {
        this.toast.success('Database Ready', res.message);
      } else {
        this.toast.error('RDS Unreachable', res.error || res.message);
      }
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Database check failed.';
      this.toast.error('Error', msg);
    } finally {
      this.initializingDb.set(false);
    }
  }

  async saveSettings(): Promise<void> {
    try {
      const raw = this.settingsForm.value as Record<string, string>;
      await firstValueFrom(this.api.updateSystemSettings(raw));
      this.toast.success('Settings Saved', 'System configuration updated.');
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not save settings.';
      this.toast.error('Error', msg);
    }
  }

  async addField(): Promise<void> {
    if (this.fieldForm.invalid) return;
    const raw = this.fieldForm.value;
    const options =
      raw.fieldType === 'select'
        ? String(raw.optionsText || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    if (raw.fieldType === 'select' && options.length === 0) {
      this.toast.warning('Options Required', 'Enter comma-separated options for a Select Dropdown field.');
      return;
    }
    try {
      await firstValueFrom(
        this.api.addFieldConfig({
          fieldKey: raw.fieldKey,
          label: raw.label,
          fieldType: raw.fieldType,
          options,
          isRequired: Boolean(raw.isRequired),
          isEnabled: true,
          isEditableOnResubmit: true,
        }),
      );
      this.fieldForm.reset({fieldType: 'text', isRequired: false, optionsText: ''});
      this.toast.success('Field Added', 'Dynamic registration field enabled.');
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not add field.';
      this.toast.error('Error', msg);
    }
  }

  async toggleFieldEnabled(f: Record<string, unknown>): Promise<void> {
    try {
      await firstValueFrom(
        this.api.updateFieldConfig(Number(f['id']), {
          isRequired: Boolean(f['is_required']),
          isEnabled: !f['is_enabled'],
          isEditableOnResubmit: Boolean(f['is_editable_on_resubmit']),
        }),
      );
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not update field.';
      this.toast.error('Error', msg);
    }
  }

  async deleteField(id: number): Promise<void> {
    try {
      await firstValueFrom(this.api.deleteFieldConfig(id));
      this.toast.info('Field Removed', 'Custom field removed.');
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not delete field.';
      this.toast.error('Error', msg);
    }
  }
}
