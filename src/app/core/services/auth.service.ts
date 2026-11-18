import {Injectable, PLATFORM_ID, computed, inject, signal} from '@angular/core';
import {isPlatformBrowser} from '@angular/common';
import {HttpClient} from '@angular/common/http';
import {Router} from '@angular/router';
import {firstValueFrom} from 'rxjs';
import {AuthUser} from '../models/types';

const ACCESS_KEY = 'sqr_access_token';
const REFRESH_KEY = 'sqr_refresh_token';
const USER_KEY = 'sqr_user';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

@Injectable({providedIn: 'root'})
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly platformId = inject(PLATFORM_ID);

  private readonly _user = signal<AuthUser | null>(null);
  private readonly _accessToken = signal<string | null>(null);
  private readonly _initialized = signal<boolean>(false);

  readonly user = this._user.asReadonly();
  readonly accessToken = this._accessToken.asReadonly();
  readonly initialized = this._initialized.asReadonly();

  readonly isAuthenticated = computed(() => Boolean(this._accessToken() && this._user()));
  readonly isAdmin = computed(
    () => this._user()?.role === 'ADMIN' || this._user()?.role === 'SUPER_ADMIN',
  );
  readonly isSuperAdmin = computed(() => this._user()?.role === 'SUPER_ADMIN');
  readonly isUser = computed(() => this._user()?.role === 'USER');

  constructor() {
    this.restoreFromStorage();
  }

  private restoreFromStorage(): void {
    if (!isPlatformBrowser(this.platformId)) {
      this._initialized.set(true);
      return;
    }
    try {
      const token = localStorage.getItem(ACCESS_KEY);
      const rawUser = localStorage.getItem(USER_KEY);
      if (token && rawUser) {
        this._accessToken.set(token);
        this._user.set(JSON.parse(rawUser) as AuthUser);
      }
    } catch {
      this.clearSession();
    }
    this._initialized.set(true);
  }

  hasPermission(permission: string): boolean {
    const u = this._user();
    if (!u) return false;
    if (u.role === 'SUPER_ADMIN') return true;
    return u.role === 'ADMIN' && u.permissions.includes(permission);
  }

  async loginUser(identifier: string, password: string): Promise<AuthUser> {
    const res = await firstValueFrom(
      this.http.post<LoginResponse>('/api/v1/auth/login', {identifier, password}),
    );
    this.saveSession(res);
    return res.user;
  }

  async loginAdmin(identifier: string, password: string): Promise<AuthUser> {
    const res = await firstValueFrom(
      this.http.post<LoginResponse>('/api/v1/auth/admin/login', {identifier, password}),
    );
    this.saveSession(res);
    return res.user;
  }

  async refreshAccessToken(): Promise<string | null> {
    if (!isPlatformBrowser(this.platformId)) return null;
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!refreshToken) return null;
    try {
      const res = await firstValueFrom(
        this.http.post<{accessToken: string}>('/api/v1/auth/refresh', {refreshToken}),
      );
      this._accessToken.set(res.accessToken);
      localStorage.setItem(ACCESS_KEY, res.accessToken);
      return res.accessToken;
    } catch {
      this.clearSession();
      return null;
    }
  }

  async refreshProfile(): Promise<void> {
    try {
      const me = await firstValueFrom(this.http.get<AuthUser>('/api/v1/auth/me'));
      this._user.set(me);
      if (isPlatformBrowser(this.platformId)) {
        localStorage.setItem(USER_KEY, JSON.stringify(me));
      }
    } catch {
      // Ignore transient errors
    }
  }

  async logout(redirectTo = '/login'): Promise<void> {
    if (isPlatformBrowser(this.platformId)) {
      const refreshToken = localStorage.getItem(REFRESH_KEY);
      if (this._accessToken() && refreshToken) {
        try {
          await firstValueFrom(
            this.http.post('/api/v1/auth/logout', {refreshToken}),
          );
        } catch {
          // Proceed with local clear
        }
      }
    }
    this.clearSession();
    void this.router.navigateByUrl(redirectTo);
  }

  private saveSession(res: LoginResponse): void {
    this._accessToken.set(res.accessToken);
    this._user.set(res.user);
    if (isPlatformBrowser(this.platformId)) {
      localStorage.setItem(ACCESS_KEY, res.accessToken);
      localStorage.setItem(REFRESH_KEY, res.refreshToken);
      localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    }
  }

  clearSession(): void {
    this._accessToken.set(null);
    this._user.set(null);
    if (isPlatformBrowser(this.platformId)) {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
    }
  }
}
