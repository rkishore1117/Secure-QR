import mysql from 'mysql2/promise';

export interface MysqlHealthResult {
  configured: boolean;
  connected: boolean;
  host: string;
  database: string;
  activeEngine: string;
  error?: string;
}

export interface MysqlInitResult {
  success: boolean;
  host: string;
  database: string;
  message: string;
  error?: string;
}

function sanitizeDbName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '');
  return cleaned || 'secure_qr_verification';
}

export async function checkMysqlConnection(): Promise<MysqlHealthResult> {
  const host = process.env['DB_HOST'] || '';
  const port = Number.parseInt(process.env['DB_PORT'] || '3306', 10) || 3306;
  const user = process.env['DB_USER'] || '';
  const password = process.env['DB_PASSWORD'] || '';
  const database = sanitizeDbName(process.env['DB_NAME'] || 'secure_qr_verification');

  if (!host || !user) {
    return {
      configured: false,
      connected: false,
      host: 'not-configured',
      database,
      activeEngine: 'sqlite-local',
    };
  }

  try {
    const conn = await mysql.createConnection({
      host,
      port,
      user,
      password,
      database,
      connectTimeout: 3500,
    });
    await conn.ping();
    await conn.end();
    return {
      configured: true,
      connected: true,
      host,
      database,
      activeEngine: 'mysql-rds-connected',
    };
  } catch (err) {
    return {
      configured: true,
      connected: false,
      host,
      database,
      activeEngine: 'sqlite-local-fallback',
      error: err instanceof Error ? err.message : 'MySQL RDS connection failed',
    };
  }
}

export async function ensureMysqlDatabaseAndSchema(): Promise<MysqlInitResult> {
  const host = process.env['DB_HOST'] || '';
  const port = Number.parseInt(process.env['DB_PORT'] || '3306', 10) || 3306;
  const user = process.env['DB_USER'] || '';
  const password = process.env['DB_PASSWORD'] || '';
  const database = sanitizeDbName(process.env['DB_NAME'] || 'secure_qr_verification');

  if (!host || !user) {
    return {
      success: false,
      host: 'not-configured',
      database,
      message: 'MySQL RDS credentials are not configured.',
    };
  }

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host,
      port,
      user,
      password,
      connectTimeout: 4000,
      multipleStatements: true,
    });

    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    );
    await conn.query(`USE \`${database}\`;`);

    const ddlStatements = [
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
      `CREATE TABLE IF NOT EXISTS user_accounts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        mobile VARCHAR(20) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('SUPER_ADMIN', 'ADMIN', 'USER') NOT NULL DEFAULT 'USER',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        is_mobile_verified TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        deleted_at DATETIME(6) NULL
      ) ENGINE=InnoDB;`,
      `CREATE TABLE IF NOT EXISTS admin_profiles (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL UNIQUE,
        full_name VARCHAR(150) NOT NULL,
        department VARCHAR(120) NOT NULL,
        designation VARCHAR(120) NOT NULL,
        permissions_json JSON NOT NULL,
        created_by BIGINT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
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
        id_proof_type VARCHAR(64) NOT NULL,
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
        deleted_at DATETIME(6) NULL
      ) ENGINE=InnoDB;`,
      `CREATE TABLE IF NOT EXISTS registration_requests (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_record_id BIGINT NOT NULL,
        request_type ENUM('INITIAL', 'RESUBMISSION') NOT NULL DEFAULT 'INITIAL',
        status ENUM('PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED') NOT NULL,
        notes TEXT NULL,
        submitted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        processed_by BIGINT NULL,
        processed_at DATETIME(6) NULL
      ) ENGINE=InnoDB;`,
      `CREATE TABLE IF NOT EXISTS otp_verifications (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        mobile VARCHAR(20) NOT NULL,
        purpose VARCHAR(32) NOT NULL DEFAULT 'REGISTRATION',
        otp_hash CHAR(64) NOT NULL,
        expires_at DATETIME(6) NOT NULL,
        attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 5,
        verified_at DATETIME(6) NULL,
        used_at DATETIME(6) NULL,
        ip_address VARCHAR(45) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB;`,
      `CREATE TABLE IF NOT EXISTS qr_codes (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_record_id BIGINT NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        token_prefix VARCHAR(16) NOT NULL,
        verification_url TEXT NOT NULL,
        status ENUM('ACTIVE', 'EXPIRED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
        issued_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        expires_at DATETIME(6) NOT NULL,
        revoked_at DATETIME(6) NULL,
        revoked_by BIGINT NULL,
        revoke_reason TEXT NULL,
        issued_by BIGINT NULL,
        last_verified_at DATETIME(6) NULL,
        scan_count INT UNSIGNED NOT NULL DEFAULT 0
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
        scanned_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
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
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
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
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
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

    for (const stmt of ddlStatements) {
      await conn.query(stmt);
    }

    await conn.end();
    return {
      success: true,
      host,
      database,
      message: `Dedicated MySQL database "${database}" and all Secure QR tables verified on RDS.`,
    };
  } catch (err) {
    if (conn) {
      try {
        await conn.end();
      } catch {
        // ignore close error
      }
    }
    return {
      success: false,
      host,
      database,
      message: `Could not connect to RDS host to initialize "${database}".`,
      error: err instanceof Error ? err.message : 'MySQL initialization failed',
    };
  }
}
