import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormBuilder, ReactiveFormsModule} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {ToastService} from '../../core/services/toast.service';

@Component({
  selector: 'app-admin-audit-logs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ReactiveFormsModule, MatIconModule],
  template: `
    <div class="space-y-5">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">Security Audit Logs</h1>
        <p class="mt-1 text-sm text-slate-600">
          Immutable log of logins, registrations, approvals, rejections, QR issuances, revocations, exports, and permission changes.
        </p>
      </div>

      <form [formGroup]="form" (ngSubmit)="load()" class="flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          formControlName="search"
          placeholder="Search actor email, action, or details..."
          aria-label="Search audit logs"
          class="flex-1 h-11 rounded-lg border border-slate-300 bg-white px-3.5 text-xs"
        />
        <button
          type="submit"
          class="touch-target inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
        >
          <mat-icon class="text-[18px]!">search</mat-icon>
          <span>Filter Logs</span>
        </button>
      </form>

      <div class="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
              <th class="px-4 py-3">Timestamp</th>
              <th class="px-4 py-3">Actor</th>
              <th class="px-4 py-3">Action</th>
              <th class="px-4 py-3">Target</th>
              <th class="px-4 py-3">Details</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 text-xs">
            @for (log of logs(); track log['id']) {
              <tr>
                <td class="px-4 py-3 font-mono text-slate-500 tabular-nums whitespace-nowrap">
                  {{ '' + log['created_at'] | date: 'yyyy-MM-dd HH:mm:ss' }}
                </td>
                <td class="px-4 py-3">
                  <p class="font-semibold text-slate-900">{{ log['actor_email'] }}</p>
                  <p class="font-mono text-[11px] text-slate-500">{{ log['actor_role'] }}</p>
                </td>
                <td class="px-4 py-3 font-mono font-semibold text-[#0F172A]">{{ log['action'] }}</td>
                <td class="px-4 py-3 font-mono text-slate-600">{{ log['target_type'] }} #{{ log['target_id'] }}</td>
                <td class="px-4 py-3 font-mono text-[11px] text-slate-600 max-w-md truncate">
                  {{ log['details_json'] }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class AdminAuditLogs implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  protected readonly logs = signal<Record<string, unknown>[]>([]);
  protected readonly form = this.fb.group({search: ['']});

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getAuditLogs('', this.form.value.search || ''));
      this.logs.set(res.logs);
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not load audit logs.';
      this.toast.error('Load Failed', msg);
    }
  }
}
