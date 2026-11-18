import mysql from 'mysql2/promise';
import {ensureDbInitialized, getMysqlConfig, queryOne} from './db';

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

export async function checkMysqlConnection(): Promise<MysqlHealthResult> {
  const {host, port, user, password, database} = getMysqlConfig();

  if (!host || !user) {
    return {
      configured: false,
      connected: false,
      host: 'not-configured',
      database,
      activeEngine: 'mysql-not-configured',
    };
  }

  try {
    const conn = await mysql.createConnection({
      host,
      port,
      user,
      password,
      database,
      connectTimeout: 5000,
    });
    await conn.ping();
    await conn.end();
    const countRow = await queryOne<{cnt: number}>('SELECT COUNT(*) as cnt FROM user_accounts').catch(
      () => undefined,
    );
    return {
      configured: true,
      connected: true,
      host,
      database,
      activeEngine:
        countRow !== undefined
          ? `mysql-rds-active (${Number(countRow.cnt)} accounts)`
          : 'mysql-rds-connected',
    };
  } catch (err) {
    return {
      configured: true,
      connected: false,
      host,
      database,
      activeEngine: 'mysql-rds-unreachable',
      error: err instanceof Error ? err.message : 'MySQL RDS connection failed',
    };
  }
}

export async function ensureMysqlDatabaseAndSchema(): Promise<MysqlInitResult> {
  const {host, database} = getMysqlConfig();

  if (!host) {
    return {
      success: false,
      host: 'not-configured',
      database,
      message: 'MySQL RDS credentials are not configured.',
    };
  }

  try {
    await ensureDbInitialized();
    return {
      success: true,
      host,
      database,
      message: `Dedicated MySQL database "${database}" and all Secure QR tables verified on RDS.`,
    };
  } catch (err) {
    return {
      success: false,
      host,
      database,
      message: `Could not connect to RDS host to initialize "${database}".`,
      error: err instanceof Error ? err.message : 'MySQL initialization failed',
    };
  }
}
