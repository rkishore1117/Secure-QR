import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {FormBuilder, ReactiveFormsModule, Validators} from '@angular/forms';
import {ActivatedRoute, RouterLink} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {ToastService} from '../../core/services/toast.service';

@Component({
  selector: 'app-forgot-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MatIconModule],
  template: `
    <div class="min-h-screen bg-slate-50 flex flex-col">
      <header class="border-b border-slate-200 bg-white">
        <div class="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
          <a routerLink="/" class="flex items-center gap-2.5 text-base font-bold text-[#0F172A] font-display whitespace-nowrap">
            <img
              src="/assets/images/brand_shield_emblem_1794911274112.jpg"
              alt="Secure QR"
              class="h-8 w-8 rounded-lg object-cover"
              referrerpolicy="no-referrer"
            />
            <span>Secure QR</span>
          </a>
          <a
            [routerLink]="portalMode() === 'ADMIN' ? '/admin/login' : '/login'"
            class="text-xs sm:text-sm font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
          >
            Back to Sign In
          </a>
        </div>
      </header>

      <main class="flex-1 flex items-center justify-center px-4 py-10">
        <div class="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm">
          @if (resetCompleted()) {
            <div class="text-center space-y-4">
              <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                <mat-icon class="text-[28px]!">task_alt</mat-icon>
              </div>
              <h1 class="text-xl font-bold text-[#0F172A] font-display">Password Updated</h1>
              <p class="text-xs leading-relaxed text-slate-600">
                Your password for <span class="font-mono font-semibold text-slate-900">{{ verifiedEmail() }}</span> has been reset. You can now sign in with your new password.
              </p>
              <a
                [routerLink]="resetRole() === 'ADMIN' || resetRole() === 'SUPER_ADMIN' || portalMode() === 'ADMIN' ? '/admin/login' : '/login'"
                class="touch-target w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1E3A5F]"
              >
                <mat-icon class="text-[18px]!">login</mat-icon>
                <span>Return to Sign In</span>
              </a>
            </div>
          } @else {
            <div>
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-semibold uppercase tracking-wider text-[#1E3A5F]">
                  Account Recovery
                </span>
                <span class="font-mono text-[11px] font-semibold text-slate-500">
                  Step {{ step() }} of 3
                </span>
              </div>
              <h1 class="mt-1 text-xl font-bold text-[#0F172A] font-display">
                Forgot Password
              </h1>
              <p class="mt-1 text-xs text-slate-600">
                Verify your registered email address with a 6-digit code to set a new password for your User or Admin account.
              </p>
            </div>

            <!-- Step 1: Enter Email & Send Code -->
            @if (step() === 1) {
              <form [formGroup]="emailForm" (ngSubmit)="sendResetCode()" class="mt-6 space-y-4">
                <div>
                  <label for="fp-email" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Registered Email Address
                  </label>
                  <input
                    id="fp-email"
                    type="email"
                    formControlName="email"
                    autocomplete="email"
                    placeholder="name@organization.org"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>

                @if (errorMsg()) {
                  <div class="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800">
                    {{ errorMsg() }}
                  </div>
                }

                <button
                  type="submit"
                  [disabled]="sendingOtp()"
                  class="touch-target w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                >
                  <mat-icon class="text-[20px]!">mail</mat-icon>
                  <span>{{ sendingOtp() ? 'Sending Code...' : 'Send Reset Code' }}</span>
                </button>
              </form>
            }

            <!-- Step 2: Verify 6-Digit Email OTP -->
            @if (step() === 2) {
              <form [formGroup]="otpForm" (ngSubmit)="verifyCode()" class="mt-6 space-y-4">
                <div class="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700">
                  @if (emailNotice()) {
                    <p>{{ emailNotice() }}</p>
                  }
                  <p class="mt-1 font-mono text-[11px] text-slate-500">
                    Recipient: {{ verifiedEmail() }}
                  </p>
                </div>

                @if (devOtpHint()) {
                  <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <div>
                      <span class="font-medium">Verification Code: </span>
                      <span class="font-mono text-sm font-bold tracking-wider text-[#0F172A]">{{ devOtpHint() }}</span>
                    </div>
                    <button
                      type="button"
                      (click)="applyDevOtpHint()"
                      class="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
                    >
                      Use Code
                    </button>
                  </div>
                }

                <div>
                  <label for="fp-otp" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    6-Digit Verification Code
                  </label>
                  <input
                    id="fp-otp"
                    type="text"
                    maxlength="6"
                    formControlName="otpCode"
                    placeholder="000000"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 font-mono text-base tracking-widest text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>

                @if (errorMsg()) {
                  <div class="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800">
                    {{ errorMsg() }}
                  </div>
                }

                <button
                  type="submit"
                  [disabled]="verifyingOtp()"
                  class="touch-target w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                >
                  <mat-icon class="text-[20px]!">verified</mat-icon>
                  <span>{{ verifyingOtp() ? 'Verifying Code...' : 'Verify Code' }}</span>
                </button>

                <div class="flex items-center justify-between gap-2 pt-1 text-xs">
                  <button
                    type="button"
                    (click)="backToEmail()"
                    class="font-medium text-slate-600 hover:text-slate-900"
                  >
                    Change Email
                  </button>
                  <button
                    type="button"
                    (click)="resendCode()"
                    [disabled]="sendingOtp() || resendCooldown() > 0"
                    class="font-semibold text-[#1E3A5F] hover:underline disabled:opacity-50"
                  >
                    {{ resendCooldown() > 0 ? 'Resend in ' + resendCooldown() + 's' : 'Resend Code' }}
                  </button>
                </div>
              </form>
            }

            <!-- Step 3: Set New Password -->
            @if (step() === 3) {
              <form [formGroup]="resetForm" (ngSubmit)="submitReset()" class="mt-6 space-y-4">
                <div>
                  <label for="fp-new-pw" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    New Password (min 8 chars)
                  </label>
                  <div class="relative">
                    <input
                      id="fp-new-pw"
                      [type]="showNewPassword() ? 'text' : 'password'"
                      formControlName="newPassword"
                      autocomplete="new-password"
                      placeholder="Enter new password"
                      class="w-full h-11 rounded-lg border border-slate-300 pl-3.5 pr-11 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                    />
                    <button
                      type="button"
                      (click)="showNewPassword.set(!showNewPassword())"
                      [attr.aria-label]="showNewPassword() ? 'Hide password' : 'Show password'"
                      class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-500 hover:text-slate-800"
                    >
                      <mat-icon class="text-[20px]!">{{ showNewPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
                    </button>
                  </div>
                </div>

                <div>
                  <label for="fp-confirm-pw" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Confirm New Password
                  </label>
                  <div class="relative">
                    <input
                      id="fp-confirm-pw"
                      [type]="showConfirmPassword() ? 'text' : 'password'"
                      formControlName="confirmPassword"
                      autocomplete="new-password"
                      placeholder="Re-enter new password"
                      class="w-full h-11 rounded-lg border border-slate-300 pl-3.5 pr-11 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                    />
                    <button
                      type="button"
                      (click)="showConfirmPassword.set(!showConfirmPassword())"
                      [attr.aria-label]="showConfirmPassword() ? 'Hide confirm password' : 'Show confirm password'"
                      class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-500 hover:text-slate-800"
                    >
                      <mat-icon class="text-[20px]!">{{ showConfirmPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
                    </button>
                  </div>
                </div>

                @if (errorMsg()) {
                  <div class="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800">
                    {{ errorMsg() }}
                  </div>
                }

                <button
                  type="submit"
                  [disabled]="resetting()"
                  class="touch-target w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                >
                  <mat-icon class="text-[20px]!">lock_reset</mat-icon>
                  <span>{{ resetting() ? 'Updating Password...' : 'Reset Password' }}</span>
                </button>
              </form>
            }
          }
        </div>
      </main>
    </div>
  `,
})
export class ForgotPassword implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);

  protected readonly portalMode = signal<'USER' | 'ADMIN'>('USER');
  protected readonly step = signal<1 | 2 | 3>(1);
  protected readonly verifiedEmail = signal('');
  protected readonly otpVerificationId = signal<number | null>(null);
  protected readonly devOtpHint = signal<string | null>(null);
  protected readonly emailNotice = signal<string | null>(null);
  protected readonly resendCooldown = signal(0);

  protected readonly sendingOtp = signal(false);
  protected readonly verifyingOtp = signal(false);
  protected readonly resetting = signal(false);
  protected readonly resetCompleted = signal(false);
  protected readonly resetRole = signal<string>('USER');
  protected readonly errorMsg = signal<string | null>(null);

  protected readonly showNewPassword = signal(false);
  protected readonly showConfirmPassword = signal(false);

  protected readonly emailForm = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly otpForm = this.fb.group({
    otpCode: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]],
  });

  protected readonly resetForm = this.fb.group({
    newPassword: ['', [Validators.required, Validators.minLength(8)]],
    confirmPassword: ['', Validators.required],
  });

  ngOnInit(): void {
    const portal = String(this.route.snapshot.queryParams['portal'] || '').toUpperCase();
    if (portal === 'ADMIN') {
      this.portalMode.set('ADMIN');
    }
    const emailParam = String(this.route.snapshot.queryParams['email'] || '').trim();
    if (emailParam) {
      this.emailForm.patchValue({email: emailParam});
    }
  }

  async sendResetCode(): Promise<void> {
    this.errorMsg.set(null);
    if (this.emailForm.invalid) {
      this.errorMsg.set('Enter a valid registered email address.');
      return;
    }
    const email = String(this.emailForm.value.email || '').trim().toLowerCase();
    await this.dispatchOtp(email);
  }

  async resendCode(): Promise<void> {
    this.errorMsg.set(null);
    const email = this.verifiedEmail();
    if (!email) return;
    await this.dispatchOtp(email);
  }

  private async dispatchOtp(email: string): Promise<void> {
    this.sendingOtp.set(true);
    try {
      const res = await firstValueFrom(this.api.sendOtp(email, 'PASSWORD_RESET'));
      this.verifiedEmail.set(email);
      this.step.set(2);
      this.devOtpHint.set(!res.emailDispatched && res.devOtpHint ? res.devOtpHint : null);
      if (res.emailDispatched) {
        this.emailNotice.set(`A 6-digit password reset code was sent to ${email}. Check your inbox or spam folder.`);
        this.toast.success('Reset Code Sent', `Verification code sent to ${email}.`);
      } else if (res.devOtpHint) {
        this.emailNotice.set(`Email delivery unavailable (${res.emailError || 'SMTP unavailable'}). Use the code below to continue.`);
        this.toast.info('Reset Code Ready', 'Use the on-screen 6-digit verification code to continue.');
      } else {
        this.emailNotice.set(`Could not deliver email (${res.emailError || 'SMTP unavailable'}).`);
        this.toast.error('Email Delivery Error', res.emailError || 'SMTP unavailable.');
      }
      this.startCooldown(30);
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not send reset code.';
      this.errorMsg.set(msg);
    } finally {
      this.sendingOtp.set(false);
    }
  }

  applyDevOtpHint(): void {
    const code = this.devOtpHint();
    if (code) {
      this.otpForm.patchValue({otpCode: code});
    }
  }

  backToEmail(): void {
    this.errorMsg.set(null);
    this.step.set(1);
  }

  async verifyCode(): Promise<void> {
    this.errorMsg.set(null);
    if (this.otpForm.invalid) {
      this.errorMsg.set('Enter the 6-digit numeric verification code.');
      return;
    }
    this.verifyingOtp.set(true);
    try {
      const otp = String(this.otpForm.value.otpCode || '').trim();
      const res = await firstValueFrom(
        this.api.verifyOtp(this.verifiedEmail(), otp, 'PASSWORD_RESET'),
      );
      if (res.verified) {
        this.otpVerificationId.set(res.otpVerificationId);
        this.step.set(3);
        this.toast.success('Code Verified', 'Now choose your new password.');
      }
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Code verification failed.';
      this.errorMsg.set(msg);
    } finally {
      this.verifyingOtp.set(false);
    }
  }

  async submitReset(): Promise<void> {
    this.errorMsg.set(null);
    if (this.resetForm.invalid) {
      this.errorMsg.set('Password must be at least 8 characters long.');
      return;
    }
    const newPassword = String(this.resetForm.value.newPassword || '');
    const confirmPassword = String(this.resetForm.value.confirmPassword || '');
    if (newPassword !== confirmPassword) {
      this.errorMsg.set('Passwords do not match.');
      return;
    }
    const otpId = this.otpVerificationId();
    if (!otpId) {
      this.errorMsg.set('Verification session expired. Please request a new code.');
      return;
    }

    this.resetting.set(true);
    try {
      const res = await firstValueFrom(
        this.api.confirmPasswordReset(this.verifiedEmail(), otpId, newPassword),
      );
      this.resetRole.set(res.role || 'USER');
      this.resetCompleted.set(true);
      this.toast.success('Password Reset', 'Your password has been updated.');
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not reset password.';
      this.errorMsg.set(msg);
    } finally {
      this.resetting.set(false);
    }
  }

  private startCooldown(seconds: number): void {
    this.resendCooldown.set(seconds);
    const timer = setInterval(() => {
      const next = this.resendCooldown() - 1;
      this.resendCooldown.set(Math.max(0, next));
      if (next <= 0) clearInterval(timer);
    }, 1000);
  }
}
