# Secure QR Verification System — Entity-Relationship Diagram

```mermaid
erDiagram
  USER_ACCOUNTS ||--o| ADMIN_PROFILES : "has admin profile"
  USER_ACCOUNTS ||--o| USER_RECORDS : "owns registration"
  USER_RECORDS ||--o{ REGISTRATION_REQUESTS : "tracks"
  USER_RECORDS ||--o{ QR_CODES : "issued credentials"
  QR_CODES ||--o{ QR_SCAN_LOGS : "recorded scans"
  USER_ACCOUNTS ||--o{ QR_SCAN_LOGS : "scanned by admin"
  USER_ACCOUNTS ||--o{ NOTIFICATIONS : "receives"
  USER_ACCOUNTS ||--o{ ADMIN_ACTIVITY_LOGS : "audited actor"
  USER_ACCOUNTS ||--o{ EXPORT_HISTORY : "exports excel"
```

## Key Security Invariants
- `otp_verifications.otp_hash` stores HMAC-SHA256 digests only; plaintext OTPs are never persisted.
- `qr_codes.token_hash` stores SHA-256 digests of 256-bit `secrets.token_urlsafe(32)` tokens; plaintext tokens are never stored in database tables.
- Only `APPROVED` `user_records` with `user_accounts.is_active = 1` can hold an `ACTIVE` QR credential.
