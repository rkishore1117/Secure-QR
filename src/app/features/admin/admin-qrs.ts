import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {ToastService} from '../../core/services/toast.service';
import {QRCodeItem} from '../../core/models/types';
import {StatusText} from '../../shared/components/status-text';

@Component({
  selector: 'app-admin-qrs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatIconModule, StatusText],
  template: `
    <div class="space-y-5">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">QR Credential Management</h1>
        <p class="mt-1 text-sm text-slate-600">
          Inspect issued 256-bit cryptographic QR credentials, revoke compromised passes, or regenerate active credentials.
        </p>
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        @for (qr of qrs(); track qr.id) {
          <div class="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-bold text-slate-900">{{ qr.full_name }}</p>
                <p class="font-mono text-xs text-slate-500 tabular-nums">{{ qr.registration_id }}</p>
              </div>
              <app-status-text [status]="qr.status" />
            </div>

            <div class="flex items-center gap-4">
              <img
                [src]="qr.qr_png_data_url"
                alt="QR Preview"
                class="h-20 w-20 shrink-0 rounded-lg border border-slate-200 object-contain p-1"
                referrerpolicy="no-referrer"
              />
              <div class="min-w-0 space-y-1 text-xs">
                <p class="font-mono text-slate-700 tabular-nums">Hash Prefix: {{ qr.token_prefix }}</p>
                <p class="font-mono text-slate-500 tabular-nums">Issued: {{ qr.issued_at | date: 'yyyy-MM-dd' }}</p>
                <p class="font-mono text-slate-500 tabular-nums">Expires: {{ qr.expires_at | date: 'yyyy-MM-dd' }}</p>
                <p class="font-mono text-slate-700 tabular-nums">Scans: {{ qr.scan_count }}</p>
              </div>
            </div>

            @if (qr.revoke_reason) {
              <p class="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2">{{ qr.revoke_reason }}</p>
            }

            <div class="flex flex-wrap gap-2 pt-1">
              @if (qr.status === 'ACTIVE') {
                <button
                  type="button"
                  (click)="revoke(qr.id)"
                  class="touch-target flex-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 whitespace-nowrap"
                >
                  Revoke
                </button>
              }
              <button
                type="button"
                (click)="regenerate(qr.id)"
                class="touch-target flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap"
              >
                Regenerate
              </button>
            </div>
          </div>
        }
      </div>
    </div>
  `,
})
export class AdminQrs implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  protected readonly qrs = signal<QRCodeItem[]>([]);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getAdminQrs());
      this.qrs.set(res.qrs);
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not load QR credentials.';
      this.toast.error('Load Failed', msg);
    }
  }

  async revoke(qrId: number): Promise<void> {
    try {
      await firstValueFrom(this.api.revokeQr(qrId, 'Revoked via QR Management console'));
      this.toast.info('QR Revoked', 'Credential marked REVOKED immediately.');
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not revoke QR credential.';
      this.toast.error('Error', msg);
    }
  }

  async regenerate(qrId: number): Promise<void> {
    try {
      await firstValueFrom(this.api.regenerateQr(qrId));
      this.toast.success('QR Regenerated', 'Previous QR retired and new 256-bit QR issued.');
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not regenerate QR.';
      this.toast.error('Error', msg);
    }
  }
}
