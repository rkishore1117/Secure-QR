import ExcelJS from 'exceljs';
import {getDb} from './db';

export interface ExcelFilterOptions {
  status?: string;
  state?: string;
  city?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function buildVerifiedUsersWorkbook(
  filters: ExcelFilterOptions = {},
): Promise<{buffer: Buffer; recordCount: number; filename: string}> {
  const status = String(filters.status || '').trim();
  const state = String(filters.state || '').trim();
  const city = String(filters.city || '').trim();
  const dateFrom = String(filters.dateFrom || '').trim();
  const dateTo = String(filters.dateTo || '').trim();

  const where: string[] = ['ur.deleted_at IS NULL'];
  const params: string[] = [];

  if (status && status !== 'ALL') {
    where.push('ur.approval_status = ?');
    params.push(status);
  }
  if (state) {
    where.push('lower(ur.state) = lower(?)');
    params.push(state);
  }
  if (city) {
    where.push('lower(ur.city) = lower(?)');
    params.push(city);
  }
  if (dateFrom) {
    where.push('ur.created_at >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('ur.created_at <= ?');
    params.push(`${dateTo}T23:59:59.999Z`);
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ua.id as user_id, ur.registration_id, ur.full_name, ua.mobile, ua.email,
              ur.address, ur.city, ur.district, ur.state, ur.country, ur.created_at, ur.approval_status,
              (SELECT status FROM qr_codes q WHERE q.user_record_id = ur.id ORDER BY q.id DESC LIMIT 1) as qr_status,
              (SELECT expires_at FROM qr_codes q WHERE q.user_record_id = ur.id ORDER BY q.id DESC LIMIT 1) as qr_validity,
              (SELECT last_verified_at FROM qr_codes q WHERE q.user_record_id = ur.id ORDER BY q.id DESC LIMIT 1) as last_verified_at
       FROM user_records ur
       JOIN user_accounts ua ON ua.id = ur.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY ur.created_at DESC`,
    )
    .all(...params) as Record<string, unknown>[];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Secure QR Verification System';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Verified Registrations', {
    views: [{state: 'frozen', ySplit: 1}],
  });

  sheet.columns = [
    {header: 'Serial Number', key: 'serial', width: 15},
    {header: 'User ID', key: 'userId', width: 12},
    {header: 'Registration ID', key: 'registrationId', width: 20},
    {header: 'Full Name', key: 'fullName', width: 24},
    {header: 'Mobile', key: 'mobile', width: 18},
    {header: 'Email', key: 'email', width: 28},
    {header: 'Address', key: 'address', width: 32},
    {header: 'City', key: 'city', width: 18},
    {header: 'District', key: 'district', width: 20},
    {header: 'State', key: 'state', width: 18},
    {header: 'Country', key: 'country', width: 18},
    {header: 'Registration Date', key: 'registrationDate', width: 22},
    {header: 'Approval Status', key: 'approvalStatus', width: 22},
    {header: 'QR Status', key: 'qrStatus', width: 15},
    {header: 'QR Validity', key: 'qrValidity', width: 22},
    {header: 'Last Verification Date', key: 'lastVerifiedDate', width: 24},
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = {bold: true, color: {argb: 'FFFFFFFF'}, size: 11};
  headerRow.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF0F172A'}};
  headerRow.alignment = {vertical: 'middle', horizontal: 'left'};
  headerRow.height = 26;

  rows.forEach((r, idx) => {
    const added = sheet.addRow({
      serial: idx + 1,
      userId: r['user_id'],
      registrationId: r['registration_id'],
      fullName: r['full_name'],
      mobile: r['mobile'],
      email: r['email'],
      address: r['address'],
      city: r['city'],
      district: r['district'],
      state: r['state'],
      country: r['country'],
      registrationDate: String(r['created_at'] || '').slice(0, 19).replace('T', ' '),
      approvalStatus: r['approval_status'],
      qrStatus: r['qr_status'] || 'NOT_ISSUED',
      qrValidity: r['qr_validity'] ? String(r['qr_validity']).slice(0, 10) : 'N/A',
      lastVerifiedDate: r['last_verified_at']
        ? String(r['last_verified_at']).slice(0, 19).replace('T', ' ')
        : 'Never',
    });
    added.height = 20;
  });

  sheet.autoFilter = 'A1:P1';

  sheet.columns.forEach((col) => {
    let maxLen = String(col.header || '').length + 4;
    col.eachCell?.({includeEmpty: false}, (cell) => {
      const len = String(cell.value ?? '').length + 3;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(48, maxLen);
  });

  const filename = `SecureQR_Verified_Users_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const rawBuffer = await workbook.xlsx.writeBuffer();

  return {
    buffer: Buffer.from(rawBuffer),
    recordCount: rows.length,
    filename,
  };
}
