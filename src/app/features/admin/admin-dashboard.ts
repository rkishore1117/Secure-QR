import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {RouterLink} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {DashboardStats, UserRecord} from '../../core/models/types';
import {StatusText} from '../../shared/components/status-text';

@Component({
  selector: 'app-admin-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, MatIconModule, StatusText],
  template: `
    <div class="space-y-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">Operations Dashboard</h1>
          <p class="mt-1 text-sm text-slate-600">
            Live overview of member applications, active QR passes, and recent check-in scans.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <a
            routerLink="/admin/registrations"
            [queryParams]="{status: 'PENDING'}"
            class="touch-target inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap"
          >
            <mat-icon class="text-[18px]!">pending_actions</mat-icon>
            <span>Review Pending</span>
          </a>
          <a
            routerLink="/admin/scanner"
            class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] whitespace-nowrap"
          >
            <mat-icon class="text-[18px]!">qr_code_scanner</mat-icon>
            <span>Open Scanner</span>
          </a>
        </div>
      </div>

      @if (stats(); as s) {
        <!-- 8 Required KPI Cards -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-2 md:grid-cols-4">
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-slate-500">Total Users</p>
            <p class="mt-1.5 font-mono text-2xl font-bold text-[#0F172A] tabular-nums">{{ s.totalUsers }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-amber-700">Pending Registrations</p>
            <p class="mt-1.5 font-mono text-2xl font-bold text-amber-700 tabular-nums">{{ s.pendingRegistrations }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-emerald-700">Approved Users</p>
            <p class="mt-1.5 font-mono text-2xl font-bold text-emerald-700 tabular-nums">{{ s.approvedUsers }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-red-700">Rejected Users</p>
            <p class="mt-1.5 font-mono text-2xl font-bold text-red-700 tabular-nums">{{ s.rejectedUsers }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-slate-500">Active QR Codes</p>
            <p class="mt-1.5 font-mono text-2xl font-bold text-[#0F172A] tabular-nums">{{ s.activeQrCodes }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-slate-500">Expired QR Codes</p>
            <p class="mt-1.5 font-mono text-2xl font-bold text-amber-700 tabular-nums">{{ s.expiredQrCodes }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-slate-500">Revoked QR Codes</p>
            <p class="mt-1.5 font-mono text-2xl font-bold text-red-700 tabular-nums">{{ s.revokedQrCodes }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-slate-500">Total QR Scans</p>
            <p class="mt-1.5 font-mono text-2xl font-bold text-[#1E3A5F] tabular-nums">{{ s.totalQrScans }}</p>
          </div>
        </div>
      }

      <!-- Two-Column Activity Tables -->
      <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section class="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div class="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 class="text-sm font-bold text-[#0F172A] font-display">Recent Registration Requests</h2>
            <a routerLink="/admin/registrations" class="text-xs font-semibold text-[#1E3A5F] hover:underline">
              View All
            </a>
          </div>
          <div class="divide-y divide-slate-100">
            @for (r of recentRegistrations(); track r.id) {
              <div class="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                <div class="flex items-center gap-3 min-w-0">
                  <img
                    [src]="r.profile_photo_url"
                    [alt]="r.full_name"
                    class="h-9 w-9 shrink-0 rounded-lg object-cover border border-slate-200"
                    referrerpolicy="no-referrer"
                  />
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-slate-900">{{ r.full_name }}</p>
                    <p class="truncate font-mono text-[11px] text-slate-500 tabular-nums">
                      {{ r.registration_id }} · {{ r.city }}, {{ r.state }}
                    </p>
                  </div>
                </div>
                <app-status-text [status]="r.approval_status" />
              </div>
            }
          </div>
        </section>

        <section class="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div class="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 class="text-sm font-bold text-[#0F172A] font-display">Recent QR Verification Scans</h2>
            <a routerLink="/admin/scanner" class="text-xs font-semibold text-[#1E3A5F] hover:underline">
              Open Scanner
            </a>
          </div>
          <div class="divide-y divide-slate-100">
            @if (recentScans().length === 0) {
              <p class="p-6 text-xs text-slate-500">No scans recorded yet.</p>
            } @else {
              @for (scan of recentScans(); track scan['id']) {
                <div class="flex items-center justify-between gap-3 px-5 py-3">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-slate-900">
                      {{ scan['holder_name'] || 'Unrecognized Token' }}
                    </p>
                    <p class="truncate font-mono text-[11px] text-slate-500 tabular-nums">
                      {{ scan['registration_id'] || scan['scanned_token_prefix'] }} · {{ '' + scan['scanned_at'] | date: 'short' }}
                    </p>
                  </div>
                  <app-status-text [status]="'' + scan['result_status']" />
                </div>
              }
            }
          </div>
        </section>
      </div>
    </div>
  `,
})
export class AdminDashboard implements OnInit {
  private readonly api = inject(ApiService);

  protected readonly stats = signal<DashboardStats | null>(null);
  protected readonly recentRegistrations = signal<UserRecord[]>([]);
  protected readonly recentScans = signal<Record<string, unknown>[]>([]);

  async ngOnInit(): Promise<void> {
    const res = await firstValueFrom(this.api.getAdminDashboardStats());
    this.stats.set(res.stats);
    this.recentRegistrations.set(res.recentRegistrations);
    this.recentScans.set(res.recentScans);
  }
}
