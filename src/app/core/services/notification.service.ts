import {Injectable, PLATFORM_ID, computed, effect, inject, signal} from '@angular/core';
import {isPlatformBrowser} from '@angular/common';
import {firstValueFrom} from 'rxjs';
import {AuthService} from './auth.service';
import {ApiService} from './api.service';
import {ToastService} from './toast.service';
import {NotificationItem} from '../models/types';

@Injectable({providedIn: 'root'})
export class NotificationService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly platformId = inject(PLATFORM_ID);

  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly notifications = signal<NotificationItem[]>([]);
  readonly unreadCount = computed(
    () => this.notifications().filter((n) => !n.is_read).length,
  );
  readonly wsConnected = signal<boolean>(false);

  constructor() {
    effect(() => {
      const authed = this.auth.isAuthenticated();
      const token = this.auth.accessToken();
      if (!isPlatformBrowser(this.platformId)) return;

      if (authed && token) {
        void this.loadNotifications();
        this.connectWebSocket(token);
        this.startPolling();
      } else {
        this.disconnect();
        this.notifications.set([]);
      }
    });
  }

  async loadNotifications(): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    try {
      const res = this.auth.isAdmin()
        ? await firstValueFrom(this.api.getAdminNotifications())
        : await firstValueFrom(this.api.getUserNotifications());
      this.notifications.set(res.notifications);
    } catch {
      // Silent retry on next poll
    }
  }

  async markRead(id: number): Promise<void> {
    try {
      if (this.auth.isAdmin()) {
        await firstValueFrom(this.api.markAdminNotificationRead(id));
      } else {
        await firstValueFrom(this.api.markUserNotificationRead(id));
      }
      this.notifications.update((list) =>
        list.map((n) => (n.id === id ? {...n, is_read: 1} : n)),
      );
    } catch {
      // ignore
    }
  }

  async markAllRead(): Promise<void> {
    try {
      if (this.auth.isAdmin()) {
        await firstValueFrom(this.api.markAllAdminNotificationsRead());
      } else {
        await firstValueFrom(this.api.markAllUserNotificationsRead());
      }
      this.notifications.update((list) => list.map((n) => ({...n, is_read: 1})));
    } catch {
      // ignore
    }
  }

  private connectWebSocket(token: string): void {
    this.disconnectSocketOnly();
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/api/ws/notifications?token=${encodeURIComponent(token)}`;
      const socket = new WebSocket(url);
      this.ws = socket;

      socket.onopen = () => {
        this.wsConnected.set(true);
      };
      socket.onclose = () => {
        this.wsConnected.set(false);
      };
      socket.onerror = () => {
        this.wsConnected.set(false);
      };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data));
          if (data.event === 'notification' && data.notification) {
            const incoming: NotificationItem = {
              id: data.notification.id,
              type: data.notification.type,
              title: data.notification.title,
              message: data.notification.message,
              link_path: data.notification.linkPath || null,
              is_read: 0,
              created_at: data.notification.createdAt,
            };
            this.notifications.update((list) => [
              incoming,
              ...list.filter((n) => n.id !== incoming.id),
            ]);
            this.toast.info(incoming.title, incoming.message);
          }
        } catch {
          // ignore malformed ws payload
        }
      };
    } catch {
      this.wsConnected.set(false);
    }
  }

  private startPolling(): void {
    this.stopPollingOnly();
    this.pollTimer = setInterval(() => {
      void this.loadNotifications();
    }, 20_000);
  }

  private disconnectSocketOnly(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.wsConnected.set(false);
  }

  private stopPollingOnly(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private disconnect(): void {
    this.disconnectSocketOnly();
    this.stopPollingOnly();
  }
}
