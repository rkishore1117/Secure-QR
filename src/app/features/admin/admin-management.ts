import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {FormBuilder, ReactiveFormsModule, Validators} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {ToastService} from '../../core/services/toast.service';

@Component({
  selector: 'app-admin-management',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="space-y-6">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">Admin Management &amp; Permissions</h1>
        <p class="mt-1 text-sm text-slate-600">
          Super Admin control over delegated Admin accounts and module-level authorization.
        </p>
      </div>

      <!-- Create New Delegated Admin -->
      <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <h2 class="text-sm font-bold text-[#0F172A] font-display">Provision New Admin Account</h2>
        <form [formGroup]="createForm" (ngSubmit)="createAdmin()" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label for="adm-name" class="block text-xs font-semibold text-slate-700 mb-1">Full Name</label>
            <input id="adm-name" type="text" formControlName="fullName" class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>
          <div>
            <label for="adm-email" class="block text-xs font-semibold text-slate-700 mb-1">Email</label>
            <input id="adm-email" type="email" formControlName="email" class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>
          <div>
            <label for="adm-mobile" class="block text-xs font-semibold text-slate-700 mb-1">Mobile</label>
            <input id="adm-mobile" type="tel" formControlName="mobile" class="w-full h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs" />
          </div>
          <div>
            <label for="adm-dept" class="block text-xs font-semibold text-slate-700 mb-1">Department</label>
            <input id="adm-dept" type="text" formControlName="department" class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>
          <div>
            <label for="adm-desig" class="block text-xs font-semibold text-slate-700 mb-1">Designation</label>
            <input id="adm-desig" type="text" formControlName="designation" class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs" />
          </div>
          <div>
            <label for="adm-pw" class="block text-xs font-semibold text-slate-700 mb-1">Temporary Password</label>
            <div class="relative">
              <input
                id="adm-pw"
                [type]="showPassword() ? 'text' : 'password'"
                formControlName="password"
                class="w-full h-10 rounded-lg border border-slate-300 pl-3 pr-10 text-xs"
              />
              <button
                type="button"
                (click)="showPassword.set(!showPassword())"
                [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
                class="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-slate-500 hover:text-slate-800"
              >
                <mat-icon class="text-[18px]!">{{ showPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
              </button>
            </div>
          </div>

          <div class="sm:col-span-2 lg:col-span-3">
            <p class="text-xs font-semibold text-slate-700 mb-2">Assign Module Permissions</p>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              @for (p of availablePermissions(); track p.code) {
                <label class="flex items-start gap-2 rounded-lg border border-slate-200 p-2.5 text-xs cursor-pointer hover:bg-slate-50">
                  <input
                    type="checkbox"
                    [checked]="selectedCreatePerms().includes(p.code)"
                    (change)="toggleCreatePerm(p.code)"
                    class="mt-0.5 h-4 w-4 rounded border-slate-300"
                  />
                  <span>
                    <strong class="block text-slate-900">{{ p.label }}</strong>
                    <span class="text-[11px] text-slate-500">{{ p.description }}</span>
                  </span>
                </label>
              }
            </div>
          </div>

          <div class="sm:col-span-2 lg:col-span-3 flex justify-end">
            <button
              type="submit"
              [disabled]="creating()"
              class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
            >
              <mat-icon class="text-[18px]!">person_add</mat-icon>
              <span>Create Admin Account</span>
            </button>
          </div>
        </form>
      </section>

      <!-- Existing Admins -->
      <section class="space-y-3">
        @for (adm of admins(); track adm['id']) {
          <div class="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p class="text-sm font-bold text-[#0F172A] font-display">
                  {{ adm['full_name'] }} · {{ adm['role'] }}
                </p>
                <p class="font-mono text-xs text-slate-500">{{ adm['email'] }} · {{ adm['department'] }}</p>
              </div>
              @if (adm['role'] !== 'SUPER_ADMIN') {
                <button
                  type="button"
                  (click)="toggleActive(Number(adm['id']), !Boolean(adm['is_active']))"
                  class="touch-target rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                >
                  {{ adm['is_active'] ? 'Deactivate' : 'Activate' }}
                </button>
              }
            </div>

            @if (adm['role'] === 'ADMIN') {
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 border-t border-slate-100 pt-3">
                @for (p of availablePermissions(); track p.code) {
                  <label class="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      [checked]="hasAdminPerm(adm, p.code)"
                      (change)="toggleExistingAdminPerm(adm, p.code)"
                      class="h-4 w-4 rounded border-slate-300"
                    />
                    <span class="text-slate-700">{{ p.label }}</span>
                  </label>
                }
              </div>
            }
          </div>
        }
      </section>
    </div>
  `,
})
export class AdminManagement implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  protected readonly Number = Number;
  protected readonly Boolean = Boolean;
  protected readonly admins = signal<Record<string, unknown>[]>([]);
  protected readonly availablePermissions = signal<{code: string; label: string; description: string}[]>([]);
  protected readonly selectedCreatePerms = signal<string[]>([
    'can_view_registrations',
    'can_scan_qr',
  ]);
  protected readonly creating = signal(false);
  protected readonly showPassword = signal(false);

  protected readonly createForm = this.fb.group({
    fullName: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    mobile: ['', Validators.required],
    department: ['Verification Operations', Validators.required],
    designation: ['Verification Officer', Validators.required],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getAdmins());
      this.admins.set(res.admins);
      this.availablePermissions.set(res.availablePermissions);
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not load admin accounts.';
      this.toast.error('Load Failed', msg);
    }
  }

  toggleCreatePerm(code: string): void {
    this.selectedCreatePerms.update((list) =>
      list.includes(code) ? list.filter((c) => c !== code) : [...list, code],
    );
  }

  hasAdminPerm(adm: Record<string, unknown>, code: string): boolean {
    const perms = (adm['permissions'] as string[]) || [];
    return perms.includes(code);
  }

  async toggleExistingAdminPerm(adm: Record<string, unknown>, code: string): Promise<void> {
    const current = (adm['permissions'] as string[]) || [];
    const updated = current.includes(code)
      ? current.filter((c) => c !== code)
      : [...current, code];
    try {
      await firstValueFrom(this.api.updateAdmin(Number(adm['id']), {permissions: updated}));
      this.toast.success('Permissions Updated', `Updated permissions for ${adm['full_name']}.`);
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not update permissions.';
      this.toast.error('Error', msg);
    }
  }

  async toggleActive(id: number, isActive: boolean): Promise<void> {
    try {
      await firstValueFrom(this.api.updateAdmin(id, {isActive}));
      this.toast.info('Admin Status Updated', `Admin account ${isActive ? 'activated' : 'deactivated'}.`);
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not update admin status.';
      this.toast.error('Error', msg);
    }
  }

  async createAdmin(): Promise<void> {
    if (this.createForm.invalid) return;
    this.creating.set(true);
    try {
      await firstValueFrom(
        this.api.createAdmin({
          ...this.createForm.value,
          permissions: this.selectedCreatePerms(),
        }),
      );
      this.createForm.reset({
        department: 'Verification Operations',
        designation: 'Verification Officer',
      });
      this.toast.success('Admin Created', 'New delegated Admin account provisioned.');
      await this.load();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not create admin.';
      this.toast.error('Error', msg);
    } finally {
      this.creating.set(false);
    }
  }
}
