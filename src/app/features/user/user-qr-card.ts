import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {ToastService} from '../../core/services/toast.service';
import {QRCodeItem, UserRecord} from '../../core/models/types';
import {IdCardPreview} from '../../shared/components/id-card-preview';
import {StatusText} from '../../shared/components/status-text';

@Component({
  selector: 'app-user-qr-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatIconModule, IdCardPreview, StatusText],
  template: `
    <div class="space-y-6">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">My QR Code &amp; Printable ID Card</h1>
        <p class="mt-1 text-sm text-slate-600">
          Download your cryptographic QR credential or print your official verification ID card.
        </p>
      </div>

      @if (loading()) {
        <div class="h-64 rounded-xl border border-slate-200 bg-white animate-pulse"></div>
      } @else if (record(); as rec) {
        @if (rec.approval_status === 'APPROVED' && activeQr(); as qr) {
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
            <!-- QR Download Card -->
            <section class="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 space-y-5">
              <div class="flex items-center justify-between">
                <h2 class="text-base font-bold text-[#0F172A] font-display">Active QR Credential</h2>
                <app-status-text [status]="qr.status" />
              </div>

              <div class="flex justify-center rounded-xl border border-slate-200 bg-slate-50 p-6">
                <img
                  [src]="qr.qr_png_data_url"
                  alt="Active Member QR Code"
                  class="h-56 w-56 object-contain"
                  referrerpolicy="no-referrer"
                />
              </div>

              <div class="space-y-2 text-xs">
                <div class="flex justify-between gap-2 border-b border-slate-100 pb-2">
                  <span class="text-slate-500">Token Reference</span>
                  <span class="font-mono font-semibold text-slate-900 tabular-nums">{{ qr.token_prefix }}</span>
                </div>
                <div class="flex justify-between gap-2 border-b border-slate-100 pb-2">
                  <span class="text-slate-500">Issued Date</span>
                  <span class="font-mono text-slate-900 tabular-nums">{{ qr.issued_at | date: 'mediumDate' }}</span>
                </div>
                <div class="flex justify-between gap-2 border-b border-slate-100 pb-2">
                  <span class="text-slate-500">Expires Date</span>
                  <span class="font-mono font-semibold text-emerald-700 tabular-nums">{{ qr.expires_at | date: 'mediumDate' }}</span>
                </div>
                <div class="flex justify-between gap-2">
                  <span class="text-slate-500">Verification Scans</span>
                  <span class="font-mono text-slate-900 tabular-nums">{{ qr.scan_count }}</span>
                </div>
              </div>

              <div class="flex flex-col gap-2.5 sm:flex-row">
                <button
                  type="button"
                  (click)="downloadPng()"
                  class="touch-target flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
                >
                  <mat-icon class="text-[18px]!">download</mat-icon>
                  <span>Download QR PNG</span>
                </button>
                <button
                  type="button"
                  (click)="printCard()"
                  class="touch-target flex-1 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                >
                  <mat-icon class="text-[18px]!">print</mat-icon>
                  <span>Print ID Card</span>
                </button>
              </div>
            </section>

            <!-- Printable Institutional ID Card -->
            <section class="lg:col-span-7 flex flex-col items-center lg:items-start">
              <app-id-card-preview
                [record]="rec"
                [qr]="qr"
                [organizationName]="organizationName()"
              />
            </section>
          </div>
        } @else {
          <div class="rounded-xl border border-slate-200 bg-white p-8 text-center">
            <mat-icon class="text-[40px]! text-slate-400">lock</mat-icon>
            <h2 class="mt-3 text-base font-bold text-[#0F172A] font-display">
              QR Credential Unavailable
            </h2>
            <p class="mt-1.5 text-sm text-slate-600 max-w-md mx-auto">
              Only approved applications with an active QR code can view and download credentials. Your current status is
              <strong>{{ rec.approval_status }}</strong>.
            </p>
          </div>
        }
      }
    </div>
  `,
})
export class UserQrCard implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  protected readonly loading = signal(true);
  protected readonly record = signal<UserRecord | null>(null);
  protected readonly activeQr = signal<QRCodeItem | null>(null);
  protected readonly organizationName = signal('Secure QR Verification Authority');

  async ngOnInit(): Promise<void> {
    try {
      const dash = await firstValueFrom(this.api.getUserDashboard());
      this.record.set(dash.record);
      this.activeQr.set(dash.activeQr);
      this.organizationName.set(dash.organizationName);
    } finally {
      this.loading.set(false);
    }
  }

  async downloadPng(): Promise<void> {
    try {
      const blob = await firstValueFrom(this.api.downloadUserQrPng());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `QR_${this.record()?.registration_id || 'credential'}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      this.toast.error('Download Failed', 'Unable to download active QR image.');
    }
  }

  printCard(): void {
    window.print();
  }
}
