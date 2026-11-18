import {ChangeDetectionStrategy, Component, computed, inject, signal} from '@angular/core';
import {RouterLink, RouterLinkActive, RouterOutlet} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {AuthService} from '../../core/services/auth.service';
import {NotificationService} from '../../core/services/notification.service';

interface AdminNavItem {
  path: string;
  queryParams?: Record<string, string>;
  label: string;
  icon: string;
  permission?: string;
  superAdminOnly?: boolean;
}

@Component({
  selector: 'app-admin-layout',
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
          <div class="min-w-0">
            <p class="font-display text-sm font-bold tracking-tight truncate">Secure QR Admin</p>
            <p class="text-[11px] text-slate-400 truncate">{{ auth.user()?.role }}</p>
          </div>
        </div>

        <nav class="flex-1 space-y-0.5 px-3 py-3 overflow-y-auto" aria-label="Admin sidebar navigation">
          @for (item of visibleNavItems(); track item.label) {
            <a
              [routerLink]="item.path"
              [queryParams]="item.queryParams || null"
              routerLinkActive="bg-white/12 text-white"
              [routerLinkActiveOptions]="{exact: !item.queryParams}"
              class="touch-target flex items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-slate-300 hover:bg-white/8 hover:text-white transition-colors"
            >
              <span class="flex items-center gap-2.5 min-w-0">
                <mat-icon class="text-[19px]! shrink-0">{{ item.icon }}</mat-icon>
                <span class="truncate">{{ item.label }}</span>
              </span>
              @if (item.path === '/admin/notifications' && notif.unreadCount() > 0) {
                <span class="font-mono text-xs font-bold text-amber-300 tabular-nums">
                  {{ notif.unreadCount() }}
                </span>
              }
            </a>
          }
        </nav>

        <div class="border-t border-white/10 p-3">
          <button
            type="button"
            (click)="auth.logout('/admin/login')"
            class="touch-target flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-slate-300 hover:bg-white/10 hover:text-white"
          >
            <mat-icon class="text-[19px]!">logout</mat-icon>
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <!-- Mobile Drawer -->
      @if (drawerOpen()) {
        <div class="fixed inset-0 z-40 lg:hidden flex">
          <button
            type="button"
            (click)="drawerOpen.set(false)"
            class="fixed inset-0 bg-slate-900/50"
            aria-label="Close navigation menu"
          ></button>
          <aside class="relative z-50 flex w-72 max-w-[84vw] flex-col bg-[#0F172A] text-white h-full">
            <div class="flex h-16 items-center justify-between border-b border-white/10 px-4">
              <div class="flex items-center gap-2.5">
                <img
                  src="/assets/images/brand_shield_emblem_1794911274112.jpg"
                  alt="Secure QR"
                  class="h-8 w-8 rounded-lg object-cover"
                  referrerpolicy="no-referrer"
                />
                <span class="font-display text-sm font-bold">Secure QR Admin</span>
              </div>
              <button
                type="button"
                (click)="drawerOpen.set(false)"
                class="touch-target flex items-center justify-center rounded-lg text-slate-300 hover:bg-white/10"
                aria-label="Close drawer"
              >
                <mat-icon>close</mat-icon>
              </button>
            </div>
            <nav class="flex-1 space-y-0.5 px-3 py-3 overflow-y-auto">
              @for (item of visibleNavItems(); track item.label) {
                <a
                  [routerLink]="item.path"
                  [queryParams]="item.queryParams || null"
                  (click)="drawerOpen.set(false)"
                  routerLinkActive="bg-white/12 text-white"
                  [routerLinkActiveOptions]="{exact: !item.queryParams}"
                  class="touch-target flex items-center justify-between gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/8"
                >
                  <span class="flex items-center gap-2.5">
                    <mat-icon class="text-[20px]!">{{ item.icon }}</mat-icon>
                    <span>{{ item.label }}</span>
                  </span>
                  @if (item.path === '/admin/notifications' && notif.unreadCount() > 0) {
                    <span class="font-mono text-xs font-bold text-amber-300 tabular-nums">
                      {{ notif.unreadCount() }}
                    </span>
                  }
                </a>
              }
            </nav>
            <div class="border-t border-white/10 p-3">
              <button
                type="button"
                (click)="auth.logout('/admin/login')"
                class="touch-target flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/10"
              >
                <mat-icon class="text-[20px]!">logout</mat-icon>
                <span>Logout</span>
              </button>
            </div>
          </aside>
        </div>
      }

      <!-- Content Area -->
      <div class="flex flex-1 flex-col min-w-0 lg:pl-64">
        <header class="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-8">
          <div class="flex items-center gap-3 min-w-0">
            <button
              type="button"
              (click)="drawerOpen.set(true)"
              class="lg:hidden touch-target -ml-2 flex items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100"
              aria-label="Open admin menu"
            >
              <mat-icon>menu</mat-icon>
            </button>
            <div class="min-w-0">
              <p class="truncate text-sm font-bold text-[#0F172A] font-display">
                {{ auth.user()?.displayName }}
              </p>
              <p class="truncate text-xs text-slate-500">
                {{ auth.user()?.role === 'SUPER_ADMIN' ? 'Super Administrator' : 'Delegated Administrator' }}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            @if (auth.hasPermission('can_scan_qr')) {
              <a
                routerLink="/admin/scanner"
                class="hidden sm:inline-flex touch-target items-center gap-1.5 rounded-lg bg-[#0F172A] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] whitespace-nowrap"
              >
                <mat-icon class="text-[18px]!">qr_code_scanner</mat-icon>
                <span>Scan QR</span>
              </a>
            }
            <a
              routerLink="/admin/notifications"
              class="touch-target flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-slate-700 hover:bg-slate-50"
              aria-label="Admin notifications"
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

        <main class="flex-1 mx-auto w-full max-w-[1440px] p-4 sm:p-6 lg:p-8">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
})
export class AdminLayout {
  protected readonly auth = inject(AuthService);
  protected readonly notif = inject(NotificationService);
  protected readonly drawerOpen = signal(false);

  private readonly allNavItems: AdminNavItem[] = [
    {path: '/admin/dashboard', label: 'Dashboard', icon: 'dashboard'},
    {path: '/admin/registrations', label: 'Registration Requests', icon: 'assignment', permission: 'can_view_registrations'},
    {path: '/admin/registrations', queryParams: {status: 'APPROVED'}, label: 'Approved Users', icon: 'verified', permission: 'can_view_registrations'},
    {path: '/admin/registrations', queryParams: {status: 'REJECTED'}, label: 'Rejected Users', icon: 'block', permission: 'can_view_registrations'},
    {path: '/admin/users', label: 'User Management', icon: 'group', permission: 'can_view_registrations'},
    {path: '/admin/qrs', label: 'QR Management', icon: 'qr_code_2', permission: 'can_manage_qr'},
    {path: '/admin/scanner', label: 'QR Scanner', icon: 'qr_code_scanner', permission: 'can_scan_qr'},
    {path: '/admin/notifications', label: 'Notifications', icon: 'notifications'},
    {path: '/admin/export', label: 'Excel Export', icon: 'table_view', permission: 'can_export_excel'},
    {path: '/admin/admins', label: 'Admin Management', icon: 'admin_panel_settings', superAdminOnly: true},
    {path: '/admin/audit-logs', label: 'Audit Logs', icon: 'history', superAdminOnly: true},
    {path: '/admin/settings', label: 'Settings', icon: 'settings', superAdminOnly: true},
  ];

  protected readonly visibleNavItems = computed(() =>
    this.allNavItems.filter((item) => {
      if (item.superAdminOnly && !this.auth.isSuperAdmin()) return false;
      if (item.permission && !this.auth.hasPermission(item.permission)) return false;
      return true;
    }),
  );
}
