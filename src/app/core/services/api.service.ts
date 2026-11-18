import {Injectable, inject} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {
  DashboardStats,
  DynamicFieldConfig,
  NotificationItem,
  QRCodeItem,
  QRVerificationResult,
  UserRecord,
} from '../models/types';

@Injectable({providedIn: 'root'})
export class ApiService {
  private readonly http = inject(HttpClient);

  // Public
  getPublicFieldConfigs() {
    return this.http.get<{
      organizationName: string;
      idProofRequired: boolean;
      fields: DynamicFieldConfig[];
    }>('/api/v1/public/field-configs');
  }

  checkAvailability(email: string, mobile: string) {
    return this.http.post<{emailAvailable: boolean; mobileAvailable: boolean}>(
      '/api/v1/auth/check-availability',
      {email, mobile},
    );
  }

  sendOtp(email: string, purpose = 'REGISTRATION') {
    return this.http.post<{
      otpRequestId: number;
      email: string;
      expiresInSeconds: number;
      message: string;
      emailDispatched?: boolean;
      emailProvider?: string;
      emailError?: string | null;
      devOtpHint?: string;
    }>('/api/v1/auth/otp/send', {email, purpose});
  }

  verifyOtp(email: string, otp: string) {
    return this.http.post<{verified: boolean; otpVerificationId: number; verifiedAt: string}>(
      '/api/v1/auth/otp/verify',
      {email, otp},
    );
  }

  registerUser(payload: Record<string, unknown>) {
    return this.http.post<{
      success: boolean;
      registrationId: string;
      status: string;
      submittedAt: string;
      message: string;
    }>('/api/v1/auth/register', payload);
  }

  getPublicVerifyInfo(token: string) {
    return this.http.get<{
      status: string;
      message: string;
      issuedAt?: string;
      expiresAt?: string;
    }>('/api/v1/public/verify-info', {params: {token}});
  }

  // User Portal
  getUserDashboard() {
    return this.http.get<{
      record: UserRecord;
      activeQr: QRCodeItem | null;
      unreadNotifications: number;
      recentNotifications: NotificationItem[];
      history: {id: number; request_type: string; status: string; notes: string; submitted_at: string; processed_at: string | null}[];
      organizationName: string;
    }>('/api/v1/user/dashboard');
  }

  updateUserProfile(payload: Record<string, unknown>) {
    return this.http.patch<{success: boolean; updatedAt: string}>('/api/v1/user/profile', payload);
  }

  resubmitApplication(payload: Record<string, unknown>) {
    return this.http.post<{success: boolean; status: string}>('/api/v1/user/resubmit', payload);
  }

  downloadUserQrPng(): Observable<Blob> {
    return this.http.get('/api/v1/user/qr/download', {responseType: 'blob'});
  }

  getUserNotifications() {
    return this.http.get<{notifications: NotificationItem[]}>('/api/v1/user/notifications');
  }

  markUserNotificationRead(id: number) {
    return this.http.post<{success: boolean}>(`/api/v1/user/notifications/${id}/read`, {});
  }

  markAllUserNotificationsRead() {
    return this.http.post<{success: boolean}>('/api/v1/user/notifications/read-all', {});
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.http.post<{success: boolean}>('/api/v1/user/change-password', {
      currentPassword,
      newPassword,
    });
  }

  // Admin Portal
  getAdminDashboardStats() {
    return this.http.get<{
      stats: DashboardStats;
      recentRegistrations: UserRecord[];
      recentScans: Record<string, unknown>[];
    }>('/api/v1/admin/dashboard/stats');
  }

  getAdminRegistrations(filters: Record<string, string | number>) {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== '' && v !== undefined && v !== null) {
        params = params.set(k, String(v));
      }
    }
    return this.http.get<{
      items: UserRecord[];
      total: number;
      page: number;
      pageSize: number;
      filters: {states: string[]; cities: string[]};
    }>('/api/v1/admin/registrations', {params});
  }

  getAdminRegistrationDetail(id: number) {
    return this.http.get<{
      record: UserRecord;
      history: Record<string, unknown>[];
      qrs: QRCodeItem[];
    }>(`/api/v1/admin/registrations/${id}`);
  }

  approveRegistration(id: number, note = '') {
    return this.http.post<{success: boolean; status: string; qr: QRCodeItem}>(
      `/api/v1/admin/registrations/${id}/approve`,
      {note},
    );
  }

  rejectRegistration(id: number, reason: string) {
    return this.http.post<{success: boolean; status: string}>(
      `/api/v1/admin/registrations/${id}/reject`,
      {reason},
    );
  }

  requestResubmission(id: number, note: string) {
    return this.http.post<{success: boolean; status: string}>(
      `/api/v1/admin/registrations/${id}/request-resubmission`,
      {note},
    );
  }

  getAdminUsers(search = '') {
    return this.http.get<{users: Record<string, unknown>[]}>('/api/v1/admin/users', {
      params: search ? {search} : {},
    });
  }

  updateUserAccountStatus(accountId: number, isActive: boolean) {
    return this.http.patch<{success: boolean; isActive: boolean}>(
      `/api/v1/admin/users/${accountId}/status`,
      {isActive},
    );
  }

  getAdminQrs() {
    return this.http.get<{qrs: QRCodeItem[]}>('/api/v1/admin/qrs');
  }

  generateQrForUser(userRecordId: number) {
    return this.http.post<{qr: QRCodeItem}>(`/api/v1/admin/qrs/generate/${userRecordId}`, {});
  }

  revokeQr(qrId: number, reason: string) {
    return this.http.post<{success: boolean}>(`/api/v1/admin/qrs/${qrId}/revoke`, {reason});
  }

  regenerateQr(qrId: number) {
    return this.http.post<{qr: QRCodeItem}>(`/api/v1/admin/qrs/${qrId}/regenerate`, {});
  }

  verifyQrPayload(payload: string) {
    return this.http.post<QRVerificationResult>('/api/v1/admin/verify-qr', {payload});
  }

  getAdminScanLogs() {
    return this.http.get<{logs: Record<string, unknown>[]}>('/api/v1/admin/scan-logs');
  }

  getAdminNotifications() {
    return this.http.get<{notifications: NotificationItem[]}>('/api/v1/admin/notifications');
  }

  markAdminNotificationRead(id: number) {
    return this.http.post<{success: boolean}>(`/api/v1/admin/notifications/${id}/read`, {});
  }

  markAllAdminNotificationsRead() {
    return this.http.post<{success: boolean}>('/api/v1/admin/notifications/read-all', {});
  }

  exportExcel(filters: Record<string, string>): Observable<Blob> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) params = params.set(k, v);
    }
    return this.http.get('/api/v1/admin/export/excel', {
      params,
      responseType: 'blob',
    });
  }

  getExportHistory() {
    return this.http.get<{history: Record<string, unknown>[]}>('/api/v1/admin/export/history');
  }

  sendDailyReportNow() {
    return this.http.post<{
      success: boolean;
      recipient: string;
      recordCount: number;
      filename: string;
      sentAt: string;
      error?: string;
    }>('/api/v1/admin/export/send-email-now', {});
  }

  getScheduledReportLogs() {
    return this.http.get<{
      recipientEmail: string;
      scheduleIntervalHours: number;
      smtpConfigured: boolean;
      logs: Record<string, unknown>[];
    }>('/api/v1/admin/export/scheduled-logs');
  }

  getAdmins() {
    return this.http.get<{
      admins: Record<string, unknown>[];
      availablePermissions: {code: string; label: string; description: string}[];
    }>('/api/v1/admin/admins');
  }

  createAdmin(payload: Record<string, unknown>) {
    return this.http.post<{success: boolean; id: number}>('/api/v1/admin/admins', payload);
  }

  updateAdmin(id: number, payload: Record<string, unknown>) {
    return this.http.patch<{success: boolean}>(`/api/v1/admin/admins/${id}`, payload);
  }

  getAuditLogs(action = '', search = '') {
    let params = new HttpParams();
    if (action) params = params.set('action', action);
    if (search) params = params.set('search', search);
    return this.http.get<{logs: Record<string, unknown>[]}>('/api/v1/admin/audit-logs', {params});
  }

  getSystemSettings() {
    return this.http.get<{
      settings: Record<string, string>;
      fieldConfigs: Record<string, unknown>[];
    }>('/api/v1/admin/settings');
  }

  getIntegrationStatus() {
    return this.http.get<{
      database: {
        configured: boolean;
        connected: boolean;
        host: string;
        database: string;
        activeEngine: string;
        error?: string;
      };
      integrations: {
        smtpConfigured: boolean;
        emailOtpConfigured: boolean;
        smtpHost: string;
        smtpUser: string;
        dailyReportRecipient: string;
        s3Configured: boolean;
        s3Bucket: string;
        s3Region: string;
        filePath: string;
        fixedAdminEmail: string;
      };
    }>('/api/v1/admin/settings/db-status');
  }

  initMysqlDatabase() {
    return this.http.post<{
      success: boolean;
      host: string;
      database: string;
      message: string;
      error?: string;
    }>('/api/v1/admin/settings/init-mysql', {});
  }

  updateSystemSettings(settings: Record<string, string>) {
    return this.http.patch<{success: boolean}>('/api/v1/admin/settings', {settings});
  }

  addFieldConfig(payload: Record<string, unknown>) {
    return this.http.post<{id: number}>('/api/v1/admin/field-configs', payload);
  }

  updateFieldConfig(id: number, payload: Record<string, unknown>) {
    return this.http.patch<{success: boolean}>(`/api/v1/admin/field-configs/${id}`, payload);
  }

  deleteFieldConfig(id: number) {
    return this.http.delete<{success: boolean}>(`/api/v1/admin/field-configs/${id}`);
  }
}
