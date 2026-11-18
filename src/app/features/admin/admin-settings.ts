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
          Configure QR credential validity, OTP expiration, organization identity, and dynamic registration form fields.
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
          <button
            type="submit"
            class="touch-target inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#1E3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0F172A]"
          >
            <mat-icon class="text-[18px]!">add</mat-icon>
            <span>Add Field</span>
          </button>
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
                  <p class="mt-0.5 font-mono text-slate-600 break-all">{{ status.database.host }} / {{ status.database.database }}</p>
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
                {{ status.database.connected ? 'Connected to ' + status.database.database + ' (' + status.database.activeEngine + ')' : 'MySQL RDS unavailable — ' + (status.database.error || 'check host/credentials') }}
              </p>
            </div>

            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-1">
              <p class="font-semibold text-[#0F172A]">24-Hour Automated Excel Email</p>
              <p class="font-mono text-slate-600 break-all">{{ status.integrations.smtpHost }} ({{ status.integrations.smtpUser || 'Unset' }})</p>
              <p class="text-slate-700">Daily summary sent to: <span class="font-mono font-semibold">{{ status.integrations.dailyReportRecipient }}</span></p>
            </div>

            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-1">
              <p class="font-semibold text-[#0F172A]">Email OTP Verification (Gmail SMTP)</p>
              <p class="font-mono text-slate-600 break-all">Sender: {{ status.integrations.smtpUser || 'Not Set' }} · {{ status.integrations.smtpHost }}</p>
              <p [class.text-emerald-700]="status.integrations.emailOtpConfigured" [class.text-slate-600]="!status.integrations.emailOtpConfigured" class="font-semibold">
                {{ status.integrations.emailOtpConfigured ? 'Active (Registration OTP Emails Enabled)' : 'SMTP Credentials Missing' }}
              </p>
            </div>

            <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-1">
              <p class="font-semibold text-[#0F172A]">AWS S3 Image &amp; Document Storage</p>
              <p class="font-mono text-slate-600 break-all">{{ status.integrations.s3Bucket || 'Local' }} ({{ status.integrations.s3Region || 'local' }})</p>
              <p class="font-mono text-[11px] text-slate-500 break-all">{{ status.integrations.filePath }}</p>
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
  protected readonly integrationStatus = signal<{
    database: {configured: boolean; connected: boolean; host: string; database: string; activeEngine: string; error?: string};
    integrations: {
      smtpConfigured: boolean;
      emailOtpConfigured: boolean;
      smtpHost: string;
      smtpUser: string;
      dailyReportRecipient: string;
      s3Configured: boolean;
      s3Bucket: string;
      s3Region: string;
      filePath: string;
      fixedAdminEmail: string;
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

  protected readonly fieldForm = this.fb.group({
    fieldKey: ['', Validators.required],
    label: ['', Validators.required],
    fieldType: ['text'],
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const res = await firstValueFrom(this.api.getSystemSettings());
    this.settingsForm.patchValue(res.settings);
    this.fieldConfigs.set(res.fieldConfigs);
    try {
      const status = await firstValueFrom(this.api.getIntegrationStatus());
      this.integrationStatus.set(status);
    } catch {
      // optional integration status check
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
    } finally {
      this.initializingDb.set(false);
    }
  }

  async saveSettings(): Promise<void> {
    const raw = this.settingsForm.value as Record<string, string>;
    await firstValueFrom(this.api.updateSystemSettings(raw));
    this.toast.success('Settings Saved', 'System configuration updated.');
  }

  async addField(): Promise<void> {
    if (this.fieldForm.invalid) return;
    await firstValueFrom(
      this.api.addFieldConfig({
        ...this.fieldForm.value,
        isRequired: false,
        isEnabled: true,
        isEditableOnResubmit: true,
      }),
    );
    this.fieldForm.reset({fieldType: 'text'});
    this.toast.success('Field Added', 'Dynamic registration field enabled.');
    await this.load();
  }

  async toggleFieldEnabled(f: Record<string, unknown>): Promise<void> {
    await firstValueFrom(
      this.api.updateFieldConfig(Number(f['id']), {
        isRequired: Boolean(f['is_required']),
        isEnabled: !f['is_enabled'],
        isEditableOnResubmit: Boolean(f['is_editable_on_resubmit']),
      }),
    );
    await this.load();
  }

  async deleteField(id: number): Promise<void> {
    await firstValueFrom(this.api.deleteFieldConfig(id));
    this.toast.info('Field Removed', 'Custom field removed.');
    await this.load();
  }
}
