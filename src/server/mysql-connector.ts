import mysql from 'mysql2/promise';
import {ensureDbInitialized, getMysqlConfig, isMockDbActive, queryOne} from './db';

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
  const {host, port, user, password, database, ssl} = getMysqlConfig();

  if (!host || !user || isMockDbActive()) {
    const countRow = await queryOne<{cnt: number}>('SELECT COUNT(*) as cnt FROM user_accounts').catch(
      () => undefined,
    );
    return {
      configured: Boolean(host && user),
      connected: false,
      host: host || 'in-memory-mock',
      database,
      activeEngine:
        countRow !== undefined
          ? `in-memory-mock (${Number(countRow.cnt)} accounts)`
          : 'in-memory-mock',
    };
  }

  try {
    const conn = await mysql.createConnection({
      host,
      port,
      user,
      password,
      database,
      ...(ssl ? {ssl} : {}),
      connectTimeout: 8000,
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
          ? `mysql-rds-active (${Number(countRow.cnt)} accounts${ssl ? ', tls' : ''})`
          : `mysql-rds-connected${ssl ? ' (tls)' : ''}`,
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

  if (!host || isMockDbActive()) {
    await ensureDbInitialized();
    return {
      success: true,
      host: host || 'in-memory-mock',
      database,
      message: `In-memory mock database "${database}" initialized (connect Cloud SQL or MySQL RDS for persistent storage).`,
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
