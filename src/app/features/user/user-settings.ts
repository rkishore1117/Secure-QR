import {ChangeDetectionStrategy, Component, inject, signal} from '@angular/core';
import {FormBuilder, ReactiveFormsModule, Validators} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {AuthService} from '../../core/services/auth.service';
import {ToastService} from '../../core/services/toast.service';

@Component({
  selector: 'app-user-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="max-w-xl space-y-6">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">Account Settings</h1>
        <p class="mt-1 text-sm text-slate-600">Manage your credential portal password and account preferences.</p>
      </div>

      <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <h2 class="text-base font-bold text-[#0F172A] font-display">Change Password</h2>
        <form [formGroup]="form" (ngSubmit)="submit()" class="space-y-4">
          <div>
            <label for="cur-pw" class="block text-xs font-semibold text-slate-700 mb-1.5">Current Password</label>
            <div class="relative">
              <input
                id="cur-pw"
                [type]="showCurrentPassword() ? 'text' : 'password'"
                formControlName="currentPassword"
                class="w-full h-11 rounded-lg border border-slate-300 pl-3.5 pr-11 text-sm focus:border-[#0F172A] focus:outline-none"
              />
              <button
                type="button"
                (click)="showCurrentPassword.set(!showCurrentPassword())"
                [attr.aria-label]="showCurrentPassword() ? 'Hide current password' : 'Show current password'"
                class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-500 hover:text-slate-800"
              >
                <mat-icon class="text-[20px]!">{{ showCurrentPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
              </button>
            </div>
          </div>
          <div>
            <label for="new-pw" class="block text-xs font-semibold text-slate-700 mb-1.5">New Password (min 8 chars)</label>
            <div class="relative">
              <input
                id="new-pw"
                [type]="showNewPassword() ? 'text' : 'password'"
                formControlName="newPassword"
                class="w-full h-11 rounded-lg border border-slate-300 pl-3.5 pr-11 text-sm focus:border-[#0F172A] focus:outline-none"
              />
              <button
                type="button"
                (click)="showNewPassword.set(!showNewPassword())"
                [attr.aria-label]="showNewPassword() ? 'Hide new password' : 'Show new password'"
                class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-500 hover:text-slate-800"
              >
                <mat-icon class="text-[20px]!">{{ showNewPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
              </button>
            </div>
          </div>
          <button
            type="submit"
            [disabled]="saving()"
            class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
          >
            <mat-icon class="text-[18px]!">lock</mat-icon>
            <span>{{ saving() ? 'Updating...' : 'Update Password' }}</span>
          </button>
        </form>
      </section>

      <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-bold text-slate-900">Sign Out</p>
          <p class="text-xs text-slate-500">Revoke this session refresh token on this device.</p>
        </div>
        <button
          type="button"
          (click)="auth.logout('/login')"
          class="touch-target inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
        >
          <mat-icon class="text-[18px]!">logout</mat-icon>
          <span>Logout</span>
        </button>
      </section>
    </div>
  `,
})
export class UserSettings {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly saving = signal(false);
  protected readonly showCurrentPassword = signal(false);
  protected readonly showNewPassword = signal(false);
  protected readonly form = this.fb.group({
    currentPassword: ['', Validators.required],
    newPassword: ['', [Validators.required, Validators.minLength(8)]],
  });

  async submit(): Promise<void> {
    if (this.form.invalid) return;
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.api.changePassword(
          String(this.form.value.currentPassword),
          String(this.form.value.newPassword),
        ),
      );
      this.form.reset();
      this.toast.success('Password Updated', 'Your password has been changed.');
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not update password.';
      this.toast.error('Error', msg);
    } finally {
      this.saving.set(false);
    }
  }
}
