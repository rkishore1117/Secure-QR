import type {ResultSetHeader} from 'mysql2/promise';

type Row = Record<string, unknown>;

interface TableStore {
  rows: Row[];
  autoIncrement: number;
}

const TABLES_WITH_PK_KEY = new Set(['system_settings']);
const TABLES_WITHOUT_ID = new Set(['role_permissions', 'system_settings']);

const ALL_TABLES = [
  'roles',
  'permissions',
  'role_permissions',
  'user_accounts',
  'admin_profiles',
  'user_records',
  'registration_requests',
  'otp_verifications',
  'qr_codes',
  'qr_scan_logs',
  'notifications',
  'admin_activity_logs',
  'user_field_configs',
  'export_history',
  'system_settings',
  'refresh_tokens',
  'scheduled_report_logs',
];

const tables = new Map<string, TableStore>();

function resetTables(): void {
  tables.clear();
  for (const name of ALL_TABLES) {
    tables.set(name, {rows: [], autoIncrement: 1});
  }
}

resetTables();

function getTable(name: string): TableStore {
  const clean = name.replace(/`/g, '').trim();
  let store = tables.get(clean);
  if (!store) {
    store = {rows: [], autoIncrement: 1};
    tables.set(clean, store);
  }
  return store;
}

function normalizeSqlWhitespace(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function isMysqlDateTimeString(val: unknown): val is string {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(val);
}

function parseMysqlDateTimeToDate(val: string): Date {
  return new Date(`${val.replace(' ', 'T')}Z`);
}

function normalizeStoredValue(colName: string, val: unknown): unknown {
  if (val === undefined) return null;
  if (val instanceof Date) return val;
  if (
    isMysqlDateTimeString(val) &&
    (colName.endsWith('_at') ||
      colName === 'consent_timestamp' ||
      colName === 'expires_at' ||
      colName === 'verified_at' ||
      colName === 'used_at' ||
      colName === 'read_at')
  ) {
    return parseMysqlDateTimeToDate(val);
  }
  return val;
}

function toComparableValue(val: unknown): number | string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.getTime();
  if (isMysqlDateTimeString(val)) return parseMysqlDateTimeToDate(val).getTime();
  if (typeof val === 'number') return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  return String(val);
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;
  let inBacktick = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const prev = i > 0 ? input[i - 1] : '';
    if (ch === "'" && !inBacktick && prev !== '\\') {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (ch === '`' && !inSingleQuote) {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }
    if (!inSingleQuote && !inBacktick) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitTopLevelLogical(expr: string, operator: 'AND' | 'OR'): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;
  const upper = expr.toUpperCase();
  const token = ` ${operator} `;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    const prev = i > 0 ? expr[i - 1] : '';
    if (ch === "'" && prev !== '\\') {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (!inSingleQuote) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && upper.startsWith(token, i)) {
        parts.push(current.trim());
        current = '';
        i += token.length - 1;
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function unquoteLiteral(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'");
  }
  return trimmed;
}

interface ParamCursor {
  params: unknown[];
  idx: number;
}

function bindQuestionMarks(expr: string, cursor: ParamCursor): {
  resolvedExpr: string;
  values: unknown[];
} {
  const values: unknown[] = [];
  let out = '';
  let inSingleQuote = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    const prev = i > 0 ? expr[i - 1] : '';
    if (ch === "'" && prev !== '\\') {
      inSingleQuote = !inSingleQuote;
      out += ch;
      continue;
    }
    if (!inSingleQuote && ch === '?') {
      const paramIndex = values.length;
      values.push(cursor.params[cursor.idx++]);
      out += `__PARAM_${paramIndex}__`;
      continue;
    }
    out += ch;
  }
  return {resolvedExpr: out, values};
}

function resolveColumnValue(row: Row, rawCol: string): unknown {
  const cleaned = rawCol.replace(/`/g, '').trim();
  if (cleaned in row) return row[cleaned];
  if (cleaned.includes('.')) {
    const [alias, col] = cleaned.split('.', 2);
    const qualified = `${alias}.${col}`;
    if (qualified in row) return row[qualified];
    if (col in row) return row[col];
  }
  return undefined;
}

function evaluateValueExpr(expr: string, row: Row, boundValues: unknown[]): unknown {
  const trimmed = expr.trim();
  const paramMatch = /^__PARAM_(\d+)__$/.exec(trimmed);
  if (paramMatch) {
    return boundValues[Number(paramMatch[1])];
  }
  if (/^NULL$/i.test(trimmed)) return null;
  if (/^CURRENT_TIMESTAMP(?:\(\d+\))?$/i.test(trimmed)) return new Date();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return unquoteLiteral(trimmed);
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  const lowerMatch = /^LOWER\((.+)\)$/i.exec(trimmed);
  if (lowerMatch) {
    const inner = evaluateValueExpr(lowerMatch[1], row, boundValues);
    return inner === null || inner === undefined ? null : String(inner).toLowerCase();
  }
  return resolveColumnValue(row, trimmed);
}

function evaluateWhere(resolvedExpr: string, row: Row, boundValues: unknown[]): boolean {
  let expr = resolvedExpr.trim();
  if (!expr) return true;

  // Strip outer balanced parentheses if the entire expression is wrapped
  while (expr.startsWith('(') && expr.endsWith(')')) {
    let depth = 0;
    let inQuote = false;
    let wrapsAll = true;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      const prev = i > 0 ? expr[i - 1] : '';
      if (ch === "'" && prev !== '\\') inQuote = !inQuote;
      if (!inQuote) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        if (depth === 0 && i < expr.length - 1) {
          wrapsAll = false;
          break;
        }
      }
    }
    if (wrapsAll) {
      expr = expr.slice(1, -1).trim();
    } else {
      break;
    }
  }

  const orParts = splitTopLevelLogical(expr, 'OR');
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateWhere(part, row, boundValues));
  }

  const andParts = splitTopLevelLogical(expr, 'AND');
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateWhere(part, row, boundValues));
  }

  const isNullMatch = /^(.+?)\s+IS\s+NULL$/i.exec(expr);
  if (isNullMatch) {
    const v = evaluateValueExpr(isNullMatch[1], row, boundValues);
    return v === null || v === undefined;
  }

  const isNotNullMatch = /^(.+?)\s+IS\s+NOT\s+NULL$/i.exec(expr);
  if (isNotNullMatch) {
    const v = evaluateValueExpr(isNotNullMatch[1], row, boundValues);
    return v !== null && v !== undefined;
  }

  const inMatch = /^(.+?)\s+IN\s*\((.+)\)$/i.exec(expr);
  if (inMatch) {
    const left = evaluateValueExpr(inMatch[1], row, boundValues);
    const items = splitTopLevelCommas(inMatch[2]).map((i) =>
      evaluateValueExpr(i, row, boundValues),
    );
    return items.some((item) => item === left);
  }

  const likeMatch = /^(.+?)\s+LIKE\s+(.+)$/i.exec(expr);
  if (likeMatch) {
    const left = evaluateValueExpr(likeMatch[1], row, boundValues);
    const pattern = String(evaluateValueExpr(likeMatch[2], row, boundValues) ?? '');
    if (left === null || left === undefined) return false;
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(String(left));
  }

  const cmpMatch = /^(.+?)\s*(<=|>=|<>|!=|=|<|>)\s*(.+)$/.exec(expr);
  if (cmpMatch) {
    const leftRaw = evaluateValueExpr(cmpMatch[1], row, boundValues);
    const op = cmpMatch[2];
    const rightRaw = evaluateValueExpr(cmpMatch[3], row, boundValues);

    if (leftRaw === null || leftRaw === undefined || rightRaw === null || rightRaw === undefined) {
      return false;
    }

    const left = toComparableValue(leftRaw);
    const right = toComparableValue(rightRaw);
    if (left === null || right === null) return false;

    if (op === '=') return String(left) === String(right) || left === right;
    if (op === '!=' || op === '<>') return String(left) !== String(right) && left !== right;
    if (op === '<') return left < right;
    if (op === '<=') return left <= right;
    if (op === '>') return left > right;
    if (op === '>=') return left >= right;
  }

  return Boolean(evaluateValueExpr(expr, row, boundValues));
}

function buildResultSetHeader(affectedRows = 0, insertId = 0): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows,
    insertId,
    info: '',
    serverStatus: 2,
    warningStatus: 0,
    changedRows: affectedRows,
  } as ResultSetHeader;
}

function handleInsert(sql: string, params: unknown[]): ResultSetHeader {
  const match =
    /^INSERT\s+(IGNORE\s+)?INTO\s+`?([a-zA-Z0-9_]+)`?\s*\(([^)]+)\)\s*VALUES\s*\((.+?)\)(?:\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\s+(.+))?$/i.exec(
      sql,
    );
  if (!match) {
    throw new Error(`Unsupported INSERT SQL in mock DB: ${sql}`);
  }

  const ignore = Boolean(match[1]);
  const tableName = match[2];
  const columns = splitTopLevelCommas(match[3]).map((c) => c.replace(/`/g, '').trim());
  const valueTokens = splitTopLevelCommas(match[4]);
  const onDupClause = match[5] || '';
  const store = getTable(tableName);

  const cursor: ParamCursor = {params, idx: 0};
  const newRow: Row = {};
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const rawVal = valueTokens[i] ?? 'NULL';
    const bound = bindQuestionMarks(rawVal, cursor);
    const evaluated = evaluateValueExpr(bound.resolvedExpr, {}, bound.values);
    newRow[col] = normalizeStoredValue(col, evaluated);
  }

  // Fill defaults expected by tables
  if (tableName === 'user_accounts') {
    if (newRow['is_active'] === undefined) newRow['is_active'] = 1;
    if (newRow['is_mobile_verified'] === undefined) newRow['is_mobile_verified'] = 0;
    if (newRow['is_email_verified'] === undefined) newRow['is_email_verified'] = 0;
    if (newRow['deleted_at'] === undefined) newRow['deleted_at'] = null;
  }
  if (tableName === 'admin_profiles' && newRow['avatar_url'] === undefined) {
    newRow['avatar_url'] = '/assets/images/avatar_admin_portrait_1794911291825.jpg';
  }
  if (tableName === 'user_records') {
    if (newRow['deleted_at'] === undefined) newRow['deleted_at'] = null;
    if (newRow['rejection_reason'] === undefined) newRow['rejection_reason'] = null;
    if (newRow['resubmission_note'] === undefined) newRow['resubmission_note'] = null;
    if (newRow['reviewed_by'] === undefined) newRow['reviewed_by'] = null;
    if (newRow['reviewed_at'] === undefined) newRow['reviewed_at'] = null;
  }
  if (tableName === 'qr_codes') {
    if (newRow['scan_count'] === undefined) newRow['scan_count'] = 0;
    if (newRow['last_verified_at'] === undefined) newRow['last_verified_at'] = null;
    if (newRow['revoked_at'] === undefined) newRow['revoked_at'] = null;
    if (newRow['revoked_by'] === undefined) newRow['revoked_by'] = null;
    if (newRow['revoke_reason'] === undefined) newRow['revoke_reason'] = null;
  }
  if (tableName === 'otp_verifications') {
    if (newRow['verified_at'] === undefined) newRow['verified_at'] = null;
    if (newRow['used_at'] === undefined) newRow['used_at'] = null;
  }
  if (tableName === 'refresh_tokens') {
    if (newRow['revoked_at'] === undefined) newRow['revoked_at'] = null;
  }
  if (tableName === 'notifications') {
    if (newRow['read_at'] === undefined) newRow['read_at'] = null;
  }

  // Unique / Duplicate key check
  const uniqueKeysByTable: Record<string, string[]> = {
    roles: ['name'],
    permissions: ['code'],
    system_settings: ['key'],
    user_field_configs: ['field_key'],
    user_accounts: ['email', 'mobile'],
    qr_codes: ['token_hash'],
  };
  const uniqueCols = uniqueKeysByTable[tableName] || [];
  const dupRow = store.rows.find((existing) =>
    uniqueCols.some(
      (col) =>
        newRow[col] !== null &&
        newRow[col] !== undefined &&
        String(existing[col] ?? '').toLowerCase() === String(newRow[col]).toLowerCase(),
    ),
  );

  if (dupRow) {
    if (onDupClause) {
      const assignments = splitTopLevelCommas(onDupClause);
      for (const assign of assignments) {
        const eqIdx = assign.indexOf('=');
        if (eqIdx === -1) continue;
        const targetCol = assign.slice(0, eqIdx).replace(/`/g, '').trim();
        const rhs = assign.slice(eqIdx + 1).trim();
        const valuesFn = /^VALUES\(`?([a-zA-Z0-9_]+)`?\)$/i.exec(rhs);
        if (valuesFn) {
          dupRow[targetCol] = newRow[valuesFn[1]];
        }
      }
      return buildResultSetHeader(1, 0);
    }
    if (ignore) {
      return buildResultSetHeader(0, 0);
    }
    throw new Error(`Duplicate entry in ${tableName}`);
  }

  let insertId = 0;
  if (!TABLES_WITHOUT_ID.has(tableName) && !TABLES_WITH_PK_KEY.has(tableName)) {
    insertId = store.autoIncrement++;
    newRow['id'] = insertId;
  }

  store.rows.push(newRow);
  return buildResultSetHeader(1, insertId);
}

function handleUpdate(sql: string, params: unknown[]): ResultSetHeader {
  const match = /^UPDATE\s+`?([a-zA-Z0-9_]+)`?\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i.exec(sql);
  if (!match) {
    throw new Error(`Unsupported UPDATE SQL in mock DB: ${sql}`);
  }

  const tableName = match[1];
  const setClause = match[2];
  const whereClause = match[3] || '';
  const store = getTable(tableName);

  const cursor: ParamCursor = {params, idx: 0};
  const assignments = splitTopLevelCommas(setClause).map((assign) => {
    const eqIdx = assign.indexOf('=');
    const col = assign.slice(0, eqIdx).replace(/`/g, '').trim();
    const rhsRaw = assign.slice(eqIdx + 1).trim();
    const bound = bindQuestionMarks(rhsRaw, cursor);
    return {col, rhs: bound.resolvedExpr, values: bound.values};
  });

  const whereBound = whereClause
    ? bindQuestionMarks(whereClause, cursor)
    : {resolvedExpr: '', values: []};

  let affected = 0;
  for (const row of store.rows) {
    if (whereBound.resolvedExpr && !evaluateWhere(whereBound.resolvedExpr, row, whereBound.values)) {
      continue;
    }
    for (const a of assignments) {
      const incMatch = /^`?([a-zA-Z0-9_]+)`?\s*\+\s*(\d+)$/.exec(a.rhs);
      if (incMatch) {
        row[a.col] = Number(row[incMatch[1]] || 0) + Number(incMatch[2]);
      } else {
        const val = evaluateValueExpr(a.rhs, row, a.values);
        row[a.col] = normalizeStoredValue(a.col, val);
      }
    }
    affected += 1;
  }

  return buildResultSetHeader(affected, 0);
}

function handleDelete(sql: string, params: unknown[]): ResultSetHeader {
  const match = /^DELETE\s+FROM\s+`?([a-zA-Z0-9_]+)`?(?:\s+WHERE\s+(.+))?$/i.exec(sql);
  if (!match) {
    throw new Error(`Unsupported DELETE SQL in mock DB: ${sql}`);
  }
  const tableName = match[1];
  const whereClause = match[2] || '';
  const store = getTable(tableName);
  const whereBound = whereClause
    ? bindQuestionMarks(whereClause, {params, idx: 0})
    : {resolvedExpr: '', values: []};

  const before = store.rows.length;
  if (!whereBound.resolvedExpr) {
    store.rows = [];
  } else {
    store.rows = store.rows.filter(
      (row) => !evaluateWhere(whereBound.resolvedExpr, row, whereBound.values),
    );
  }
  return buildResultSetHeader(before - store.rows.length, 0);
}

interface JoinClause {
  type: 'INNER' | 'LEFT';
  table: string;
  alias: string;
  leftExpr: string;
  rightExpr: string;
}

function parseFromAndJoins(fromSegment: string): {
  baseTable: string;
  baseAlias: string;
  joins: JoinClause[];
} {
  // Split at JOIN / LEFT JOIN / INNER JOIN
  const joinRegex = /\b(LEFT\s+JOIN|INNER\s+JOIN|JOIN)\b/gi;
  const matches = [...fromSegment.matchAll(joinRegex)];

  const basePart = matches.length > 0 ? fromSegment.slice(0, matches[0].index).trim() : fromSegment.trim();
  const baseTokens = basePart.split(/\s+/);
  const baseTable = baseTokens[0].replace(/`/g, '');
  const baseAlias = (baseTokens[1] || baseTable).replace(/`/g, '');

  const joins: JoinClause[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : fromSegment.length;
    const chunk = fromSegment.slice(start, end).trim();
    const onMatch = /^`?([a-zA-Z0-9_]+)`?(?:\s+`?([a-zA-Z0-9_]+)`?)?\s+ON\s+(.+)$/i.exec(chunk);
    if (!onMatch) {
      throw new Error(`Unsupported JOIN clause in mock DB: ${chunk}`);
    }
    const table = onMatch[1];
    const alias = onMatch[2] || table;
    const [leftExpr, rightExpr] = onMatch[3].split('=').map((s) => s.trim());
    joins.push({
      type: m[1].toUpperCase().startsWith('LEFT') ? 'LEFT' : 'INNER',
      table,
      alias,
      leftExpr,
      rightExpr,
    });
  }

  return {baseTable, baseAlias, joins};
}

function buildJoinedRows(
  baseTable: string,
  baseAlias: string,
  joins: JoinClause[],
): Row[] {
  const baseRows = getTable(baseTable).rows;
  let combined: Row[] = baseRows.map((r) => {
    const entry: Row = {...r};
    for (const [k, v] of Object.entries(r)) {
      entry[`${baseAlias}.${k}`] = v;
    }
    return entry;
  });

  for (const j of joins) {
    const joinRows = getTable(j.table).rows;
    const nextCombined: Row[] = [];
    for (const leftRow of combined) {
      const matched = joinRows.filter((jr) => {
        const candidate: Row = {...leftRow};
        for (const [k, v] of Object.entries(jr)) {
          candidate[`${j.alias}.${k}`] = v;
        }
        const lVal = resolveColumnValue(candidate, j.leftExpr);
        const rVal = resolveColumnValue(candidate, j.rightExpr);
        return lVal !== null && lVal !== undefined && lVal === rVal;
      });

      if (matched.length > 0) {
        for (const jr of matched) {
          const merged: Row = {...leftRow};
          for (const [k, v] of Object.entries(jr)) {
            if (!(k in merged)) merged[k] = v;
            merged[`${j.alias}.${k}`] = v;
          }
          nextCombined.push(merged);
        }
      } else if (j.type === 'LEFT') {
        nextCombined.push({...leftRow});
      }
    }
    combined = nextCombined;
  }

  return combined;
}

function findTopLevelKeywordIndex(sql: string, keyword: string, startFrom = 0): number {
  const upper = sql.toUpperCase();
  const len = keyword.length;
  let depth = 0;
  let inQuote = false;
  let inBacktick = false;

  for (let i = startFrom; i < sql.length; i++) {
    const ch = sql[i];
    const prev = i > 0 ? sql[i - 1] : '';
    if (ch === "'" && !inBacktick && prev !== '\\') inQuote = !inQuote;
    else if (ch === '`' && !inQuote) inBacktick = !inBacktick;
    else if (!inQuote && !inBacktick) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && upper.startsWith(keyword, i)) {
        const beforeOk = i === 0 || /\s/.test(sql[i - 1]);
        const afterOk = i + len >= sql.length || /\s/.test(sql[i + len]);
        if (beforeOk && afterOk) return i;
      }
    }
  }
  return -1;
}

function handleSelect(sql: string, params: unknown[]): Row[] {
  const trimmed = sql.trim();
  const fromIdx = findTopLevelKeywordIndex(trimmed, 'FROM', 6);
  if (fromIdx === -1) {
    throw new Error(`Unsupported SELECT SQL in mock DB: ${sql}`);
  }

  let selectClause = trimmed.slice(6, fromIdx).trim();
  let isDistinct = false;
  if (/^DISTINCT\s+/i.test(selectClause)) {
    isDistinct = true;
    selectClause = selectClause.replace(/^DISTINCT\s+/i, '').trim();
  }

  const afterFrom = trimmed.slice(fromIdx + 4).trim();
  const whereIdx = findTopLevelKeywordIndex(afterFrom, 'WHERE');
  const orderIdx = findTopLevelKeywordIndex(afterFrom, 'ORDER BY');
  const limitIdx = findTopLevelKeywordIndex(afterFrom, 'LIMIT');

  const firstClauseIdx = [whereIdx, orderIdx, limitIdx]
    .filter((i) => i !== -1)
    .sort((a, b) => a - b)[0];

  const fromSegment =
    firstClauseIdx !== undefined ? afterFrom.slice(0, firstClauseIdx).trim() : afterFrom;

  let whereSegment = '';
  if (whereIdx !== -1) {
    const endWhere = [orderIdx, limitIdx].filter((i) => i > whereIdx).sort((a, b) => a - b)[0];
    whereSegment =
      endWhere !== undefined
        ? afterFrom.slice(whereIdx + 5, endWhere).trim()
        : afterFrom.slice(whereIdx + 5).trim();
  }

  let orderSegment = '';
  if (orderIdx !== -1) {
    const endOrder = limitIdx > orderIdx ? limitIdx : undefined;
    orderSegment =
      endOrder !== undefined
        ? afterFrom.slice(orderIdx + 8, endOrder).trim()
        : afterFrom.slice(orderIdx + 8).trim();
  }

  let limitSegment = '';
  if (limitIdx !== -1) {
    limitSegment = afterFrom.slice(limitIdx + 5).trim();
  }

  const cursor: ParamCursor = {params, idx: 0};
  const whereBound = whereSegment
    ? bindQuestionMarks(whereSegment, cursor)
    : {resolvedExpr: '', values: []};

  let limitVal: number | null = null;
  let offsetVal = 0;
  if (limitSegment) {
    const offsetMatch = /^(.+?)\s+OFFSET\s+(.+)$/i.exec(limitSegment);
    if (offsetMatch) {
      const lBound = bindQuestionMarks(offsetMatch[1], cursor);
      const oBound = bindQuestionMarks(offsetMatch[2], cursor);
      limitVal = Number(evaluateValueExpr(lBound.resolvedExpr, {}, lBound.values));
      offsetVal = Number(evaluateValueExpr(oBound.resolvedExpr, {}, oBound.values));
    } else {
      const lBound = bindQuestionMarks(limitSegment, cursor);
      limitVal = Number(evaluateValueExpr(lBound.resolvedExpr, {}, lBound.values));
    }
  }

  const {baseTable, baseAlias, joins} = parseFromAndJoins(fromSegment);
  let rows = buildJoinedRows(baseTable, baseAlias, joins);

  if (whereBound.resolvedExpr) {
    rows = rows.filter((r) => evaluateWhere(whereBound.resolvedExpr, r, whereBound.values));
  }

  // COUNT(*) queries
  const countMatch = /^COUNT\(\*\)\s+as\s+`?([a-zA-Z0-9_]+)`?$/i.exec(selectClause);
  if (countMatch) {
    return [{[countMatch[1]]: rows.length}];
  }

  // ORDER BY
  if (orderSegment) {
    const orderSpecs = splitTopLevelCommas(orderSegment).map((spec) => {
      const parts = spec.trim().split(/\s+/);
      const col = parts[0];
      const dir = (parts[1] || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
      return {col, dir};
    });

    rows.sort((a, b) => {
      for (const spec of orderSpecs) {
        const av = toComparableValue(resolveColumnValue(a, spec.col));
        const bv = toComparableValue(resolveColumnValue(b, spec.col));
        if (av === bv) continue;
        if (av === null) return 1 * spec.dir;
        if (bv === null) return -1 * spec.dir;
        return av < bv ? -1 * spec.dir : 1 * spec.dir;
      }
      return 0;
    });
  }

  // LIMIT / OFFSET
  if (offsetVal > 0 || limitVal !== null) {
    const start = Math.max(0, offsetVal);
    const end = limitVal !== null ? start + Math.max(0, limitVal) : undefined;
    rows = rows.slice(start, end);
  }

  // Project columns
  const selectItems = splitTopLevelCommas(selectClause);
  const projected: Row[] = rows.map((row) => {
    const out: Row = {};
    for (const item of selectItems) {
      if (item === '*') {
        for (const [k, v] of Object.entries(row)) {
          if (!k.includes('.')) out[k] = v;
        }
        continue;
      }
      const wildcardAliasMatch = /^`?([a-zA-Z0-9_]+)`?\.\*$/.exec(item);
      if (wildcardAliasMatch) {
        const aliasPrefix = `${wildcardAliasMatch[1]}.`;
        for (const [k, v] of Object.entries(row)) {
          if (k.startsWith(aliasPrefix)) {
            out[k.slice(aliasPrefix.length)] = v;
          }
        }
        continue;
      }

      // Scalar subquery: (SELECT ...) as alias
      const subMatch = /^\((SELECT\s+.+)\)\s+as\s+`?([a-zA-Z0-9_]+)`?$/i.exec(item);
      if (subMatch) {
        let subSql = subMatch[1];
        const outAlias = subMatch[2];
        // Replace outer references like ur.id with literal from current row
        subSql = subSql.replace(
          /\b([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\b/g,
          (full, tblAlias: string, colName: string) => {
            if (tblAlias === baseAlias || joins.some((j) => j.alias === tblAlias)) {
              const outerVal = resolveColumnValue(row, `${tblAlias}.${colName}`);
              if (typeof outerVal === 'number') return String(outerVal);
              if (typeof outerVal === 'string') return `'${outerVal.replace(/'/g, "\\'")}'`;
              if (outerVal === null || outerVal === undefined) return 'NULL';
            }
            return full;
          },
        );
        const subRows = handleSelect(subSql, []);
        if (subRows.length > 0) {
          const firstKey = Object.keys(subRows[0])[0];
          out[outAlias] = firstKey ? subRows[0][firstKey] : null;
        } else {
          out[outAlias] = null;
        }
        continue;
      }

      const aliasMatch = /^(.+?)\s+as\s+`?([a-zA-Z0-9_]+)`?$/i.exec(item);
      if (aliasMatch) {
        const expr = aliasMatch[1].trim();
        const alias = aliasMatch[2].trim();
        out[alias] = resolveColumnValue(row, expr);
      } else {
        const cleanCol = item.replace(/`/g, '').trim();
        const outKey = cleanCol.includes('.') ? cleanCol.split('.', 2)[1] : cleanCol;
        out[outKey] = resolveColumnValue(row, cleanCol);
      }
    }
    return out;
  });

  if (isDistinct) {
    const seen = new Set<string>();
    return projected.filter((r) => {
      const sig = JSON.stringify(r);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  return projected;
}

export function mockQueryRows<T = Row>(sql: string, params: unknown[] = []): T[] {
  const normalized = normalizeSqlWhitespace(sql);
  if (/^SELECT\b/i.test(normalized)) {
    return handleSelect(normalized, params) as T[];
  }
  throw new Error(`mockQueryRows called with non-SELECT SQL: ${normalized}`);
}

export function mockExecuteSql(sql: string, params: unknown[] = []): ResultSetHeader {
  const normalized = normalizeSqlWhitespace(sql);
  if (/^INSERT\b/i.test(normalized)) {
    return handleInsert(normalized, params);
  }
  if (/^UPDATE\b/i.test(normalized)) {
    return handleUpdate(normalized, params);
  }
  if (/^DELETE\b/i.test(normalized)) {
    return handleDelete(normalized, params);
  }
  return buildResultSetHeader(0, 0);
}

export function mockResetAndInit(): void {
  resetTables();
}
