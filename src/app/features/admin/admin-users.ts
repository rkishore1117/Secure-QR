import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {FormBuilder, ReactiveFormsModule} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {AuthService} from '../../core/services/auth.service';
import {ToastService} from '../../core/services/toast.service';
import {StatusText} from '../../shared/components/status-text';

@Component({
  selector: 'app-admin-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatIconModule, StatusText],
  template: `
    <div class="space-y-5">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">User Management</h1>
        <p class="mt-1 text-sm text-slate-600">
          Inspect registered member accounts and manage active/inactive account status.
        </p>
      </div>

      <form [formGroup]="searchForm" (ngSubmit)="load()" class="flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          formControlName="search"
          placeholder="Search name, email, mobile, or registration ID..."
          aria-label="Search users"
          class="flex-1 h-11 rounded-lg border border-slate-300 bg-white px-3.5 text-sm"
        />
        <button
          type="submit"
          class="touch-target inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
        >
          <mat-icon class="text-[18px]!">search</mat-icon>
          <span>Search</span>
        </button>
      </form>

      <div class="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
              <th class="px-4 py-3">Member</th>
              <th class="px-4 py-3">Registration ID</th>
              <th class="px-4 py-3">Mobile</th>
              <th class="px-4 py-3">Application</th>
              <th class="px-4 py-3">Account</th>
              <th class="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 text-xs">
            @for (u of users(); track u['account_id']) {
              <tr class="hover:bg-slate-50">
                <td class="px-4 py-3">
                  <div class="flex items-center gap-3">
                    <img
                      [src]="'' + u['profile_photo_url']"
                      [alt]="'' + u['full_name']"
                      class="h-9 w-9 rounded-lg object-cover border border-slate-200"
                      referrerpolicy="no-referrer"
                    />
                    <div>
                      <p class="font-semibold text-slate-900">{{ u['full_name'] }}</p>
                      <p class="text-[11px] text-slate-500">{{ u['email'] }}</p>
                    </div>
                  </div>
                </td>
                <td class="px-4 py-3 font-mono font-medium tabular-nums">{{ u['registration_id'] }}</td>
                <td class="px-4 py-3 font-mono tabular-nums">{{ u['mobile'] }}</td>
                <td class="px-4 py-3"><app-status-text [status]="'' + u['approval_status']" /></td>
                <td class="px-4 py-3 font-semibold" [class.text-emerald-700]="u['is_active']" [class.text-red-700]="!u['is_active']">
                  {{ u['is_active'] ? 'Active' : 'Inactive' }}
                </td>
                <td class="px-4 py-3 text-right">
                  @if (auth.hasPermission('can_manage_users')) {
                    <button
                      type="button"
                      (click)="toggleStatus(Number(u['account_id']), !Boolean(u['is_active']))"
                      class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 whitespace-nowrap"
                    >
                      {{ u['is_active'] ? 'Deactivate' : 'Activate' }}
                    </button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class AdminUsers implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly Number = Number;
  protected readonly Boolean = Boolean;
  protected readonly users = signal<Record<string, unknown>[]>([]);
  protected readonly searchForm = this.fb.group({search: ['']});

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const res = await firstValueFrom(this.api.getAdminUsers(this.searchForm.value.search || ''));
    this.users.set(res.users);
  }

  async toggleStatus(accountId: number, isActive: boolean): Promise<void> {
    await firstValueFrom(this.api.updateUserAccountStatus(accountId, isActive));
    this.toast.success('Account Updated', `User account ${isActive ? 'activated' : 'deactivated'}.`);
    await this.load();
  }
}
