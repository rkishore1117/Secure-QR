import {ChangeDetectionStrategy, Component, OnInit, inject, input, signal} from '@angular/core';
import {FormBuilder, ReactiveFormsModule, Validators} from '@angular/forms';
import {ActivatedRoute, Router, RouterLink} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {AuthService} from '../../core/services/auth.service';
import {ToastService} from '../../core/services/toast.service';

@Component({
  selector: 'app-login',
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
          <a routerLink="/register" class="text-xs sm:text-sm font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap">
            New Member? Register
          </a>
        </div>
      </header>

      <main class="flex-1 flex items-center justify-center px-4 py-10">
        <div class="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm">
          <!-- Portal Segmented Switch -->
          <div class="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 mb-6">
            <button
              type="button"
              (click)="switchMode('USER')"
              class="touch-target rounded-md px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap"
              [class.bg-white]="portalMode() === 'USER'"
              [class.text-[#0F172A]]="portalMode() === 'USER'"
              [class.shadow-sm]="portalMode() === 'USER'"
              [class.text-slate-600]="portalMode() !== 'USER'"
            >
              User Portal
            </button>
            <button
              type="button"
              (click)="switchMode('ADMIN')"
              class="touch-target rounded-md px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap"
              [class.bg-white]="portalMode() === 'ADMIN'"
              [class.text-[#0F172A]]="portalMode() === 'ADMIN'"
              [class.shadow-sm]="portalMode() === 'ADMIN'"
              [class.text-slate-600]="portalMode() !== 'ADMIN'"
            >
              Admin Portal
            </button>
          </div>

          <h1 class="text-xl font-bold text-[#0F172A] font-display">
            {{ portalMode() === 'ADMIN' ? 'Administrator Sign In' : 'Member Portal Sign In' }}
          </h1>
          <p class="mt-1 text-xs text-slate-600">
            {{
              portalMode() === 'ADMIN'
                ? 'Authorized staff and Super Admin authentication.'
                : 'Access your registration status, QR credential, and digital ID card.'
            }}
          </p>

          <form [formGroup]="form" (ngSubmit)="submit()" class="mt-6 space-y-4">
            <div>
              <label for="login-id" class="block text-xs font-semibold text-slate-700 mb-1.5">
                Email or Mobile Number
              </label>
              <input
                id="login-id"
                type="text"
                formControlName="identifier"
                autocomplete="username"
                placeholder="name@organization.org"
                class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
              />
            </div>

            <div>
              <label for="login-pass" class="block text-xs font-semibold text-slate-700 mb-1.5">
                Password
              </label>
              <input
                id="login-pass"
                type="password"
                formControlName="password"
                autocomplete="current-password"
                placeholder="Enter your password"
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
              [disabled]="loading()"
              class="touch-target w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
            >
              <mat-icon class="text-[20px]!">lock_open</mat-icon>
              <span>{{ loading() ? 'Signing In...' : 'Sign In' }}</span>
            </button>
          </form>
        </div>
      </main>
    </div>
  `,
})
export class Login implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);

  readonly mode = input<'USER' | 'ADMIN'>('USER');
  protected readonly portalMode = signal<'USER' | 'ADMIN'>('USER');
  protected readonly loading = signal(false);
  protected readonly errorMsg = signal<string | null>(null);

  protected readonly form = this.fb.group({
    identifier: ['', Validators.required],
    password: ['', Validators.required],
  });

  ngOnInit(): void {
    const routeMode = this.route.snapshot.data['portalMode'] as 'USER' | 'ADMIN' | undefined;
    this.portalMode.set(routeMode || this.mode());
  }

  switchMode(mode: 'USER' | 'ADMIN'): void {
    this.portalMode.set(mode);
    this.errorMsg.set(null);
  }

  async submit(): Promise<void> {
    this.errorMsg.set(null);
    if (this.form.invalid) {
      this.errorMsg.set('Enter both email/mobile and password.');
      return;
    }
    const {identifier, password} = this.form.value;
    this.loading.set(true);
    try {
      if (this.portalMode() === 'ADMIN') {
        const user = await this.auth.loginAdmin(String(identifier), String(password));
        this.toast.success('Welcome Back', `Signed in as ${user.displayName}`);
        const returnUrl = this.route.snapshot.queryParams['returnUrl'];
        void this.router.navigateByUrl(returnUrl || '/admin/dashboard');
      } else {
        const user = await this.auth.loginUser(String(identifier), String(password));
        this.toast.success('Signed In', `Welcome, ${user.displayName}`);
        void this.router.navigateByUrl('/user/home');
      }
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Authentication failed.';
      this.errorMsg.set(msg);
    } finally {
      this.loading.set(false);
    }
  }
}
