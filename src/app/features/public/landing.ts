import {ChangeDetectionStrategy, Component, inject, signal} from '@angular/core';
import {RouterLink} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {AuthService} from '../../core/services/auth.service';

@Component({
  selector: 'app-landing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatIconModule],
  template: `
    <div class="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <!-- 3-Zone Top Bar Contract -->
      <header class="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div class="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-10">
          <!-- Zone 1: Brand Wordmark -->
          <a
            routerLink="/"
            class="flex items-center gap-2.5 text-base font-bold tracking-tight text-[#0F172A] whitespace-nowrap shrink-0 font-display"
          >
            <img
              src="/assets/images/brand_shield_emblem_1794911274112.jpg"
              alt="Secure QR Emblem"
              class="h-8 w-8 rounded-lg object-cover"
              referrerpolicy="no-referrer"
            />
            <span>Secure QR</span>
          </a>

          <!-- Zone 2: Concise Single-Line Nav Links -->
          <nav class="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600" aria-label="Primary navigation">
            <a routerLink="/register" class="hover:text-[#0F172A] transition-colors whitespace-nowrap shrink-0">
              Self Registration
            </a>
            <a routerLink="/login" class="hover:text-[#0F172A] transition-colors whitespace-nowrap shrink-0">
              User Portal
            </a>
            <a routerLink="/admin/login" class="hover:text-[#0F172A] transition-colors whitespace-nowrap shrink-0">
              Admin Portal
            </a>
            <a routerLink="/verify" class="hover:text-[#0F172A] transition-colors whitespace-nowrap shrink-0">
              Verify Token
            </a>
          </nav>

          <!-- Zone 3: Primary CTA + Mobile Hamburger -->
          <div class="flex items-center gap-2 shrink-0">
            @if (auth.isAuthenticated()) {
              <a
                [routerLink]="auth.isAdmin() ? '/admin/dashboard' : '/user/home'"
                class="hidden sm:inline-flex touch-target items-center gap-2 rounded-lg bg-[#0F172A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] transition-colors whitespace-nowrap shrink-0"
              >
                <mat-icon class="text-[18px]!">dashboard</mat-icon>
                <span>Open Dashboard</span>
              </a>
            } @else {
              <a
                routerLink="/register"
                class="hidden sm:inline-flex touch-target items-center gap-2 rounded-lg bg-[#0F172A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] transition-colors whitespace-nowrap shrink-0"
              >
                <mat-icon class="text-[18px]!">person_add</mat-icon>
                <span>Register Now</span>
              </a>
            }

            <button
              type="button"
              (click)="mobileMenuOpen.set(!mobileMenuOpen())"
              class="md:hidden touch-target flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
              aria-label="Toggle navigation menu"
            >
              <mat-icon>{{ mobileMenuOpen() ? 'close' : 'menu' }}</mat-icon>
            </button>
          </div>
        </div>

        <!-- Mobile Drawer -->
        @if (mobileMenuOpen()) {
          <div class="border-t border-slate-200 bg-white px-4 py-3 md:hidden">
            <nav class="flex flex-col gap-1" aria-label="Mobile navigation">
              <a
                routerLink="/register"
                (click)="mobileMenuOpen.set(false)"
                class="touch-target flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                <mat-icon class="text-[20px]! text-slate-500">person_add</mat-icon>
                <span>Self Registration</span>
              </a>
              <a
                routerLink="/login"
                (click)="mobileMenuOpen.set(false)"
                class="touch-target flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                <mat-icon class="text-[20px]! text-slate-500">badge</mat-icon>
                <span>User Portal Sign In</span>
              </a>
              <a
                routerLink="/admin/login"
                (click)="mobileMenuOpen.set(false)"
                class="touch-target flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                <mat-icon class="text-[20px]! text-slate-500">admin_panel_settings</mat-icon>
                <span>Admin Portal Sign In</span>
              </a>
              <a
                routerLink="/verify"
                (click)="mobileMenuOpen.set(false)"
                class="touch-target flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                <mat-icon class="text-[20px]! text-slate-500">qr_code_scanner</mat-icon>
                <span>Verify Token</span>
              </a>
            </nav>
          </div>
        }
      </header>

      <!-- Main Hero Section -->
      <main class="flex-1">
        <section class="mx-auto max-w-[1440px] px-4 py-10 sm:px-6 lg:px-10 lg:py-16">
          <div class="grid grid-cols-1 items-stretch gap-8 lg:grid-cols-12 lg:gap-12">
            <!-- Left Editorial Column -->
            <div class="flex flex-col justify-center lg:col-span-6">
              <p class="text-xs font-semibold tracking-wide text-[#1E3A5F] mb-3">
                Trusted Member Verification · Digital QR Passes
              </p>
              <h1 class="fluid-hero-title font-bold text-[#0F172A] text-balance font-display">
                Simple, Secure Member Verification &amp; Digital QR Passes
              </h1>
              <p class="mt-4 max-w-xl text-base leading-relaxed text-slate-600">
                Sign up in minutes with email OTP verification, track your approval in real time, carry a personalized QR ID card, and let team administrators verify members effortlessly at check-in.
              </p>

              <div class="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <a
                  routerLink="/register"
                  class="touch-target inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-5 py-3 text-sm font-semibold text-white hover:bg-[#1E3A5F] transition-colors whitespace-nowrap"
                >
                  <mat-icon class="text-[20px]!">how_to_reg</mat-icon>
                  <span>Join as a Member</span>
                </a>
                <a
                  routerLink="/login"
                  class="touch-target inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-100 transition-colors whitespace-nowrap"
                >
                  <mat-icon class="text-[20px]!">login</mat-icon>
                  <span>Member Sign In</span>
                </a>
                <a
                  routerLink="/admin/login"
                  class="touch-target inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-100 transition-colors whitespace-nowrap"
                >
                  <mat-icon class="text-[20px]!">verified_user</mat-icon>
                  <span>Admin Sign In</span>
                </a>
              </div>
            </div>

            <!-- Right Visual Column -->
            <div class="lg:col-span-6">
              <div class="relative h-64 overflow-hidden rounded-xl border border-slate-200 bg-[#0F172A] sm:h-80 lg:h-full lg:min-h-[380px]">
                <img
                  src="/assets/images/portal_hero_architecture_1794911275923.jpg"
                  alt="Member Welcome Desk"
                  class="h-full w-full object-cover"
                  referrerpolicy="no-referrer"
                />
                <div class="absolute inset-0 bg-gradient-to-t from-[#0F172A]/85 via-[#0F172A]/25 to-transparent"></div>
                <div class="absolute bottom-0 left-0 right-0 p-5 sm:p-6 text-white">
                  <p class="text-xs font-medium text-slate-200">Privacy-First Digital Passes</p>
                  <p class="mt-1 text-sm sm:text-base font-semibold font-display">
                    Your personal details stay private · Quick photo verification at check-in
                  </p>
                </div>
              </div>
            </div>
          </div>

          <!-- 4-Column Lifecycle Strip -->
          <div class="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div class="rounded-xl border border-slate-200 bg-white p-5">
              <div class="flex items-center gap-2.5 text-[#0F172A]">
                <mat-icon class="text-[22px]!">mark_email_read</mat-icon>
                <h2 class="text-sm font-bold font-display">01. Quick Email Verification</h2>
              </div>
              <p class="mt-2 text-xs leading-relaxed text-slate-600">
                Verify your email with a one-time code, add your contact details, and upload your photo and ID document.
              </p>
            </div>

            <div class="rounded-xl border border-slate-200 bg-white p-5">
              <div class="flex items-center gap-2.5 text-[#0F172A]">
                <mat-icon class="text-[22px]!">fact_check</mat-icon>
                <h2 class="text-sm font-bold font-display">02. Careful Team Review</h2>
              </div>
              <p class="mt-2 text-xs leading-relaxed text-slate-600">
                Administrators review your documents and either approve your pass right away or let you know what to update.
              </p>
            </div>

            <div class="rounded-xl border border-slate-200 bg-white p-5">
              <div class="flex items-center gap-2.5 text-[#0F172A]">
                <mat-icon class="text-[22px]!">qr_code_2</mat-icon>
                <h2 class="text-sm font-bold font-display">03. Personal QR ID Card</h2>
              </div>
              <p class="mt-2 text-xs leading-relaxed text-slate-600">
                Once approved, download your crisp QR pass or print your official membership card straight from your portal.
              </p>
            </div>

            <div class="rounded-xl border border-slate-200 bg-white p-5">
              <div class="flex items-center gap-2.5 text-[#0F172A]">
                <mat-icon class="text-[22px]!">table_view</mat-icon>
                <h2 class="text-sm font-bold font-display">04. Instant Scan &amp; Daily Reports</h2>
              </div>
              <p class="mt-2 text-xs leading-relaxed text-slate-600">
                Staff scan passes live using any camera, and a verified member Excel report is emailed every 24 hours.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer class="border-t border-slate-200 bg-white py-5">
        <div class="mx-auto flex max-w-[1440px] flex-col items-start justify-between gap-3 px-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:px-6 lg:px-10">
          <span>Secure QR Verification System · Trusted Member Portal</span>
          <div class="flex items-center gap-4">
            <a routerLink="/register" class="hover:text-slate-900">Register</a>
            <a routerLink="/login" class="hover:text-slate-900">User Sign In</a>
            <a routerLink="/admin/login" class="hover:text-slate-900">Admin Sign In</a>
          </div>
        </div>
      </footer>
    </div>
  `,
})
export class Landing {
  protected readonly auth = inject(AuthService);
  protected readonly mobileMenuOpen = signal(false);
}
