import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {RouterLink} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {NotificationItem, QRCodeItem, UserRecord} from '../../core/models/types';
import {StatusText} from '../../shared/components/status-text';

@Component({
  selector: 'app-user-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, MatIconModule, StatusText],
  template: `
    <div class="space-y-6">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">Application Overview</h1>
        <p class="mt-1 text-sm text-slate-600">
          Track your verification status, active QR credential availability, and updates.
        </p>
      </div>

      @if (loading()) {
        <div class="rounded-xl border border-slate-200 bg-white p-6 animate-pulse space-y-3">
          <div class="h-5 w-48 rounded bg-slate-200"></div>
          <div class="h-4 w-72 rounded bg-slate-100"></div>
        </div>
      } @else if (errorMsg()) {
        <div class="rounded-xl border border-red-200 bg-red-50 p-6 space-y-3">
          <p class="text-sm font-semibold text-red-900">{{ errorMsg() }}</p>
          <button
            type="button"
            (click)="loadDashboard()"
            class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
          >
            <mat-icon class="text-[16px]!">refresh</mat-icon>
            <span>Retry</span>
          </button>
        </div>
      } @else if (record(); as rec) {
        <!-- Exact Status Banner -->
        <div
          class="rounded-xl border p-5 sm:p-6 bg-white"
          [class.border-amber-300]="rec.approval_status === 'PENDING'"
          [class.border-emerald-300]="rec.approval_status === 'APPROVED'"
          [class.border-red-300]="rec.approval_status === 'REJECTED'"
          [class.border-blue-300]="rec.approval_status === 'RESUBMISSION_REQUIRED'"
        >
          <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div class="space-y-1.5">
              <app-status-text [status]="rec.approval_status" />
              <h2 class="text-lg font-bold text-[#0F172A] font-display">
                @switch (rec.approval_status) {
                  @case ('PENDING') { Thank you for applying — your details are currently being reviewed by our team. }
                  @case ('APPROVED') { Great news! Your profile is approved and your QR pass is ready to use. }
                  @case ('REJECTED') { Your application could not be approved. Please see the note below for details. }
                  @case ('RESUBMISSION_REQUIRED') { We just need a quick update to your details before we can approve your pass. }
                }
              </h2>
              @if (rec.approval_status === 'REJECTED' && rec.rejection_reason) {
                <p class="text-sm text-red-700 font-medium">Reason: {{ rec.rejection_reason }}</p>
              }
              @if (rec.approval_status === 'RESUBMISSION_REQUIRED' && rec.resubmission_note) {
                <p class="text-sm text-blue-700 font-medium">Admin Note: {{ rec.resubmission_note }}</p>
              }
            </div>

            <div class="flex flex-wrap gap-2 shrink-0">
              @if (rec.approval_status === 'APPROVED') {
                <a
                  routerLink="/user/qr-card"
                  class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] whitespace-nowrap"
                >
                  <mat-icon class="text-[18px]!">qr_code_2</mat-icon>
                  <span>View QR &amp; ID Card</span>
                </a>
              }
              @if (rec.approval_status === 'RESUBMISSION_REQUIRED') {
                <a
                  routerLink="/user/profile"
                  class="touch-target inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap"
                >
                  <mat-icon class="text-[18px]!">edit</mat-icon>
                  <span>Update &amp; Resubmit</span>
                </a>
              }
            </div>
          </div>
        </div>

        <!-- Summary Grid -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-slate-500">Registration ID</p>
            <p class="mt-1.5 font-mono text-base font-bold text-[#0F172A] tabular-nums">
              {{ rec.registration_id }}
            </p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-slate-500">Submitted On</p>
            <p class="mt-1.5 font-mono text-base font-semibold text-slate-800 tabular-nums">
              {{ rec.created_at | date: 'yyyy-MM-dd' }}
            </p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-slate-500">QR Credential</p>
            <p class="mt-1.5 text-base font-semibold text-slate-900">
              {{ activeQr() ? 'Active' : 'Not Issued' }}
            </p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-white p-4">
            <p class="text-xs font-medium text-slate-500">Location</p>
            <p class="mt-1.5 text-base font-semibold text-slate-900 truncate">
              {{ rec.city }}, {{ rec.state }}
            </p>
          </div>
        </div>

        <!-- Two-Column Details: History & Notifications -->
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section class="rounded-xl border border-slate-200 bg-white p-5">
            <h3 class="text-base font-bold text-[#0F172A] font-display">Application Timeline</h3>
            <div class="mt-4 space-y-3">
              @for (item of history(); track item.id) {
                <div class="border-b border-slate-100 pb-3 last:border-b-0 last:pb-0">
                  <div class="flex items-center justify-between gap-2">
                    <app-status-text [status]="item.status" />
                    <span class="font-mono text-xs text-slate-500 tabular-nums">
                      {{ item.submitted_at | date: 'short' }}
                    </span>
                  </div>
                  <p class="mt-1 text-xs text-slate-600">{{ item.notes }}</p>
                </div>
              }
            </div>
          </section>

          <section class="rounded-xl border border-slate-200 bg-white p-5">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-base font-bold text-[#0F172A] font-display">Recent Notifications</h3>
              <a routerLink="/user/notifications" class="text-xs font-semibold text-[#1E3A5F] hover:underline">
                View All
              </a>
            </div>
            @if (recentNotifications().length === 0) {
              <p class="mt-4 text-xs text-slate-500">No notifications yet.</p>
            } @else {
              <div class="mt-4 space-y-3">
                @for (n of recentNotifications(); track n.id) {
                  <div class="border-b border-slate-100 pb-3 last:border-b-0 last:pb-0">
                    <div class="flex items-center justify-between gap-2">
                      <p class="text-xs font-semibold text-slate-900">{{ n.title }}</p>
                      <span class="font-mono text-[11px] text-slate-400 tabular-nums">
                        {{ n.created_at | date: 'shortDate' }}
                      </span>
                    </div>
                    <p class="mt-0.5 text-xs text-slate-600">{{ n.message }}</p>
                  </div>
                }
              </div>
            }
          </section>
        </div>
      }
    </div>
  `,
})
export class UserHome implements OnInit {
  private readonly api = inject(ApiService);

  protected readonly loading = signal(true);
  protected readonly errorMsg = signal<string | null>(null);
  protected readonly record = signal<UserRecord | null>(null);
  protected readonly activeQr = signal<QRCodeItem | null>(null);
  protected readonly recentNotifications = signal<NotificationItem[]>([]);
  protected readonly history = signal<
    {id: number; request_type: string; status: string; notes: string; submitted_at: string; processed_at: string | null}[]
  >([]);

  ngOnInit(): void {
    void this.loadDashboard();
  }

  async loadDashboard(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      const res = await firstValueFrom(this.api.getUserDashboard());
      this.record.set(res.record);
      this.activeQr.set(res.activeQr);
      this.recentNotifications.set(res.recentNotifications);
      this.history.set(res.history);
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not load your dashboard right now.';
      this.errorMsg.set(msg);
    } finally {
      this.loading.set(false);
    }
  }
}
