export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'USER';

export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'RESUBMISSION_REQUIRED';

export type QRStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface AuthUser {
  id: number;
  email: string;
  mobile: string;
  role: UserRole;
  permissions: string[];
  displayName: string;
  avatarUrl: string;
  registrationId?: string | null;
  approvalStatus?: ApprovalStatus | null;
  department?: string;
  designation?: string;
}

export interface DynamicFieldConfig {
  id: number;
  fieldKey: string;
  label: string;
  fieldType: 'text' | 'select' | 'date' | 'file';
  isRequired: boolean;
  isEnabled?: boolean;
  isEditableOnResubmit: boolean;
  options: string[];
  sortOrder: number;
}

export interface UserRecord {
  id: number;
  user_id: number;
  registration_id: string;
  full_name: string;
  email: string;
  mobile: string;
  dob: string | null;
  gender: string | null;
  address: string;
  city: string;
  district: string;
  state: string;
  country: string;
  postal_code: string;
  profile_photo_url: string;
  id_proof_type: string;
  id_proof_url: string | null;
  dynamicFields: Record<string, string>;
  consent_accepted: number;
  consent_timestamp: string;
  approval_status: ApprovalStatus;
  rejection_reason: string | null;
  resubmission_note: string | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  is_active: number;
  is_mobile_verified: number;
  is_email_verified?: number;
  latest_qr_status?: QRStatus | null;
  latest_qr_expires_at?: string | null;
}

export interface QRCodeItem {
  id: number;
  user_record_id: number;
  token_prefix: string;
  verification_url: string;
  qr_png_data_url: string;
  status: QRStatus;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  last_verified_at: string | null;
  scan_count: number;
  registration_id?: string;
  full_name?: string;
  city?: string;
  state?: string;
  approval_status?: ApprovalStatus;
  profile_photo_url?: string;
  email?: string;
  is_active?: number;
}

export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  message: string;
  link_path: string | null;
  is_read: number;
  created_at: string;
}

export interface DashboardStats {
  totalUsers: number;
  pendingRegistrations: number;
  approvedUsers: number;
  rejectedUsers: number;
  resubmissionRequests: number;
  activeQrCodes: number;
  expiredQrCodes: number;
  revokedQrCodes: number;
  totalQrScans: number;
  unreadNotifications: number;
}

export interface QRVerificationResult {
  resultStatus: 'VALID' | 'INVALID' | 'EXPIRED' | 'REVOKED' | 'INACTIVE_USER' | 'UNAPPROVED_USER';
  label: string;
  reason: string;
  duplicatePrevented?: boolean;
  scannedAt?: string;
  identityComparisonNotice?: string;
  qr?: {
    id: number;
    tokenPrefix: string;
    issuedAt: string;
    expiresAt: string;
    scanCount: number;
  };
  holder: {
    userRecordId: number;
    registrationId: string;
    fullName: string;
    email: string;
    mobile: string;
    city: string;
    state: string;
    country: string;
    profilePhotoUrl: string;
    idProofType: string;
    approvalStatus: ApprovalStatus;
    dynamicFields: Record<string, string>;
  } | null;
}
