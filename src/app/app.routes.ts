import {Routes} from '@angular/router';
import {
  adminAuthGuard,
  permissionGuard,
  superAdminGuard,
  userAuthGuard,
} from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/public/landing').then((m) => m.Landing),
  },
  {
    path: 'register',
    loadComponent: () => import('./features/public/register').then((m) => m.Register),
  },
  {
    path: 'login',
    data: {portalMode: 'USER'},
    loadComponent: () => import('./features/public/login').then((m) => m.Login),
  },
  {
    path: 'admin/login',
    data: {portalMode: 'ADMIN'},
    loadComponent: () => import('./features/public/login').then((m) => m.Login),
  },
  {
    path: 'forgot-password',
    loadComponent: () =>
      import('./features/public/forgot-password').then((m) => m.ForgotPassword),
  },
  {
    path: 'verify',
    loadComponent: () => import('./features/public/verify-public').then((m) => m.VerifyPublic),
  },
  {
    path: 'user',
    canActivate: [userAuthGuard],
    loadComponent: () => import('./features/user/user-layout').then((m) => m.UserLayout),
    children: [
      {path: '', redirectTo: 'home', pathMatch: 'full'},
      {
        path: 'home',
        loadComponent: () => import('./features/user/user-home').then((m) => m.UserHome),
      },
      {
        path: 'profile',
        loadComponent: () => import('./features/user/user-profile').then((m) => m.UserProfile),
      },
      {
        path: 'qr-card',
        loadComponent: () => import('./features/user/user-qr-card').then((m) => m.UserQrCard),
      },
      {
        path: 'notifications',
        loadComponent: () =>
          import('./features/user/user-notifications').then((m) => m.UserNotifications),
      },
      {
        path: 'settings',
        loadComponent: () => import('./features/user/user-settings').then((m) => m.UserSettings),
      },
    ],
  },
  {
    path: 'admin',
    canActivate: [adminAuthGuard],
    loadComponent: () => import('./features/admin/admin-layout').then((m) => m.AdminLayout),
    children: [
      {path: '', redirectTo: 'dashboard', pathMatch: 'full'},
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/admin/admin-dashboard').then((m) => m.AdminDashboard),
      },
      {
        path: 'registrations',
        canActivate: [permissionGuard('can_view_registrations')],
        loadComponent: () =>
          import('./features/admin/admin-registrations').then((m) => m.AdminRegistrations),
      },
      {
        path: 'users',
        canActivate: [permissionGuard('can_view_registrations')],
        loadComponent: () => import('./features/admin/admin-users').then((m) => m.AdminUsers),
      },
      {
        path: 'qrs',
        canActivate: [permissionGuard('can_manage_qr')],
        loadComponent: () => import('./features/admin/admin-qrs').then((m) => m.AdminQrs),
      },
      {
        path: 'scanner',
        canActivate: [permissionGuard('can_scan_qr')],
        loadComponent: () => import('./features/admin/admin-scanner').then((m) => m.AdminScanner),
      },
      {
        path: 'notifications',
        loadComponent: () =>
          import('./features/admin/admin-notifications').then((m) => m.AdminNotifications),
      },
      {
        path: 'export',
        canActivate: [permissionGuard('can_export_excel')],
        loadComponent: () => import('./features/admin/admin-export').then((m) => m.AdminExport),
      },
      {
        path: 'admins',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/admin/admin-management').then((m) => m.AdminManagement),
      },
      {
        path: 'audit-logs',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/admin/admin-audit-logs').then((m) => m.AdminAuditLogs),
      },
      {
        path: 'settings',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/admin/admin-settings').then((m) => m.AdminSettings),
      },
    ],
  },
  {path: '**', redirectTo: ''},
];
