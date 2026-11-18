import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import QRCode from 'qrcode';
import {
  generateSecureQrToken,
  hashPassword,
  sha256Hex,
} from './crypto';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

function loadEnvSafe(): void {
  try {
    (process as unknown as {loadEnvFile?: () => void}).loadEnvFile?.();
  } catch {
    // .env may not exist in all environments
  }
}

export function sanitizeDbName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '');
  return cleaned || 'secure_qr_verification';
}

export function getMysqlConfig() {
  loadEnvSafe();
  const host = (process.env['DB_HOST'] || '').trim();
  const port = Number.parseInt(process.env['DB_PORT'] || '3306', 10) || 3306;
  const user = (process.env['DB_USER'] || '').trim();
  const password = process.env['DB_PASSWORD'] || '';
  const database = sanitizeDbName(process.env['DB_NAME'] || 'secure_qr_verification');
  return {host, port, user, password, database};
}

export function getUploadsDir(): string {
  fs.mkdirSync(UPLOADS_DIR, {recursive: true});
  return UPLOADS_DIR;
}

export function toMysqlDateTime(input?: Date | string | number): string {
  const d = input instanceof Date ? input : input !== undefined ? new Date(input) : new Date();
  const valid = Number.isNaN(d.getTime()) ? new Date() : d;
  return valid.toISOString().slice(0, 23).replace('T', ' ');
}

export function toIsoString(input: unknown): string {
  if (!input) return '';
  if (input instanceof Date) return input.toISOString();
  return String(input);
}

export function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined || val === '') return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

let poolInstance: mysql.Pool | null = null;
let initPromise: Promise<void> | null = null;
let seeded = false;
let seedingPromise: Promise<void> | null = null;

export function getPool(): mysql.Pool {
  if (poolInstance) return poolInstance;
  const cfg = getMysqlConfig();
  if (!cfg.host || !cfg.user) {
    throw new Error(
      'MySQL RDS configuration is missing (DB_HOST / DB_USER). Configure .env before starting the server.',
    );
  }
  poolInstance = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'Z',
    connectTimeout: 8000,
  });
  return poolInstance;
}

export async function queryRows<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await getPool().query(sql, params);
  return rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await queryRows<T>(sql, params);
  return rows[0];
}

export async function executeSql(
  sql: string,
  params: unknown[] = [],
): Promise<mysql.ResultSetHeader> {
  const [res] = await getPool().query(sql, params);
  return res as mysql.ResultSetHeader;
}

export interface TxClient {
  queryRows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  executeSql(sql: string, params?: unknown[]): Promise<mysql.ResultSetHeader>;
}

export async function withTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  await conn.beginTransaction();
  const tx: TxClient = {
    async queryRows<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
      const [rows] = await conn.query(sql, params);
      return rows as R[];
    },
    async queryOne<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R | undefined> {
      const [rows] = await conn.query(sql, params);
      return (rows as R[])[0];
    },
    async executeSql(sql: string, params: unknown[] = []): Promise<mysql.ResultSetHeader> {
      const [res] = await conn.query(sql, params);
      return res as mysql.ResultSetHeader;
    },
  };

  try {
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export const MYSQL_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS roles (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(32) NOT NULL UNIQUE,
    description TEXT NOT NULL
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS permissions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    label VARCHAR(128) NOT NULL,
    description TEXT NOT NULL
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
    role_id BIGINT NOT NULL,
    permission_code VARCHAR(64) NOT NULL,
    PRIMARY KEY (role_id, permission_code),
    CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS user_accounts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    mobile VARCHAR(20) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('SUPER_ADMIN', 'ADMIN', 'USER') NOT NULL DEFAULT 'USER',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    is_mobile_verified TINYINT(1) NOT NULL DEFAULT 0,
    is_email_verified TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    deleted_at DATETIME(6) NULL,
    INDEX idx_user_accounts_role (role),
    INDEX idx_user_accounts_mobile (mobile)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS admin_profiles (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE,
    full_name VARCHAR(150) NOT NULL,
    department VARCHAR(120) NOT NULL DEFAULT 'Verification Operations',
    designation VARCHAR(120) NOT NULL DEFAULT 'Compliance Officer',
    avatar_url VARCHAR(500) NOT NULL DEFAULT '/assets/images/avatar_admin_portrait_1794911291825.jpg',
    permissions_json JSON NOT NULL,
    created_by BIGINT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_admin_user FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS user_records (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE,
    registration_id VARCHAR(32) NOT NULL UNIQUE,
    full_name VARCHAR(160) NOT NULL,
    dob DATE NULL,
    gender VARCHAR(32) NULL,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL,
    district VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    country VARCHAR(100) NOT NULL,
    postal_code VARCHAR(24) NOT NULL,
    profile_photo_url VARCHAR(500) NOT NULL,
    id_proof_type VARCHAR(64) NOT NULL DEFAULT 'National ID',
    id_proof_url VARCHAR(500) NULL,
    dynamic_fields_json JSON NOT NULL,
    consent_accepted TINYINT(1) NOT NULL DEFAULT 1,
    consent_timestamp DATETIME(6) NOT NULL,
    approval_status ENUM('PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED') NOT NULL DEFAULT 'PENDING',
    rejection_reason TEXT NULL,
    resubmission_note TEXT NULL,
    reviewed_by BIGINT NULL,
    reviewed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    deleted_at DATETIME(6) NULL,
    INDEX idx_ur_status (approval_status),
    INDEX idx_ur_state_city (state, city),
    CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS registration_requests (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_record_id BIGINT NOT NULL,
    request_type ENUM('INITIAL', 'RESUBMISSION') NOT NULL DEFAULT 'INITIAL',
    status ENUM('PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED') NOT NULL,
    notes TEXT NULL,
    submitted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    processed_by BIGINT NULL,
    processed_at DATETIME(6) NULL,
    CONSTRAINT fk_rr_record FOREIGN KEY (user_record_id) REFERENCES user_records(id) ON DELETE CASCADE
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS otp_verifications (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NULL,
    mobile VARCHAR(20) NULL DEFAULT '',
    purpose VARCHAR(32) NOT NULL DEFAULT 'REGISTRATION',
    otp_hash CHAR(64) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 5,
    verified_at DATETIME(6) NULL,
    used_at DATETIME(6) NULL,
    ip_address VARCHAR(45) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_otp_email_created (email, created_at),
    INDEX idx_otp_mobile_created (mobile, created_at)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS qr_codes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_record_id BIGINT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    token_prefix VARCHAR(16) NOT NULL,
    verification_url TEXT NOT NULL,
    qr_png_data_url MEDIUMTEXT NOT NULL,
    status ENUM('ACTIVE', 'EXPIRED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    issued_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    expires_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    revoked_by BIGINT NULL,
    revoke_reason TEXT NULL,
    issued_by BIGINT NULL,
    last_verified_at DATETIME(6) NULL,
    scan_count INT UNSIGNED NOT NULL DEFAULT 0,
    INDEX idx_qr_user_status (user_record_id, status),
    CONSTRAINT fk_qr_record FOREIGN KEY (user_record_id) REFERENCES user_records(id) ON DELETE CASCADE
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS qr_scan_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    qr_code_id BIGINT NULL,
    user_record_id BIGINT NULL,
    scanned_by_admin_id BIGINT NOT NULL,
    scanned_token_prefix VARCHAR(16) NOT NULL,
    result_status ENUM('VALID', 'INVALID', 'EXPIRED', 'REVOKED', 'INACTIVE_USER', 'UNAPPROVED_USER') NOT NULL,
    reason TEXT NOT NULL,
    ip_address VARCHAR(45) NULL,
    user_agent TEXT NULL,
    scanned_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_scan_at (scanned_at)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    recipient_user_id BIGINT NULL,
    recipient_role VARCHAR(20) NULL,
    type VARCHAR(48) NOT NULL,
    title VARCHAR(180) NOT NULL,
    message TEXT NOT NULL,
    link_path VARCHAR(255) NULL,
    metadata_json JSON NOT NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    read_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_notif_recipient (recipient_user_id, recipient_role, is_read)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS admin_activity_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    actor_user_id BIGINT NULL,
    actor_email VARCHAR(255) NOT NULL,
    actor_role VARCHAR(20) NOT NULL,
    action VARCHAR(64) NOT NULL,
    target_type VARCHAR(64) NOT NULL,
    target_id VARCHAR(64) NULL,
    details_json JSON NOT NULL,
    ip_address VARCHAR(45) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_audit_created (created_at)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS user_field_configs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    field_key VARCHAR(64) NOT NULL UNIQUE,
    label VARCHAR(120) NOT NULL,
    field_type ENUM('text', 'select', 'date', 'file') NOT NULL DEFAULT 'text',
    is_required TINYINT(1) NOT NULL DEFAULT 0,
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    is_editable_on_resubmit TINYINT(1) NOT NULL DEFAULT 1,
    options_json JSON NOT NULL,
    sort_order INT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS export_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    admin_user_id BIGINT NOT NULL,
    admin_email VARCHAR(255) NOT NULL,
    filters_json JSON NOT NULL,
    record_count INT UNSIGNED NOT NULL,
    filename VARCHAR(255) NOT NULL,
    exported_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS system_settings (
    \`key\` VARCHAR(100) PRIMARY KEY,
    \`value\` TEXT NOT NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    updated_by BIGINT NULL
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS scheduled_report_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    recipient_email VARCHAR(255) NOT NULL,
    record_count INT UNSIGNED NOT NULL,
    filename VARCHAR(255) NOT NULL,
    status ENUM('SENT', 'FAILED') NOT NULL,
    error_message TEXT NULL,
    trigger_type VARCHAR(40) NOT NULL,
    sent_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  ) ENGINE=InnoDB;`,
];

export async function ensureDbInitialized(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const cfg = getMysqlConfig();
    if (!cfg.host || !cfg.user) {
      throw new Error('MySQL RDS credentials (DB_HOST / DB_USER) are not configured.');
    }

    const bootstrapConn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      connectTimeout: 8000,
      multipleStatements: true,
    });
    try {
      const batchSql = [
        `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        `USE \`${cfg.database}\`;`,
        ...MYSQL_DDL_STATEMENTS,
      ].join('\n');
      await bootstrapConn.query(batchSql);

      // Safely upgrade any tables previously created without newer columns
      const [colRows] = await bootstrapConn.query(
        `SELECT TABLE_NAME, COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND ((TABLE_NAME = 'admin_profiles' AND COLUMN_NAME = 'avatar_url')
             OR (TABLE_NAME = 'qr_codes' AND COLUMN_NAME = 'qr_png_data_url')
             OR (TABLE_NAME = 'user_accounts' AND COLUMN_NAME = 'is_email_verified')
             OR (TABLE_NAME = 'otp_verifications' AND COLUMN_NAME = 'email'))`,
        [cfg.database],
      );
      const existingCols = new Set(
        (colRows as {TABLE_NAME: string; COLUMN_NAME: string}[]).map(
          (r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`,
        ),
      );
      if (!existingCols.has('admin_profiles.avatar_url')) {
        await bootstrapConn.query(
          `ALTER TABLE admin_profiles ADD COLUMN avatar_url VARCHAR(500) NOT NULL DEFAULT '/assets/images/avatar_admin_portrait_1794911291825.jpg' AFTER designation`,
        );
      }
      if (!existingCols.has('qr_codes.qr_png_data_url')) {
        await bootstrapConn.query(
          `ALTER TABLE qr_codes ADD COLUMN qr_png_data_url MEDIUMTEXT NOT NULL AFTER verification_url`,
        );
      }
      if (!existingCols.has('user_accounts.is_email_verified')) {
        await bootstrapConn.query(
          `ALTER TABLE user_accounts ADD COLUMN is_email_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER is_mobile_verified`,
        );
      }
      if (!existingCols.has('otp_verifications.email')) {
        await bootstrapConn.query(
          `ALTER TABLE otp_verifications ADD COLUMN email VARCHAR(255) NULL AFTER id, MODIFY COLUMN mobile VARCHAR(20) NULL DEFAULT '', ADD INDEX idx_otp_email_created (email, created_at)`,
        );
      }
    } finally {
      await bootstrapConn.end();
    }

    getPool();
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

async function ensureFixedAdmin(): Promise<void> {
  loadEnvSafe();
  const fixedEmail = (process.env['FIXED_ADMIN_EMAIL'] || 'kishore.sathayush@gmail.com')
    .trim()
    .toLowerCase();
  const fixedPassword = process.env['FIXED_ADMIN_PASSWORD'] || '';
  if (!fixedEmail || !fixedPassword) {
    return;
  }

  const now = toMysqlDateTime();
  const allPerms = [
    'can_view_registrations',
    'can_approve_registrations',
    'can_manage_qr',
    'can_scan_qr',
    'can_export_excel',
    'can_manage_users',
  ];

  const existing = await queryOne<{id: number}>(
    'SELECT id FROM user_accounts WHERE LOWER(email) = ?',
    [fixedEmail],
  );

  let adminId: number;
  if (existing) {
    adminId = existing.id;
    await executeSql(
      `UPDATE user_accounts
       SET password_hash = ?, role = 'SUPER_ADMIN', is_active = 1, is_mobile_verified = 1, updated_at = ?
       WHERE id = ?`,
      [hashPassword(fixedPassword), now, adminId],
    );
  } else {
    const mobileCandidate = process.env['FIXED_ADMIN_MOBILE'] || '+919550000955';
    const res = await executeSql(
      `INSERT INTO user_accounts
        (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 1, ?, ?)`,
      [fixedEmail, mobileCandidate, hashPassword(fixedPassword), now, now],
    );
    adminId = Number(res.insertId);
  }

  const existingProfile = await queryOne<{id: number}>(
    'SELECT id FROM admin_profiles WHERE user_id = ?',
    [adminId],
  );

  if (existingProfile) {
    await executeSql('UPDATE admin_profiles SET permissions_json = ? WHERE user_id = ?', [
      JSON.stringify(allPerms),
      adminId,
    ]);
  } else {
    await executeSql(
      `INSERT INTO admin_profiles
        (user_id, full_name, department, designation, avatar_url, permissions_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        adminId,
        'Kishore (Primary Admin)',
        'Executive Governance',
        'Fixed Super Administrator',
        '/assets/images/avatar_admin_portrait_1794911291825.jpg',
        JSON.stringify(allPerms),
        adminId,
        now,
      ],
    );
  }
}

export async function ensureSeeded(baseUrl = 'http://localhost:3000'): Promise<void> {
  if (seeded) return;
  if (seedingPromise) return seedingPromise;

  seedingPromise = (async () => {
    await ensureDbInitialized();

    const existingCountRow = await queryOne<{cnt: number}>(
      'SELECT COUNT(*) as cnt FROM user_accounts',
    );
    const existingCount = Number(existingCountRow?.cnt || 0);

    if (existingCount > 0) {
      await ensureFixedAdmin();
      seeded = true;
      return;
    }

    const now = toMysqlDateTime();

    // Roles
    await executeSql(
      'INSERT IGNORE INTO roles (name, description) VALUES (?, ?)',
      ['SUPER_ADMIN', 'Full system authority including admin accounts, audit logs, and settings.'],
    );
    await executeSql(
      'INSERT IGNORE INTO roles (name, description) VALUES (?, ?)',
      ['ADMIN', 'Delegated verification officer with configurable module permissions.'],
    );
    await executeSql(
      'INSERT IGNORE INTO roles (name, description) VALUES (?, ?)',
      ['USER', 'Registered member eligible for credential verification.'],
    );

    // Permissions
    const perms: [string, string, string][] = [
      ['can_view_registrations', 'View Registrations', 'Inspect registration queue and identity documents'],
      ['can_approve_registrations', 'Approve & Reject', 'Approve, reject, or request resubmission on applications'],
      ['can_manage_qr', 'Manage QR Codes', 'Issue, regenerate, and revoke QR credentials'],
      ['can_scan_qr', 'Scan & Verify QR', 'Access live camera QR scanner and view holder verification photo'],
      ['can_export_excel', 'Export Excel', 'Export authorized records to Excel (.xlsx)'],
      ['can_manage_users', 'Manage Users', 'Activate, deactivate, or archive user accounts'],
    ];
    for (const p of perms) {
      await executeSql(
        'INSERT IGNORE INTO permissions (code, label, description) VALUES (?, ?, ?)',
        p,
      );
    }

    // System settings
    const defaultSettings: [string, string][] = [
      ['organization_name', 'Secure QR Verification Authority'],
      ['qr_validity_days', '365'],
      ['allow_multiple_active_qr', 'false'],
      ['otp_expiry_minutes', '5'],
      ['max_otp_attempts', '5'],
      ['id_proof_required', 'true'],
      ['verification_alert_enabled', 'true'],
    ];
    for (const [k, v] of defaultSettings) {
      await executeSql(
        'INSERT IGNORE INTO system_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
        [k, v, now],
      );
    }

    // Dynamic User Field Configs
    const fieldSeeds: unknown[][] = [
      ['organization', 'Organization / Employer', 'text', 1, 1, 1, '[]', 1],
      ['department', 'Department / Division', 'text', 0, 1, 1, '[]', 2],
      [
        'access_tier',
        'Credential Tier',
        'select',
        1,
        1,
        0,
        JSON.stringify(['Standard Member', 'Facility Contractor', 'Executive Pass', 'Visitor Escort']),
        3,
      ],
      ['emergency_contact', 'Emergency Contact Number', 'text', 0, 1, 1, '[]', 4],
    ];
    for (const f of fieldSeeds) {
      await executeSql(
        `INSERT IGNORE INTO user_field_configs
          (field_key, label, field_type, is_required, is_enabled, is_editable_on_resubmit, options_json, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        f,
      );
    }

    // Super Admin
    const superAdminRes = await executeSql(
      `INSERT INTO user_accounts
        (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 1, ?, ?)`,
      ['superadmin@secureqr.gov', '+15550100001', hashPassword('SuperAdmin@2026!'), now, now],
    );
    const superAdminId = Number(superAdminRes.insertId);

    await executeSql(
      `INSERT INTO admin_profiles
        (user_id, full_name, department, designation, avatar_url, permissions_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        superAdminId,
        'Eleanor Vance',
        'Governance & Trust Operations',
        'Chief Security Administrator',
        '/assets/images/avatar_admin_portrait_1794911291825.jpg',
        JSON.stringify(perms.map((p) => p[0])),
        superAdminId,
        now,
      ],
    );

    // Delegated Admin
    const verifierAdminRes = await executeSql(
      `INSERT INTO user_accounts
        (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'ADMIN', 1, 1, ?, ?)`,
      ['admin.verifier@secureqr.gov', '+15550100002', hashPassword('Verifier@2026!'), now, now],
    );
    const verifierAdminId = Number(verifierAdminRes.insertId);

    await executeSql(
      `INSERT INTO admin_profiles
        (user_id, full_name, department, designation, avatar_url, permissions_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
    );

    // Sample User 1: APPROVED with Active 256-bit QR Code
    const u1Res = await executeSql(
      `INSERT INTO user_accounts
        (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'USER', 1, 1, ?, ?)`,
      ['aarav.sharma@enterprise.org', '+15550101001', hashPassword('Member@2026!'), now, now],
    );
    const u1Id = Number(u1Res.insertId);
    const u1CreatedAt = toMysqlDateTime(Date.now() - 86400000 * 5);
    const u1RecRes = await executeSql(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'APPROVED', ?, ?, ?, ?)`,
      [
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
        u1CreatedAt,
        now,
      ],
    );
    const u1RecId = Number(u1RecRes.insertId);

    await executeSql(
      `INSERT INTO registration_requests
        (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
       VALUES (?, 'INITIAL', 'APPROVED', 'Identity and passport verified.', ?, ?, ?)`,
      [u1RecId, u1CreatedAt, superAdminId, now],
    );

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
    const expiresAt = toMysqlDateTime(Date.now() + 365 * 86400000);

    const qrRes = await executeSql(
      `INSERT INTO qr_codes
        (user_record_id, token_hash, token_prefix, verification_url, qr_png_data_url, status, issued_at, expires_at, issued_by, last_verified_at, scan_count)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 2)`,
      [u1RecId, tokenHash, tokenPrefix, verifyUrl, qrPngDataUrl, now, expiresAt, superAdminId, now],
    );

    await executeSql(
      `INSERT INTO qr_scan_logs
        (qr_code_id, user_record_id, scanned_by_admin_id, scanned_token_prefix, result_status, reason, ip_address, user_agent, scanned_at)
       VALUES (?, ?, ?, ?, 'VALID', 'Active credential verified at main lobby.', '127.0.0.1', 'Seed/Verifier', ?)`,
      [Number(qrRes.insertId), u1RecId, verifierAdminId, tokenPrefix, now],
    );

    // Sample User 2: PENDING
    const u2Res = await executeSql(
      `INSERT INTO user_accounts
        (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'USER', 1, 1, ?, ?)`,
      ['priya.nair@meridianlabs.io', '+15550101002', hashPassword('Member@2026!'), now, now],
    );
    const u2Id = Number(u2Res.insertId);
    const u2CreatedAt = toMysqlDateTime(Date.now() - 3600000 * 6);
    const u2RecRes = await executeSql(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'PENDING', ?, ?)`,
      [
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
        u2CreatedAt,
        now,
      ],
    );
    const u2RecId = Number(u2RecRes.insertId);
    await executeSql(
      `INSERT INTO registration_requests
        (user_record_id, request_type, status, notes, submitted_at)
       VALUES (?, 'INITIAL', 'PENDING', 'Awaiting Admin review.', ?)`,
      [u2RecId, u2CreatedAt],
    );

    // Sample User 3: PENDING
    const u3Res = await executeSql(
      `INSERT INTO user_accounts
        (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'USER', 1, 1, ?, ?)`,
      ['daniel.chen@northstar.co', '+15550101003', hashPassword('Member@2026!'), now, now],
    );
    const u3Id = Number(u3Res.insertId);
    const u3CreatedAt = toMysqlDateTime(Date.now() - 3600000 * 2);
    const u3RecRes = await executeSql(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'PENDING', ?, ?)`,
      [
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
        u3CreatedAt,
        now,
      ],
    );
    const u3RecId = Number(u3RecRes.insertId);
    await executeSql(
      `INSERT INTO registration_requests
        (user_record_id, request_type, status, notes, submitted_at)
       VALUES (?, 'INITIAL', 'PENDING', 'Awaiting Admin review.', ?)`,
      [u3RecId, u3CreatedAt],
    );

    // Sample User 4: RESUBMISSION_REQUIRED
    const u4Res = await executeSql(
      `INSERT INTO user_accounts
        (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'USER', 1, 1, ?, ?)`,
      ['sofia.rodriguez@civicgrid.org', '+15550101004', hashPassword('Member@2026!'), now, now],
    );
    const u4Id = Number(u4Res.insertId);
    const u4CreatedAt = toMysqlDateTime(Date.now() - 86400000 * 2);
    const u4RecRes = await executeSql(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, resubmission_note, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'RESUBMISSION_REQUIRED', ?, ?, ?, ?, ?)`,
      [
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
        u4CreatedAt,
        now,
      ],
    );
    const u4RecId = Number(u4RecRes.insertId);
    await executeSql(
      `INSERT INTO registration_requests
        (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
       VALUES (?, 'INITIAL', 'RESUBMISSION_REQUIRED', 'Address clarification requested.', ?, ?, ?)`,
      [u4RecId, u4CreatedAt, verifierAdminId, now],
    );

    // Sample User 5: REJECTED
    const u5Res = await executeSql(
      `INSERT INTO user_accounts
        (email, mobile, password_hash, role, is_active, is_mobile_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'USER', 1, 1, ?, ?)`,
      ['liam.okafor@example.net', '+15550101005', hashPassword('Member@2026!'), now, now],
    );
    const u5Id = Number(u5Res.insertId);
    const u5CreatedAt = toMysqlDateTime(Date.now() - 86400000 * 3);
    const u5RecRes = await executeSql(
      `INSERT INTO user_records
        (user_id, registration_id, full_name, dob, gender, address, city, district, state, country, postal_code,
         profile_photo_url, id_proof_type, id_proof_url, dynamic_fields_json, consent_accepted, consent_timestamp,
         approval_status, rejection_reason, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'REJECTED', ?, ?, ?, ?, ?)`,
      [
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
        u5CreatedAt,
        now,
      ],
    );
    const u5RecId = Number(u5RecRes.insertId);
    await executeSql(
      `INSERT INTO registration_requests
        (user_record_id, request_type, status, notes, submitted_at, processed_by, processed_at)
       VALUES (?, 'INITIAL', 'REJECTED', 'Expired ID document.', ?, ?, ?)`,
      [u5RecId, u5CreatedAt, superAdminId, now],
    );

    // Notifications
    const notifSql = `INSERT INTO notifications
      (recipient_user_id, recipient_role, type, title, message, link_path, metadata_json, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`;

    await executeSql(notifSql, [
      null,
      'ADMIN',
      'NEW_REGISTRATION',
      'New Registration Pending Review',
      'Priya Nair (SQR-2026-000102) submitted an application from Austin, Texas.',
      '/admin/registrations',
      JSON.stringify({userRecordId: u2RecId, registrationId: 'SQR-2026-000102'}),
      now,
    ]);
    await executeSql(notifSql, [
      null,
      'ADMIN',
      'NEW_REGISTRATION',
      'New Registration Pending Review',
      'Daniel Chen (SQR-2026-000103) submitted an application from Boston, Massachusetts.',
      '/admin/registrations',
      JSON.stringify({userRecordId: u3RecId, registrationId: 'SQR-2026-000103'}),
      now,
    ]);
    await executeSql(notifSql, [
      u1Id,
      null,
      'QR_GENERATED',
      'Credential Approved & QR Ready',
      'Your application (SQR-2026-000101) was approved and your active QR credential is ready.',
      '/user/qr-card',
      JSON.stringify({registrationId: 'SQR-2026-000101'}),
      now,
    ]);
    await executeSql(notifSql, [
      u4Id,
      null,
      'RESUBMISSION_REQUIRED',
      'Resubmission Requested',
      'Please update street address with suite number and re-upload a clear ID proof image.',
      '/user/profile',
      JSON.stringify({registrationId: 'SQR-2026-000104'}),
      now,
    ]);
    await executeSql(notifSql, [
      u5Id,
      null,
      'REGISTRATION_REJECTED',
      'Application Rejected',
      'Submitted government identification expired prior to application date.',
      '/user/home',
      JSON.stringify({registrationId: 'SQR-2026-000105'}),
      now,
    ]);

    // Initial Audit Log
    await executeSql(
      `INSERT INTO admin_activity_logs
        (actor_user_id, actor_email, actor_role, action, target_type, target_id, details_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        superAdminId,
        'superadmin@secureqr.gov',
        'SUPER_ADMIN',
        'SYSTEM_INITIALIZED',
        'SYSTEM',
        'bootstrap',
        JSON.stringify({seededUsers: 5, seededAdmins: 2}),
        '127.0.0.1',
        now,
      ],
    );

    await ensureFixedAdmin();
    seeded = true;
  })().catch((err) => {
    seedingPromise = null;
    throw err;
  });

  return seedingPromise;
}
