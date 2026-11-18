import {ChangeDetectionStrategy, Component, OnInit, inject} from '@angular/core';
import {DatePipe} from '@angular/common';
import {RouterLink} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {NotificationService} from '../../core/services/notification.service';

@Component({
  selector: 'app-admin-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, MatIconModule],
  template: `
    <div class="space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">Admin Notification Center</h1>
          <p class="mt-1 text-sm text-slate-600">
            Real-time alerts for new registrations, resubmissions, and security events.
          </p>
        </div>
        @if (notif.unreadCount() > 0) {
          <button
            type="button"
            (click)="notif.markAllRead()"
            class="touch-target inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
          >
            <mat-icon class="text-[18px]!">done_all</mat-icon>
            <span>Mark All Read</span>
          </button>
        }
      </div>

      <div class="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
        @if (notif.notifications().length === 0) {
          <div class="p-8 text-center text-sm text-slate-500">No admin notifications recorded.</div>
        } @else {
          @for (item of notif.notifications(); track item.id) {
            <div class="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" [class.bg-slate-50]="!item.is_read">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <p class="text-sm font-bold text-slate-900">{{ item.title }}</p>
                  @if (!item.is_read) {
                    <span class="font-mono text-[11px] font-semibold text-amber-700">NEW</span>
                  }
                </div>
                <p class="mt-1 text-xs text-slate-600">{{ item.message }}</p>
                <p class="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                  {{ item.created_at | date: 'medium' }}
                </p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                @if (item.link_path) {
                  <a
                    [routerLink]="item.link_path"
                    class="touch-target inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100"
                  >
                    Open
                  </a>
                }
                @if (!item.is_read) {
                  <button
                    type="button"
                    (click)="notif.markRead(item.id)"
                    class="touch-target rounded-lg bg-[#0F172A] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
                  >
                    Mark Read
                  </button>
                }
              </div>
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class AdminNotifications implements OnInit {
  protected readonly notif = inject(NotificationService);

  ngOnInit(): void {
    void this.notif.loadNotifications();
  }
}
