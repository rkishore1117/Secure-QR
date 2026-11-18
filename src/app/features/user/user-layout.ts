import {ChangeDetectionStrategy, Component, inject, signal} from '@angular/core';
import {RouterLink, RouterLinkActive, RouterOutlet} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {AuthService} from '../../core/services/auth.service';
import {NotificationService} from '../../core/services/notification.service';

@Component({
  selector: 'app-user-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule],
  template: `
    <div class="min-h-screen bg-slate-50 flex">
      <!-- Desktop Sidebar -->
      <aside class="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-[#0F172A] text-white">
        <div class="flex h-16 items-center gap-3 border-b border-white/10 px-5">
          <img
            src="/assets/images/brand_shield_emblem_1794911274112.jpg"
            alt="Secure QR"
            class="h-8 w-8 rounded-lg object-cover"
            referrerpolicy="no-referrer"
          />
          <span class="font-display text-sm font-bold tracking-tight whitespace-nowrap">
            Member Portal
          </span>
        </div>

        <nav class="flex-1 space-y-1 px-3 py-4 overflow-y-auto" aria-label="User sidebar navigation">
          @for (item of navItems; track item.path) {
            <a
              [routerLink]="item.path"
              routerLinkActive="bg-white/12 text-white"
              class="touch-target flex items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/8 hover:text-white transition-colors"
            >
              <span class="flex items-center gap-3 min-w-0">
                <mat-icon class="text-[20px]! shrink-0">{{ item.icon }}</mat-icon>
                <span class="truncate">{{ item.label }}</span>
              </span>
              @if (item.path === '/user/notifications' && notif.unreadCount() > 0) {
                <span class="font-mono text-xs font-semibold text-amber-300 tabular-nums">
                  {{ notif.unreadCount() }}
                </span>
              }
            </a>
          }
        </nav>

        <div class="border-t border-white/10 p-3">
          <button
            type="button"
            (click)="auth.logout('/login')"
            class="touch-target flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white"
          >
            <mat-icon class="text-[20px]!">logout</mat-icon>
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <!-- Mobile Drawer Overlay -->
      @if (drawerOpen()) {
        <div class="fixed inset-0 z-40 lg:hidden flex">
          <button
            type="button"
            (click)="drawerOpen.set(false)"
            class="fixed inset-0 bg-slate-900/50"
            aria-label="Close menu"
          ></button>
          <aside class="relative z-50 flex w-72 max-w-[82vw] flex-col bg-[#0F172A] text-white h-full">
            <div class="flex h-16 items-center justify-between border-b border-white/10 px-4">
              <div class="flex items-center gap-2.5">
                <img
                  src="/assets/images/brand_shield_emblem_1794911274112.jpg"
                  alt="Secure QR"
                  class="h-8 w-8 rounded-lg object-cover"
                  referrerpolicy="no-referrer"
                />
                <span class="font-display text-sm font-bold">Member Portal</span>
              </div>
              <button
                type="button"
                (click)="drawerOpen.set(false)"
                class="touch-target flex items-center justify-center rounded-lg text-slate-300 hover:bg-white/10"
                aria-label="Close navigation drawer"
              >
                <mat-icon>close</mat-icon>
              </button>
            </div>
            <nav class="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
              @for (item of navItems; track item.path) {
                <a
                  [routerLink]="item.path"
                  (click)="drawerOpen.set(false)"
                  routerLinkActive="bg-white/12 text-white"
                  class="touch-target flex items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/8"
                >
                  <span class="flex items-center gap-3">
                    <mat-icon class="text-[20px]!">{{ item.icon }}</mat-icon>
                    <span>{{ item.label }}</span>
                  </span>
                  @if (item.path === '/user/notifications' && notif.unreadCount() > 0) {
                    <span class="font-mono text-xs font-semibold text-amber-300 tabular-nums">
                      {{ notif.unreadCount() }}
                    </span>
                  }
                </a>
              }
            </nav>
            <div class="border-t border-white/10 p-3">
              <button
                type="button"
                (click)="auth.logout('/login')"
                class="touch-target flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/10"
              >
                <mat-icon class="text-[20px]!">logout</mat-icon>
                <span>Logout</span>
              </button>
            </div>
          </aside>
        </div>
      }

      <!-- Main Column -->
      <div class="flex flex-1 flex-col min-w-0 lg:pl-64">
        <header class="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-8">
          <div class="flex items-center gap-3 min-w-0">
            <button
              type="button"
              (click)="drawerOpen.set(true)"
              class="lg:hidden touch-target -ml-2 flex items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100"
              aria-label="Open navigation menu"
            >
              <mat-icon>menu</mat-icon>
            </button>
            <div class="min-w-0">
              <p class="truncate text-sm font-bold text-[#0F172A] font-display">
                {{ auth.user()?.displayName || 'Member' }}
              </p>
              <p class="truncate font-mono text-[11px] text-slate-500 tabular-nums">
                {{ auth.user()?.registrationId || auth.user()?.email }}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <a
              routerLink="/user/notifications"
              class="touch-target relative flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-slate-700 hover:bg-slate-50"
              aria-label="View notifications"
            >
              <mat-icon class="text-[20px]!">notifications</mat-icon>
              @if (notif.unreadCount() > 0) {
                <span class="ml-1.5 font-mono text-xs font-bold text-amber-700 tabular-nums">
                  {{ notif.unreadCount() }}
                </span>
              }
            </a>
          </div>
        </header>

        <main class="flex-1 mx-auto w-full max-w-[1280px] p-4 sm:p-6 lg:p-8">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
})
export class UserLayout {
  protected readonly auth = inject(AuthService);
  protected readonly notif = inject(NotificationService);
  protected readonly drawerOpen = signal(false);

  protected readonly navItems = [
    {path: '/user/home', label: 'Home & Status', icon: 'home'},
    {path: '/user/profile', label: 'My Profile & Registration', icon: 'person'},
    {path: '/user/qr-card', label: 'My QR Code & ID Card', icon: 'qr_code_2'},
    {path: '/user/notifications', label: 'Notifications', icon: 'notifications'},
    {path: '/user/settings', label: 'Settings', icon: 'settings'},
  ];
}
