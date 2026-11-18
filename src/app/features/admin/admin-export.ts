import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormBuilder, ReactiveFormsModule} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {ToastService} from '../../core/services/toast.service';

@Component({
  selector: 'app-admin-export',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ReactiveFormsModule, MatIconModule],
  template: `
    <div class="space-y-6">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">Excel Export (.xlsx)</h1>
        <p class="mt-1 text-sm text-slate-600">
          Generate formatted Excel spreadsheets with frozen headers, auto-filters, and QR validity metadata. Every export is logged.
        </p>
      </div>

      <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
        <h2 class="text-sm font-bold text-[#0F172A] font-display">Export Filters</h2>
        <form [formGroup]="form" (ngSubmit)="downloadExcel()" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label for="ex-status" class="block text-xs font-semibold text-slate-700 mb-1.5">Approval Status</label>
            <select id="ex-status" formControlName="status" class="w-full h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs">
              <option value="ALL">All Statuses</option>
              <option value="APPROVED">Approved Only</option>
              <option value="PENDING">Pending Only</option>
              <option value="REJECTED">Rejected Only</option>
              <option value="RESUBMISSION_REQUIRED">Resubmission Required</option>
            </select>
          </div>
          <div>
            <label for="ex-state" class="block text-xs font-semibold text-slate-700 mb-1.5">State</label>
            <input id="ex-state" type="text" formControlName="state" placeholder="Optional state" class="w-full h-11 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>
          <div>
            <label for="ex-city" class="block text-xs font-semibold text-slate-700 mb-1.5">City</label>
            <input id="ex-city" type="text" formControlName="city" placeholder="Optional city" class="w-full h-11 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>
          <div>
            <label for="ex-from" class="block text-xs font-semibold text-slate-700 mb-1.5">From Date</label>
            <input id="ex-from" type="date" formControlName="dateFrom" class="w-full h-11 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>
          <div>
            <label for="ex-to" class="block text-xs font-semibold text-slate-700 mb-1.5">To Date</label>
            <input id="ex-to" type="date" formControlName="dateTo" class="w-full h-11 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>

          <div class="sm:col-span-2 lg:col-span-5 flex justify-end">
            <button
              type="submit"
              [disabled]="exporting()"
              class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
            >
              <mat-icon class="text-[18px]!">download</mat-icon>
              <span>{{ exporting() ? 'Generating Workbook...' : 'Download Excel Report (.xlsx)' }}</span>
            </button>
          </div>
        </form>
      </section>

      <!-- 24-Hour Automated Email Report -->
      <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 class="text-sm font-bold text-[#0F172A] font-display">24-Hour Automated Email Report</h2>
            <p class="mt-1 text-xs text-slate-600">
              Automatically generates and emails the complete user verification Excel sheet every 24 hours to the fixed administrator inbox.
            </p>
          </div>
          <button
            type="button"
            (click)="sendReportNow()"
            [disabled]="sendingEmail()"
            class="touch-target inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-[#0F172A] hover:bg-slate-50 disabled:opacity-50"
          >
            <mat-icon class="text-[18px]!">send</mat-icon>
            <span>{{ sendingEmail() ? 'Sending Email Report...' : 'Send Verification Excel Now' }}</span>
          </button>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs">
          <div>
            <p class="text-slate-500 font-medium">Recipient Email</p>
            <p class="mt-1 font-mono font-semibold text-[#0F172A] break-all">{{ recipientEmail() }}</p>
          </div>
          <div>
            <p class="text-slate-500 font-medium">Dispatch Cadence</p>
            <p class="mt-1 font-semibold text-[#0F172A] tabular-nums">Every {{ scheduleHours() }} Hours</p>
          </div>
          <div>
            <p class="text-slate-500 font-medium">Email Delivery Gateway</p>
            <p class="mt-1 font-semibold" [class.text-emerald-700]="smtpConfigured()" [class.text-amber-700]="!smtpConfigured()">
              {{ deliveryModeLabel() }}
            </p>
          </div>
        </div>

        <div class="overflow-x-auto border border-slate-200 rounded-lg">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                <th class="px-4 py-3">Status</th>
                <th class="px-4 py-3">Trigger</th>
                <th class="px-4 py-3">Filename</th>
                <th class="px-4 py-3">Records</th>
                <th class="px-4 py-3">Sent At</th>
                <th class="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 text-xs">
              @if (scheduledLogs().length === 0) {
                <tr>
                  <td colspan="6" class="px-4 py-6 text-center text-slate-500">No automated or manual email dispatches logged yet.</td>
                </tr>
              } @else {
                @for (log of scheduledLogs(); track log['id']) {
                  <tr>
                    <td class="px-4 py-3 font-semibold" [class.text-emerald-700]="log['status'] === 'SENT'" [class.text-red-700]="log['status'] !== 'SENT'">
                      {{ log['status'] }}
                    </td>
                    <td class="px-4 py-3 font-mono text-slate-700">{{ log['trigger_type'] }}</td>
                    <td class="px-4 py-3 font-mono text-slate-900">{{ log['filename'] }}</td>
                    <td class="px-4 py-3 font-mono tabular-nums">{{ log['record_count'] }}</td>
                    <td class="px-4 py-3 font-mono text-slate-500 tabular-nums">{{ '' + log['sent_at'] | date: 'medium' }}</td>
                    <td class="px-4 py-3 text-slate-600">{{ log['error_message'] || 'Delivered to recipient' }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      </section>

      <!-- Export Audit History -->
      <section class="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div class="border-b border-slate-200 px-5 py-4">
          <h2 class="text-sm font-bold text-[#0F172A] font-display">Export Audit History</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                <th class="px-4 py-3">Filename</th>
                <th class="px-4 py-3">Admin</th>
                <th class="px-4 py-3">Records</th>
                <th class="px-4 py-3">Exported At</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 text-xs">
              @if (history().length === 0) {
                <tr>
                  <td colspan="4" class="px-4 py-6 text-center text-slate-500">No Excel exports generated yet.</td>
                </tr>
              } @else {
                @for (h of history(); track h['id']) {
                  <tr>
                    <td class="px-4 py-3 font-mono font-medium text-slate-900">{{ h['filename'] }}</td>
                    <td class="px-4 py-3 text-slate-700">{{ h['admin_email'] }}</td>
                    <td class="px-4 py-3 font-mono tabular-nums">{{ h['record_count'] }}</td>
                    <td class="px-4 py-3 font-mono text-slate-500 tabular-nums">{{ '' + h['exported_at'] | date: 'medium' }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
})
export class AdminExport implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  protected readonly exporting = signal(false);
  protected readonly sendingEmail = signal(false);
  protected readonly history = signal<Record<string, unknown>[]>([]);
  protected readonly scheduledLogs = signal<Record<string, unknown>[]>([]);
  protected readonly recipientEmail = signal('kishore.sathayush@gmail.com');
  protected readonly scheduleHours = signal(24);
  protected readonly smtpConfigured = signal(false);
  protected readonly emailDeliveryMode = signal('console');

  protected readonly form = this.fb.group({
    status: ['ALL'],
    state: [''],
    city: [''],
    dateFrom: [''],
    dateTo: [''],
  });

  ngOnInit(): void {
    void this.loadHistory();
    void this.loadScheduledLogs();
  }

  deliveryModeLabel(): string {
    if (!this.smtpConfigured()) return 'Not Configured';
    switch (this.emailDeliveryMode()) {
      case 'https-webhook':
        return 'Configured (Apps Script HTTPS Relay)';
      case 'brevo-https':
        return 'Configured (Brevo HTTPS API)';
      case 'resend-https':
        return 'Configured (Resend HTTPS API)';
      case 'gmail-smtp':
        return 'Configured (Gmail SMTP TLS)';
      default:
        return 'Configured';
    }
  }

  async loadHistory(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getExportHistory());
      this.history.set(res.history);
    } catch {
      this.toast.error('Load Failed', 'Could not load Excel export history.');
    }
  }

  async loadScheduledLogs(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getScheduledReportLogs());
      this.recipientEmail.set(res.recipientEmail);
      this.scheduleHours.set(res.scheduleIntervalHours);
      this.smtpConfigured.set(res.smtpConfigured);
      this.emailDeliveryMode.set(res.emailDeliveryMode || 'console');
      this.scheduledLogs.set(res.logs);
    } catch {
      // ignore if endpoint temporarily unavailable
    }
  }

  async sendReportNow(): Promise<void> {
    this.sendingEmail.set(true);
    try {
      const res = await firstValueFrom(this.api.sendDailyReportNow());
      if (res.success) {
        this.toast.success(
          'Email Report Sent',
          `Sent ${res.recordCount} record(s) to ${res.recipient}.`,
        );
      } else {
        this.toast.error('Email Dispatch Logged Failure', res.error || 'SMTP delivery failed.');
      }
      await this.loadScheduledLogs();
    } catch {
      this.toast.error('Request Failed', 'Could not trigger Excel email dispatch.');
    } finally {
      this.sendingEmail.set(false);
    }
  }

  async downloadExcel(): Promise<void> {
    this.exporting.set(true);
    try {
      const v = this.form.value;
      const blob = await firstValueFrom(
        this.api.exportExcel({
          status: v.status || 'ALL',
          state: v.state || '',
          city: v.city || '',
          dateFrom: v.dateFrom || '',
          dateTo: v.dateTo || '',
        }),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SecureQR_Export_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast.success('Export Ready', 'Formatted Excel workbook downloaded.');
      await this.loadHistory();
    } catch {
      this.toast.error('Export Failed', 'Unable to generate Excel report.');
    } finally {
      this.exporting.set(false);
    }
  }
}
