import {ChangeDetectionStrategy, Component, input} from '@angular/core';
import {DatePipe} from '@angular/common';
import {MatIconModule} from '@angular/material/icon';
import {QRCodeItem, UserRecord} from '../../core/models/types';

@Component({
  selector: 'app-id-card-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatIconModule],
  template: `
    <div
      class="printable-id-card w-full max-w-[420px] overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm"
    >
      <!-- Top Institutional Header -->
      <div class="flex items-center justify-between gap-3 bg-[#0F172A] px-5 py-4 text-white">
        <div class="flex items-center gap-3 min-w-0">
          <img
            src="/assets/images/brand_shield_emblem_1794911274112.jpg"
            alt="Authority Emblem"
            class="h-10 w-10 shrink-0 rounded-lg object-cover border border-white/20"
            referrerpolicy="no-referrer"
          />
          <div class="min-w-0">
            <p class="truncate text-sm font-bold tracking-tight font-display">
              {{ organizationName() }}
            </p>
            <p class="text-[11px] text-slate-300">Verified Digital Identity Credential</p>
          </div>
        </div>
        <span class="font-mono text-[11px] font-medium text-emerald-300 whitespace-nowrap">
          ACTIVE
        </span>
      </div>

      <!-- Card Body -->
      <div class="p-5">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
          <img
            [src]="record().profile_photo_url"
            [alt]="record().full_name"
            class="h-24 w-24 shrink-0 rounded-xl border border-slate-200 object-cover bg-slate-100"
            referrerpolicy="no-referrer"
          />
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="truncate text-lg font-bold text-slate-900 font-display">
              {{ record().full_name }}
            </h3>
            <p class="font-mono text-xs font-semibold text-slate-700 tabular-nums">
              REG ID: {{ record().registration_id }}
            </p>
            <p class="font-mono text-xs text-slate-500 tabular-nums">
              USER ID: #{{ record().user_id }}
            </p>
            <p class="text-xs text-slate-600 truncate">
              {{ record().city }}, {{ record().state }} · {{ record().country }}
            </p>
          </div>
        </div>

        <div class="my-4 border-t border-slate-200"></div>

        <div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div class="shrink-0 rounded-lg border border-slate-200 bg-white p-2">
            <img
              [src]="qr().qr_png_data_url"
              alt="Cryptographic Verification QR Code"
              class="h-32 w-32 object-contain"
              referrerpolicy="no-referrer"
            />
          </div>
          <div class="min-w-0 flex-1 space-y-2 text-xs">
            <div>
              <p class="font-medium text-slate-500">Issued Date</p>
              <p class="font-mono font-medium text-slate-900 tabular-nums">
                {{ qr().issued_at | date: 'yyyy-MM-dd' }}
              </p>
            </div>
            <div>
              <p class="font-medium text-slate-500">Valid Through</p>
              <p class="font-mono font-semibold text-emerald-700 tabular-nums">
                {{ qr().expires_at | date: 'yyyy-MM-dd' }}
              </p>
            </div>
            <div>
              <p class="font-medium text-slate-500">Verification URL</p>
              <p class="break-all font-mono text-[11px] leading-snug text-slate-600">
                {{ qr().verification_url }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="border-t border-slate-200 bg-slate-50 px-5 py-2.5 text-[11px] text-slate-500 flex items-center justify-between gap-2">
        <span>Verify via authorized Admin Scanner</span>
        <span class="font-mono tabular-nums">{{ qr().token_prefix }}</span>
      </div>
    </div>
  `,
})
export class IdCardPreview {
  readonly record = input.required<UserRecord>();
  readonly qr = input.required<QRCodeItem>();
  readonly organizationName = input<string>('Secure QR Verification Authority');
}
