import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {FormBuilder, ReactiveFormsModule, Validators} from '@angular/forms';
import {ActivatedRoute, RouterLink} from '@angular/router';
import {DatePipe} from '@angular/common';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {StatusText} from '../../shared/components/status-text';

@Component({
  selector: 'app-verify-public',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, DatePipe, MatIconModule, StatusText],
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
            routerLink="/admin/login"
            class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] whitespace-nowrap"
          >
            <mat-icon class="text-[18px]!">qr_code_scanner</mat-icon>
            <span>Admin Scanner Sign In</span>
          </a>
        </div>
      </header>

      <main class="flex-1 mx-auto w-full max-w-xl px-4 py-10">
        <div class="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm">
          <h1 class="text-xl font-bold text-[#0F172A] font-display">Check Pass Validity</h1>
          <p class="mt-1.5 text-xs leading-relaxed text-slate-600">
            Verify whether a QR pass is active without exposing personal member details publicly. Team administrators can sign in to view the member's photo during check-in.
          </p>

          <form [formGroup]="form" (ngSubmit)="checkToken()" class="mt-5 flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              formControlName="token"
              placeholder="Paste QR verification URL or token"
              aria-label="Verification token"
              class="flex-1 h-11 rounded-lg border border-slate-300 px-3.5 font-mono text-xs text-slate-900 focus:border-[#0F172A] focus:outline-none"
            />
            <button
              type="submit"
              [disabled]="loading()"
              class="touch-target inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] whitespace-nowrap"
            >
              <mat-icon class="text-[18px]!">verified_user</mat-icon>
              <span>{{ loading() ? 'Checking...' : 'Check Status' }}</span>
            </button>
          </form>

          @if (result(); as res) {
            <div class="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
              <app-status-text [status]="res.status" />
              <p class="mt-2 text-sm text-slate-700">{{ res.message }}</p>
              @if (res.expiresAt) {
                <p class="mt-2 font-mono text-xs text-slate-500 tabular-nums">
                  Valid Until: {{ res.expiresAt | date: 'mediumDate' }}
                </p>
              }
            </div>
          }
        </div>
      </main>
    </div>
  `,
})
export class VerifyPublic implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  protected readonly loading = signal(false);
  protected readonly result = signal<{
    status: string;
    message: string;
    issuedAt?: string;
    expiresAt?: string;
  } | null>(null);

  protected readonly form = this.fb.group({
    token: ['', Validators.required],
  });

  ngOnInit(): void {
    const token = this.route.snapshot.queryParams['token'];
    if (token) {
      this.form.patchValue({token});
      void this.checkToken();
    }
  }

  async checkToken(): Promise<void> {
    const token = (this.form.value.token || '').trim();
    if (!token) return;
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.getPublicVerifyInfo(token));
      this.result.set(res);
    } catch {
      this.result.set({
        status: 'INVALID',
        message: 'Unable to verify token.',
      });
    } finally {
      this.loading.set(false);
    }
  }
}
