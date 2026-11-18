import type {DatabaseSync as DatabaseSyncType} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  generateSecureQrToken,
  hashPassword,
  sha256Hex,
} from './crypto';

const sqliteMod = (process as unknown as {getBuiltinModule: (id: string) => {DatabaseSync: new (loc: string) => DatabaseSyncType}})
  .getBuiltinModule('node:sqlite');
const DatabaseSync = sqliteMod.DatabaseSync;

const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'secure_qr.db');

let dbInstance: DatabaseSyncType | null = null;

export function getUploadsDir(): string {
  fs.mkdirSync(UPLOADS_DIR, {recursive: true});
  return UPLOADS_DIR;
}

export function getDb(): DatabaseSyncType {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.mkdirSync(UPLOADS_DIR, {recursive: true});

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  createSchema(db);
  dbInstance = db;
  return db;
}

export function withTransaction<T>(fn: (db: DatabaseSyncType) => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function createSchema(db: DatabaseSyncType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL,
      permission_code TEXT NOT NULL,
      PRIMARY KEY (role_id, permission_code),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      mobile TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'USER')),
      is_active INTEGER NOT NULL DEFAULT 1,
      is_mobile_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_accounts_role ON user_accounts(role);
    CREATE INDEX IF NOT EXISTS idx_user_accounts_mobile ON user_accounts(mobile);

    CREATE TABLE IF NOT EXISTS admin_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT 'Verification Operations',
      designation TEXT NOT NULL DEFAULT 'Compliance Officer',
      avatar_url TEXT NOT NULL DEFAULT '/assets/images/avatar_admin_portrait_1794911291825.jpg',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      created_by INTEGER NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      registration_id TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      dob TEXT NULL,
      gender TEXT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      district TEXT NOT NULL,
      state TEXT NOT NULL,
      country TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      profile_photo_url TEXT NOT NULL,
      id_proof_type TEXT NOT NULL DEFAULT 'National ID',
      id_proof_url TEXT NULL,
      dynamic_fields_json TEXT NOT NULL DEFAULT '{}',
      consent_accepted INTEGER NOT NULL DEFAULT 1,
      consent_timestamp TEXT NOT NULL,
      approval_status TEXT NOT NULL CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED')),
      rejection_reason TEXT NULL,
      resubmission_note TEXT NULL,
      reviewed_by INTEGER NULL,
      reviewed_at TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT NULL,
      FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewed_by) REFERENCES user_accounts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_records_status ON user_records(approval_status);
    CREATE INDEX IF NOT EXISTS idx_user_records_city_state ON user_records(state, city);
    CREATE INDEX IF NOT EXISTS idx_user_records_reg_id ON user_records(registration_id);

    CREATE TABLE IF NOT EXISTS registration_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_record_id INTEGER NOT NULL,
      request_type TEXT NOT NULL CHECK (request_type IN ('INITIAL', 'RESUBMISSION')),
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED')),
      notes TEXT NULL,
      submitted_at TEXT NOT NULL,
      processed_by INTEGER NULL,
      processed_at TEXT NULL,
      FOREIGN KEY (user_record_id) REFERENCES user_records(id) ON DELETE CASCADE,
      FOREIGN KEY (processed_by) REFERENCES user_accounts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS otp_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mobile TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'REGISTRATION',
      otp_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      verified_at TEXT NULL,
      used_at TEXT NULL,
      ip_address TEXT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_otp_mobile_created ON otp_verifications(mobile, created_at);

    CREATE TABLE IF NOT EXISTS qr_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_record_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      verification_url TEXT NOT NULL,
      qr_png_data_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT NULL,
      revoked_by INTEGER NULL,
      revoke_reason TEXT NULL,
      issued_by INTEGER NULL,
      last_verified_at TEXT NULL,
      scan_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_record_id) REFERENCES user_records(id) ON DELETE CASCADE,
      FOREIGN KEY (revoked_by) REFERENCES user_accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (issued_by) REFERENCES user_accounts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_qr_codes_user_status ON qr_codes(user_record_id, status);
    CREATE INDEX IF NOT EXISTS idx_qr_codes_token_hash ON qr_codes(token_hash);

    CREATE TABLE IF NOT EXISTS qr_scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qr_code_id INTEGER NULL,
      user_record_id INTEGER NULL,
      scanned_by_admin_id INTEGER NOT NULL,
      scanned_token_prefix TEXT NOT NULL,
      result_status TEXT NOT NULL CHECK (result_status IN ('VALID', 'INVALID', 'EXPIRED', 'REVOKED', 'INACTIVE_USER', 'UNAPPROVED_USER')),
      reason TEXT NOT NULL,
      ip_address TEXT NULL,
      user_agent TEXT NULL,
      scanned_at TEXT NOT NULL,
      FOREIGN KEY (qr_code_id) REFERENCES qr_codes(id) ON DELETE SET NULL,
      FOREIGN KEY (user_record_id) REFERENCES user_records(id) ON DELETE SET NULL,
      FOREIGN KEY (scanned_by_admin_id) REFERENCES user_accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_qr_scan_logs_scanned_at ON qr_scan_logs(scanned_at);

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_user_id INTEGER NULL,
      recipient_role TEXT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      link_path TEXT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      is_read INTEGER NOT NULL DEFAULT 0,
      read_at TEXT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (recipient_user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_user_id, recipient_role, is_read);

    CREATE TABLE IF NOT EXISTS admin_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER NULL,
      actor_email TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON admin_activity_logs(created_at);

    CREATE TABLE IF NOT EXISTS user_field_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL CHECK (field_type IN ('text', 'select', 'date', 'file')),
      is_required INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      is_editable_on_resubmit INTEGER NOT NULL DEFAULT 1,
      options_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS export_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER NOT NULL,
      admin_email TEXT NOT NULL,
      filters_json TEXT NOT NULL DEFAULT '{}',
      record_count INTEGER NOT NULL,
      filename TEXT NOT NULL,
      exported_at TEXT NOT NULL,
      FOREIGN KEY (admin_user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by INTEGER NULL
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_report_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_email TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      filename TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('SENT', 'FAILED')),
      error_message TEXT NULL,
      trigger_type TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );
  `);
}

let seeded = false;

function ensureFixedAdmin(db: DatabaseSyncType): void {
  try {
    (process as unknown as {loadEnvFile?: () => void}).loadEnvFile?.();
  } catch {
    // .env may not exist in all environments
  }

  const fixedEmail = (process.env['FIXED_ADMIN_EMAIL'] || 'kishore.sathayush@gmail.com')
    .trim()
    .toLowerCase();
  const fixedPassword = process.env['FIXED_ADMIN_PASSWORD'] || '';
  if (!fixedEmail || !fixedPassword) {
    return;
  }

  const now = new Date().toISOString();
  const allPerms = [
    'can_view_registrations',
    'can_approve_registrations',
    'can_manage_qr',
    'can_scan_qr',
    'can_export_excel',
    'can_manage_users',
  ];

  const existing = db
    .prepare('SELECT id FROM user_accounts WHERE lower(email) = ?')
    .get(fixedEmail) as {id: number} | undefined;

  let adminId: number;
  if (existing) {
    adminId = existing.id;
    db.prepare(
      `UPDATE user_accounts
       SET password_hash = ?, role = 'SUPER_ADMIN', is_active = 1, is_mobile_verified = 1, updated_at = ?
       WHERE id = ?`,
    ).run(hashPassword(fixedPassword), now, adminId);
  } else {
    const mobileCandidate = process.env['FIXED_ADMIN_MOBILE'] || '+919550000955';
    const res = db
      .prepare(
        `INSERT INTO user_accounts
          (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
         VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 1, ?, ?)`,
      )
      .run(fixedEmail, mobileCandidate, hashPassword(fixedPassword), now, now);
    adminId = Number(res.lastInsertRowid);
  }

  const existingProfile = db
    .prepare('SELECT id FROM admin_profiles WHERE user_id = ?')
    .get(adminId) as {id: number} | undefined;

  if (existingProfile) {
    db.prepare('UPDATE admin_profiles SET permissions_json = ? WHERE user_id = ?').run(
      JSON.stringify(allPerms),
      adminId,
    );
  } else {
    db.prepare(
      `INSERT INTO admin_profiles
        (user_id, full_name, department, designation, avatar_url, permissions_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      adminId,
      'Kishore (Primary Admin)',
      'Executive Governance',
      'Fixed Super Administrator',
      '/assets/images/avatar_admin_portrait_1794911291825.jpg',
      JSON.stringify(allPerms),
      adminId,
      now,
    );
  }
}

export async function ensureSeeded(baseUrl = 'http://localhost:3000'): Promise<void> {
  if (seeded) return;
  const db = getDb();

  const existingCount = db
    .prepare('SELECT COUNT(*) as cnt FROM user_accounts')
    .get() as {cnt: number};

  if (existingCount.cnt > 0) {
    ensureFixedAdmin(db);
    seeded = true;
    return;
  }

  const now = new Date().toISOString();

  // Roles
  const insertRole = db.prepare(
    'INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)',
  );
  insertRole.run('SUPER_ADMIN', 'Full system authority including admin accounts, audit logs, and settings.');
  insertRole.run('ADMIN', 'Delegated verification officer with configurable module permissions.');
  insertRole.run('USER', 'Registered member eligible for credential verification.');

  // Permissions
  const perms: [string, string, string][] = [
    ['can_view_registrations', 'View Registrations', 'Inspect registration queue and identity documents'],
    ['can_approve_registrations', 'Approve & Reject', 'Approve, reject, or request resubmission on applications'],
    ['can_manage_qr', 'Manage QR Codes', 'Issue, regenerate, and revoke QR credentials'],
    ['can_scan_qr', 'Scan & Verify QR', 'Access live camera QR scanner and view holder verification photo'],
    ['can_export_excel', 'Export Excel', 'Export authorized records to Excel (.xlsx)'],
    ['can_manage_users', 'Manage Users', 'Activate, deactivate, or archive user accounts'],
  ];
  const insertPerm = db.prepare(
    'INSERT OR IGNORE INTO permissions (code, label, description) VALUES (?, ?, ?)',
  );
  for (const p of perms) {
    insertPerm.run(...p);
  }

  // System settings
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)',
  );
  insertSetting.run('organization_name', 'Secure QR Verification Authority', now);
  insertSetting.run('qr_validity_days', '365', now);
  insertSetting.run('allow_multiple_active_qr', 'false', now);
  insertSetting.run('otp_expiry_minutes', '5', now);
  insertSetting.run('max_otp_attempts', '5', now);
  insertSetting.run('id_proof_required', 'true', now);
  insertSetting.run('verification_alert_enabled', 'true', now);

  // Dynamic User Field Configs
  const insertField = db.prepare(
    `INSERT OR IGNORE INTO user_field_configs
      (field_key, label, field_type, is_required, is_enabled, is_editable_on_resubmit, options_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertField.run('organization', 'Organization / Employer', 'text', 1, 1, 1, '[]', 1);
  insertField.run('department', 'Department / Division', 'text', 0, 1, 1, '[]', 2);
  insertField.run(
    'access_tier',
    'Credential Tier',
    'select',
    1,
    1,
    0,
    JSON.stringify(['Standard Member', 'Facility Contractor', 'Executive Pass', 'Visitor Escort']),
    3,
  );
  insertField.run('emergency_contact', 'Emergency Contact Number', 'text', 0, 1, 1, '[]', 4);

  // Super Admin
  const insertUser = db.prepare(
    `INSERT INTO user_accounts
      (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
  );
  const superAdminRes = insertUser.run(
    'superadmin@secureqr.gov',
    '+15550100001',
    hashPassword('SuperAdmin@2026!'),
    'SUPER_ADMIN',
    now,
    now,
  );
  const superAdminId = Number(superAdminRes.lastInsertRowid);

  db.prepare(
    `INSERT INTO admin_profiles
      (user_id, full_name, department, designation, avatar_url, permissions_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    superAdminId,
    'Eleanor Vance',
    'Governance & Trust Operations',
    'Chief Security Administrator',
    '/assets/images/avatar_admin_portrait_1794911291825.jpg',
    JSON.stringify(perms.map((p) => p[0])),
    superAdminId,
    now,
  );

  // Delegated Admin
  const verifierAdminRes = insertUser.run(
    'admin.verifier@secureqr.gov',
    '+15550100002',
    hashPassword('Verifier@2026!'),
    'ADMIN',
    now,
    now,
  );
  const verifierAdminId = Number(verifierAdminRes.lastInsertRowid);

  db.prepare(
    `INSERT INTO admin_profiles
      (user_id, full_name, department, designation, avatar_url, permissions_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verifierAdminId,
    'Marcus Sterling',
    'Identity Review Desk',
    'Senior Verification Officer',
    '/assets/images/avatar_admin_portrait_1794911291825.jpg',
    JSON.stringify([
      'can_view_registrations',
      'can_approve_registrations',
      'can_manage_qr',
      'can_scan_qr',
      'can_export_excel',
    ]),
    superAdminId,
    now,
  );

  // Sample User 1: APPROVED with Active 256-bit QR Code
  const u1Res = insertUser.run(
    'aarav.sharma@enterprise.org',
    '+15550101001',
    hashPassword('Member@2026!'),
    'USER',
    now,
    now,
  );
  const u1Id = Number(u1Res.lastInsertRowid);
  const u1RecRes = db
    .prepare(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'APPROVED', ?, ?, ?, ?)`,
    )
    .run(
      u1Id,
      'SQR-2026-000101',
      'Aarav Sharma',
      '1993-04-18',
      'Male',
      '450 Mission Street, Suite 1200',
      'San Francisco',
      'San Francisco County',
      'California',
      'United States',
      '94105',
      '/assets/images/avatar_member_portrait_1794911275468.jpg',
      'National Passport',
      '/assets/images/brand_shield_emblem_1794911274112.jpg',
      JSON.stringify({
        organization: 'Pacific Cloud Infrastructure',
        department: 'Platform Security',
        access_tier: 'Executive Pass',
        emergency_contact: '+15550199911',
      }),
      now,
      superAdminId,
      now,
      new Date(Date.now() - 86400000 * 5).toISOString(),
      now,
    );
  const u1RecId = Number(u1RecRes.lastInsertRowid);

  db.prepare(
    `INSERT INTO registration_requests
      (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
     VALUES (?, 'INITIAL', 'APPROVED', 'Identity and passport verified.', ?, ?, ?)`,
  ).run(u1RecId, new Date(Date.now() - 86400000 * 5).toISOString(), superAdminId, now);

  // Generate genuine 256-bit QR token & store ONLY its SHA-256 hash
  const rawToken = generateSecureQrToken();
  const tokenHash = sha256Hex(rawToken);
  const tokenPrefix = tokenHash.slice(0, 12);
  const verifyUrl = `${baseUrl.replace(/\/$/, '')}/verify?token=${encodeURIComponent(rawToken)}`;
  const qrPngDataUrl = await QRCode.toDataURL(verifyUrl, {
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 420,
    color: {dark: '#0F172A', light: '#FFFFFF'},
  });
  const expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();

  const qrRes = db
    .prepare(
      `INSERT INTO qr_codes
        (user_record_id, token_hash, token_prefix, verification_url, qr_png_data_url, status, issued_at, expires_at, issued_by, last_verified_at, scan_count)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 2)`,
    )
    .run(u1RecId, tokenHash, tokenPrefix, verifyUrl, qrPngDataUrl, now, expiresAt, superAdminId, now);

  db.prepare(
    `INSERT INTO qr_scan_logs
      (qr_code_id, user_record_id, scanned_by_admin_id, scanned_token_prefix, result_status, reason, ip_address, user_agent, scanned_at)
     VALUES (?, ?, ?, ?, 'VALID', 'Active credential verified at main lobby.', '127.0.0.1', 'Seed/Verifier', ?)`,
  ).run(Number(qrRes.lastInsertRowid), u1RecId, verifierAdminId, tokenPrefix, now);

  // Sample User 2: PENDING
  const u2Res = insertUser.run(
    'priya.nair@meridianlabs.io',
    '+15550101002',
    hashPassword('Member@2026!'),
    'USER',
    now,
    now,
  );
  const u2Id = Number(u2Res.lastInsertRowid);
  const u2RecRes = db
    .prepare(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'PENDING', ?, ?)`,
    )
    .run(
      u2Id,
      'SQR-2026-000102',
      'Priya Nair',
      '1995-09-12',
      'Female',
      '712 Congress Ave, Floor 8',
      'Austin',
      'Travis County',
      'Texas',
      'United States',
      '78701',
      '/assets/images/avatar_admin_portrait_1794911291825.jpg',
      'Driver License',
      '/assets/images/brand_shield_emblem_1794911274112.jpg',
      JSON.stringify({
        organization: 'Meridian BioSystems',
        department: 'Clinical Research',
        access_tier: 'Standard Member',
        emergency_contact: '+15550199922',
      }),
      now,
      new Date(Date.now() - 3600000 * 6).toISOString(),
      now,
    );
  db.prepare(
    `INSERT INTO registration_requests
      (user_record_id, request_type, status, notes, submitted_at)
     VALUES (?, 'INITIAL', 'PENDING', 'Awaiting Admin review.', ?)`,
  ).run(Number(u2RecRes.lastInsertRowid), new Date(Date.now() - 3600000 * 6).toISOString());

  // Sample User 3: PENDING
  const u3Res = insertUser.run(
    'daniel.chen@northstar.co',
    '+15550101003',
    hashPassword('Member@2026!'),
    'USER',
    now,
    now,
  );
  const u3Id = Number(u3Res.lastInsertRowid);
  const u3RecRes = db
    .prepare(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'PENDING', ?, ?)`,
    )
    .run(
      u3Id,
      'SQR-2026-000103',
      'Daniel Chen',
      '1990-11-03',
      'Male',
      '200 Clarendon St',
      'Boston',
      'Suffolk County',
      'Massachusetts',
      'United States',
      '02116',
      '/assets/images/avatar_member_portrait_1794911275468.jpg',
      'State ID',
      '/assets/images/brand_shield_emblem_1794911274112.jpg',
      JSON.stringify({
        organization: 'Northstar Logistics',
        department: 'Field Operations',
        access_tier: 'Facility Contractor',
        emergency_contact: '+15550199933',
      }),
      now,
      new Date(Date.now() - 3600000 * 2).toISOString(),
      now,
    );
  db.prepare(
    `INSERT INTO registration_requests
      (user_record_id, request_type, status, notes, submitted_at)
     VALUES (?, 'INITIAL', 'PENDING', 'Awaiting Admin review.', ?)`,
  ).run(Number(u3RecRes.lastInsertRowid), new Date(Date.now() - 3600000 * 2).toISOString());

  // Sample User 4: RESUBMISSION_REQUIRED
  const u4Res = insertUser.run(
    'sofia.rodriguez@civicgrid.org',
    '+15550101004',
    hashPassword('Member@2026!'),
    'USER',
    now,
    now,
  );
  const u4Id = Number(u4Res.lastInsertRowid);
  const u4RecRes = db
    .prepare(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, resubmission_note, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'RESUBMISSION_REQUIRED', ?, ?, ?, ?, ?)`,
    )
    .run(
      u4Id,
      'SQR-2026-000104',
      'Sofia Rodriguez',
      '1992-07-29',
      'Female',
      '88 Colin P Kelly Jr St',
      'San Jose',
      'Santa Clara County',
      'California',
      'United States',
      '95113',
      '/assets/images/avatar_admin_portrait_1794911291825.jpg',
      'National Passport',
      '/assets/images/brand_shield_emblem_1794911274112.jpg',
      JSON.stringify({
        organization: 'CivicGrid Energy',
        department: 'Grid Telemetry',
        access_tier: 'Facility Contractor',
        emergency_contact: '+15550199944',
      }),
      now,
      'Please update street address with suite number and re-upload a clear ID proof image.',
      verifierAdminId,
      now,
      new Date(Date.now() - 86400000 * 2).toISOString(),
      now,
    );
  db.prepare(
    `INSERT INTO registration_requests
      (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
     VALUES (?, 'INITIAL', 'RESUBMISSION_REQUIRED', 'Address clarification requested.', ?, ?, ?)`,
  ).run(Number(u4RecRes.lastInsertRowid), new Date(Date.now() - 86400000 * 2).toISOString(), verifierAdminId, now);

  // Sample User 5: REJECTED
  const u5Res = insertUser.run(
    'liam.okafor@example.net',
    '+15550101005',
    hashPassword('Member@2026!'),
    'USER',
    now,
    now,
  );
  const u5Id = Number(u5Res.lastInsertRowid);
  const u5RecRes = db
    .prepare(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, rejection_reason, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'REJECTED', ?, ?, ?, ?, ?)`,
    )
    .run(
      u5Id,
      'SQR-2026-000105',
      'Liam Okafor',
      '1988-02-14',
      'Male',
      '1400 Brickell Ave',
      'Miami',
      'Miami-Dade County',
      'Florida',
      'United States',
      '33131',
      '/assets/images/avatar_member_portrait_1794911275468.jpg',
      'National ID',
      '/assets/images/brand_shield_emblem_1794911274112.jpg',
      JSON.stringify({
        organization: 'Independent Contractor',
        department: 'External',
        access_tier: 'Visitor Escort',
        emergency_contact: '+15550199955',
      }),
      now,
      'Submitted government identification expired prior to application date.',
      superAdminId,
      now,
      new Date(Date.now() - 86400000 * 3).toISOString(),
      now,
    );
  db.prepare(
    `INSERT INTO registration_requests
      (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
     VALUES (?, 'INITIAL', 'REJECTED', 'Expired ID document.', ?, ?, ?)`,
  ).run(Number(u5RecRes.lastInsertRowid), new Date(Date.now() - 86400000 * 3).toISOString(), superAdminId, now);

  // Notifications
  const insertNotif = db.prepare(
    `INSERT INTO notifications
      (recipient_user_id, recipient_role, type, title, message, link_path, metadata_json, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  insertNotif.run(
    null,
    'ADMIN',
    'NEW_REGISTRATION',
    'New Registration Pending Review',
    'Priya Nair (SQR-2026-000102) submitted an application from Austin, Texas.',
    '/admin/registrations',
    JSON.stringify({userRecordId: Number(u2RecRes.lastInsertRowid), registrationId: 'SQR-2026-000102'}),
    now,
  );
  insertNotif.run(
    null,
    'ADMIN',
    'NEW_REGISTRATION',
    'New Registration Pending Review',
    'Daniel Chen (SQR-2026-000103) submitted an application from Boston, Massachusetts.',
    '/admin/registrations',
    JSON.stringify({userRecordId: Number(u3RecRes.lastInsertRowid), registrationId: 'SQR-2026-000103'}),
    now,
  );
  insertNotif.run(
    u1Id,
    null,
    'QR_GENERATED',
    'Credential Approved & QR Ready',
    'Your application (SQR-2026-000101) was approved and your active QR credential is ready.',
    '/user/qr-card',
    JSON.stringify({registrationId: 'SQR-2026-000101'}),
    now,
  );
  insertNotif.run(
    u4Id,
    null,
    'RESUBMISSION_REQUIRED',
    'Resubmission Requested',
    'Please update street address with suite number and re-upload a clear ID proof image.',
    '/user/profile',
    JSON.stringify({registrationId: 'SQR-2026-000104'}),
    now,
  );
  insertNotif.run(
    u5Id,
    null,
    'REGISTRATION_REJECTED',
    'Application Rejected',
    'Submitted government identification expired prior to application date.',
    '/user/home',
    JSON.stringify({registrationId: 'SQR-2026-000105'}),
    now,
  );

  // Initial Audit Log
  db.prepare(
    `INSERT INTO admin_activity_logs
      (actor_user_id, actor_email, actor_role, action, target_type, target_id, details_json, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    superAdminId,
    'superadmin@secureqr.gov',
    'SUPER_ADMIN',
    'SYSTEM_INITIALIZED',
    'SYSTEM',
    'bootstrap',
    JSON.stringify({seededUsers: 5, seededAdmins: 2}),
    '127.0.0.1',
    now,
  );

  ensureFixedAdmin(db);
  seeded = true;
}
