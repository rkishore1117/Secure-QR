import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import {hashPassword} from './crypto';
import {
  mockExecuteSql,
  mockQueryRows,
  mockResetAndInit,
} from './mock-db';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RUNTIME_CONFIG_PATH = path.join(DATA_DIR, 'runtime-config.json');
let runtimeOverridesCache: Record<string, string> | null = null;

function loadRuntimeOverrides(): Record<string, string> {
  if (runtimeOverridesCache) return runtimeOverridesCache;
  try {
    if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.trim()) {
            clean[k] = stripSurroundingQuotes(v);
          }
        }
        runtimeOverridesCache = clean;
        return clean;
      }
    }
  } catch {
    // ignore invalid runtime-config.json
  }
  runtimeOverridesCache = {};
  return runtimeOverridesCache;
}

function saveRuntimeOverrides(updates: Record<string, string>): void {
  const current = {...loadRuntimeOverrides()};
  for (const [k, v] of Object.entries(updates)) {
    const clean = stripSurroundingQuotes(v);
    if (clean) {
      current[k] = clean;
    } else if (v === '') {
      delete current[k];
    }
  }
  runtimeOverridesCache = current;
  if (!process.env['VITEST']) {
    try {
      fs.mkdirSync(DATA_DIR, {recursive: true});
      fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(current, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      // keep in-memory overrides if disk write fails on read-only FS
    }
  }
}

export function isPlaceholderEnvValue(val: string | undefined): boolean {
  if (!val) return false;
  const trimmed = val.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return false;
  return /^(replace[-_]with|your[-_]|changeme$|example$|MY_)/i.test(trimmed);
}

function parseDotEnvFile(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');
  const parsed: Record<string, string> = {};
  try {
    if (!fs.existsSync(envPath)) return parsed;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      parsed[key] = val;
    }
  } catch {
    // ignore .env read failures
  }
  return parsed;
}

function stripSurroundingQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function getEnvValue(key: string): string {
  const procRaw = process.env[key];
  const procClean = procRaw !== undefined ? stripSurroundingQuotes(procRaw) : undefined;
  const procVal =
    procClean !== undefined && !isPlaceholderEnvValue(procClean) ? procClean : undefined;

  if (process.env['VITEST']) {
    if (key in process.env) {
      return procVal ?? '';
    }
    const rt = runtimeOverridesCache?.[key];
    if (rt && !isPlaceholderEnvValue(rt)) return rt;
    return '';
  }

  const dotEnv = parseDotEnvFile();
  const fileRaw = dotEnv[key];
  const fileClean = fileRaw !== undefined ? stripSurroundingQuotes(fileRaw) : undefined;
  const fileVal =
    fileClean !== undefined && !isPlaceholderEnvValue(fileClean) ? fileClean : undefined;

  if (fileVal) return fileVal;
  if (procVal) return procVal;

  const runtimeVal = loadRuntimeOverrides()[key];
  if (runtimeVal && !isPlaceholderEnvValue(runtimeVal)) {
    return runtimeVal;
  }
  return '';
}

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

export function getMysqlSslOptions(): mysql.SslOptions | undefined {
  const sslSetting = getEnvValue('DB_SSL').toLowerCase();
  const host = getEnvValue('DB_HOST').toLowerCase();
  if (sslSetting === 'false' || sslSetting === '0') {
    return undefined;
  }
  const caPath = getEnvValue('DB_SSL_CA');
  if (caPath && fs.existsSync(caPath)) {
    return {
      ca: fs.readFileSync(caPath, 'utf8'),
      rejectUnauthorized: getEnvValue('DB_SSL_REJECT_UNAUTHORIZED').toLowerCase() !== 'false',
    };
  }
  if (sslSetting === 'true' || sslSetting === '1' || host.includes('.rds.amazonaws.com')) {
    return {
      rejectUnauthorized: getEnvValue('DB_SSL_REJECT_UNAUTHORIZED').toLowerCase() === 'true',
    };
  }
  return undefined;
}

export function isStrictLiveDbRequired(): boolean {
  if (process.env['VITEST']) return false;
  return (
    getEnvValue('REQUIRE_LIVE_DB').toLowerCase() === 'true' ||
    getEnvValue('STRICT_PRODUCTION_CONFIG').toLowerCase() === 'true' ||
    Boolean(process.env['RENDER'] || process.env['RENDER_SERVICE_ID'])
  );
}

export function getMysqlConfig() {
  loadEnvSafe();
  const host = getEnvValue('DB_HOST');
  const port = Number.parseInt(getEnvValue('DB_PORT') || '3306', 10) || 3306;
  const user = getEnvValue('DB_USER');
  const password = getEnvValue('DB_PASSWORD');
  const database = sanitizeDbName(getEnvValue('DB_NAME') || 'secure_qr_verification');
  const ssl = getMysqlSslOptions();
  return {host, port, user, password, database, ssl};
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
let mockMode = false;

export function isMockDbActive(): boolean {
  return mockMode;
}

function activateMockMode(reason: string): void {
  if (!mockMode) {
    console.warn(`[AI Studio] ${reason} — activating in-memory mock database.`);
    mockMode = true;
    mockResetAndInit();
  }
}

export function getPool(): mysql.Pool {
  if (poolInstance) return poolInstance;
  const cfg = getMysqlConfig();
  if (!cfg.host || !cfg.user) {
    if (isStrictLiveDbRequired()) {
      throw new Error(
        'Missing required AWS RDS MySQL environment variables (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME).',
      );
    }
    activateMockMode('MySQL RDS credentials not configured');
    return {
      query: async () => [[], []],
      getConnection: async () => {
        throw new Error('Mock mode active');
      },
    } as unknown as mysql.Pool;
  }
  poolInstance = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ...(cfg.ssl ? {ssl: cfg.ssl} : {}),
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
  if (mockMode) {
    return mockQueryRows<T>(sql, params);
  }
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
  if (mockMode) {
    return mockExecuteSql(sql, params);
  }
  const [res] = await getPool().query(sql, params);
  return res as mysql.ResultSetHeader;
}

export interface TxClient {
  queryRows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  executeSql(sql: string, params?: unknown[]): Promise<mysql.ResultSetHeader>;
}

export async function withTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  if (mockMode) {
    const tx: TxClient = {
      async queryRows<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
        return mockQueryRows<R>(sql, params);
      },
      async queryOne<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R | undefined> {
        return mockQueryRows<R>(sql, params)[0];
      },
      async executeSql(sql: string, params: unknown[] = []): Promise<mysql.ResultSetHeader> {
        return mockExecuteSql(sql, params);
      },
    };
    return fn(tx);
  }

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
      if (isStrictLiveDbRequired()) {
        throw new Error(
          'Live AWS RDS MySQL credentials (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME) are missing in production environment variables.',
        );
      }
      activateMockMode('MySQL RDS credentials not configured');
      return;
    }

    let bootstrapConn: mysql.Connection;
    let connectedToDatabaseDirectly = false;
    try {
      bootstrapConn = await mysql.createConnection({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        ...(cfg.ssl ? {ssl: cfg.ssl} : {}),
        connectTimeout: 8000,
        multipleStatements: true,
      });
      connectedToDatabaseDirectly = true;
    } catch (directErr) {
      const code = (directErr as {code?: string})?.code;
      if (code === 'ER_BAD_DB_ERROR') {
        try {
          bootstrapConn = await mysql.createConnection({
            host: cfg.host,
            port: cfg.port,
            user: cfg.user,
            password: cfg.password,
            ...(cfg.ssl ? {ssl: cfg.ssl} : {}),
            connectTimeout: 8000,
            multipleStatements: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unreachable';
          if (isStrictLiveDbRequired() || (process.env['NODE_ENV'] === 'production' && !process.env['K_SERVICE'])) {
            throw new Error(`AWS RDS MySQL connection failed (${msg})`);
          }
          activateMockMode(`MySQL connection failed (${msg})`);
          return;
        }
      } else {
        const msg = directErr instanceof Error ? directErr.message : 'unreachable';
        if (isStrictLiveDbRequired() || (process.env['NODE_ENV'] === 'production' && !process.env['K_SERVICE'])) {
          throw new Error(`AWS RDS MySQL connection failed (${msg})`);
        }
        activateMockMode(`MySQL connection failed (${msg})`);
        return;
      }
    }

    try {
      const statements: string[] = [];
      if (!connectedToDatabaseDirectly) {
        statements.push(
          `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
          `USE \`${cfg.database}\`;`,
        );
      }
      statements.push(...MYSQL_DDL_STATEMENTS);
      await bootstrapConn.query(statements.join('\n'));

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

export async function ensureFixedAdmin(): Promise<void> {
  loadEnvSafe();
  const fixedEmail = (getEnvValue('FIXED_ADMIN_EMAIL') || 'kishore.sathayush@gmail.com')
    .trim()
    .toLowerCase();
  const envPassword = getEnvValue('FIXED_ADMIN_PASSWORD');
  if (!fixedEmail) {
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
    if (envPassword) {
      await executeSql(
        `UPDATE user_accounts
         SET password_hash = ?, role = 'SUPER_ADMIN', is_active = 1, is_mobile_verified = 1, is_email_verified = 1, updated_at = ?
         WHERE id = ?`,
        [hashPassword(envPassword), now, adminId],
      );
    } else {
      await executeSql(
        `UPDATE user_accounts
         SET role = 'SUPER_ADMIN', is_active = 1, is_mobile_verified = 1, is_email_verified = 1, updated_at = ?
         WHERE id = ?`,
        [now, adminId],
      );
    }
  } else {
    const initialPassword = envPassword || 'Admin@955';
    const mobileCandidate = getEnvValue('FIXED_ADMIN_MOBILE') || '+919550000955';
    const res = await executeSql(
      `INSERT INTO user_accounts
        (email, mobile, password_hash, role, is_active, is_mobile_verified, is_email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 1, 1, ?, ?)`,
      [fixedEmail, mobileCandidate, hashPassword(initialPassword), now, now],
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

export async function ensureSeeded(_baseUrl = 'http://localhost:3000'): Promise<void> {
  void _baseUrl;
  if (seeded) return;
  if (seedingPromise) return seedingPromise;

  seedingPromise = (async () => {
    await ensureDbInitialized();

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

    // Default System Settings (never overwrite existing admin-saved settings)
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

    // Seed default dynamic registration fields only if table is empty
    const fieldCountRow = await queryOne<{cnt: number}>(
      'SELECT COUNT(*) as cnt FROM user_field_configs',
    );
    if (Number(fieldCountRow?.cnt || 0) === 0) {
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
    }

    // Always ensure only the fixed Super Admin exists (no fake sample users or dummy admins)
    await ensureFixedAdmin();
    seeded = true;
  })().catch((err) => {
    seedingPromise = null;
    throw err;
  });

  return seedingPromise;
}

export interface LiveMysqlRuntimeInput {
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  ssl?: boolean;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
  awsBucket?: string;
  filePath?: string;
}

export async function connectLiveMysqlRuntime(input: LiveMysqlRuntimeInput): Promise<{
  success: boolean;
  host: string;
  database: string;
  message: string;
  error?: string;
}> {
  const host = stripSurroundingQuotes(input.host || '');
  const port = Number(input.port) || 3306;
  const user = stripSurroundingQuotes(input.user || '');
  const password = stripSurroundingQuotes(input.password || '') || getEnvValue('DB_PASSWORD');
  const database = sanitizeDbName(
    stripSurroundingQuotes(input.database || '') || 'secure_qr_verification',
  );
  const useSsl = input.ssl !== false;

  if (!host || !user || !password) {
    return {
      success: false,
      host,
      database,
      message: 'DB Host, DB User, and DB Password are required.',
      error: 'DB Host, DB User, and DB Password are required.',
    };
  }

  const sslOpts: mysql.SslOptions | undefined =
    useSsl || host.toLowerCase().includes('.rds.amazonaws.com')
      ? {rejectUnauthorized: false}
      : undefined;

  let testConn: mysql.Connection | null = null;
  try {
    try {
      testConn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        database,
        ...(sslOpts ? {ssl: sslOpts} : {}),
        connectTimeout: 8000,
      });
      await testConn.ping();
    } catch (err) {
      const code = (err as {code?: string})?.code;
      if (code === 'ER_BAD_DB_ERROR') {
        testConn = await mysql.createConnection({
          host,
          port,
          user,
          password,
          ...(sslOpts ? {ssl: sslOpts} : {}),
          connectTimeout: 8000,
        });
        await testConn.ping();
      } else {
        throw err;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to reach AWS RDS MySQL host.';
    return {
      success: false,
      host,
      database,
      message: `Could not connect to AWS RDS MySQL (${msg}).`,
      error: msg,
    };
  } finally {
    if (testConn) {
      try {
        await testConn.end();
      } catch {
        // ignore connection close errors
      }
    }
  }

  const updates: Record<string, string> = {
    DB_HOST: host,
    DB_PORT: String(port),
    DB_USER: user,
    DB_PASSWORD: password,
    DB_NAME: database,
    DB_SSL: useSsl ? 'true' : 'false',
  };

  if (input.awsAccessKeyId?.trim()) updates['AWS_ACCESS_KEY_ID'] = input.awsAccessKeyId.trim();
  if (input.awsSecretAccessKey?.trim()) {
    updates['AWS_SECRET_ACCESS_KEY'] = input.awsSecretAccessKey.trim();
  }
  if (input.awsRegion?.trim()) updates['AWS_S3_REGION_NAME'] = input.awsRegion.trim();
  if (input.awsBucket?.trim()) updates['AWS_STORAGE_BUCKET_NAME'] = input.awsBucket.trim();
  if (input.filePath?.trim()) updates['FILE_PATH'] = input.filePath.trim();

  saveRuntimeOverrides(updates);

  if (poolInstance) {
    try {
      await poolInstance.end();
    } catch {
      // ignore pool close errors
    }
    poolInstance = null;
  }
  mockMode = false;
  initPromise = null;
  seeded = false;
  seedingPromise = null;

  await ensureSeeded(getEnvValue('APP_URL') || 'http://localhost:3000');

  return {
    success: true,
    host,
    database,
    message: `Connected to live AWS RDS MySQL (${host} / ${database}) and synchronized schema.`,
  };
}
