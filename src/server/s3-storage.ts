import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {getUploadsDir} from './db';

export interface StoredUploadResult {
  url: string;
  storage: 'aws-s3' | 'local-fallback';
  key: string;
  error?: string;
}

function getS3Prefix(filePathBase: string): string {
  if (!filePathBase) return 'sathayush';
  try {
    const parsed = new URL(filePathBase);
    const trimmed = parsed.pathname.replace(/^\/+|\/+$/g, '');
    return trimmed || 'sathayush';
  } catch {
    return 'sathayush';
  }
}

export async function uploadBase64Media(
  dataUrl: string,
  allowedMimes: string[],
  folder: 'photos' | 'id_proofs' | 'qr',
  filePrefix: string,
): Promise<StoredUploadResult> {
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error('Please upload a valid image or PDF file.');
  }
  const mime = match[1].toLowerCase();
  const b64 = match[2];
  if (!allowedMimes.includes(mime)) {
    throw new Error(`Unsupported file format (${mime}). Please choose a PNG, JPG, WebP, or PDF file.`);
  }
  const buffer = Buffer.from(b64, 'base64');
  const maxBytes = 2 * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new Error('File is larger than 2 MB. Please choose a smaller file.');
  }

  const extMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  };
  const ext = extMap[mime] || 'bin';
  const filename = `${filePrefix}_${crypto.randomUUID()}.${ext}`;

  const accessKeyId = process.env['AWS_ACCESS_KEY_ID'] || '';
  const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY'] || '';
  const region = process.env['AWS_S3_REGION_NAME'] || 'ap-south-1';
  const bucket = process.env['AWS_STORAGE_BUCKET_NAME'] || '';
  const filePathBase =
    process.env['FILE_PATH'] ||
    (bucket ? `https://${bucket}.s3.${region}.amazonaws.com/sathayush/` : '');

  const normalizedBase = filePathBase.endsWith('/') ? filePathBase : `${filePathBase}/`;
  const s3Prefix = getS3Prefix(normalizedBase);
  const objectKey = `${s3Prefix}/${folder}/${filename}`;

  if (accessKeyId && secretAccessKey && bucket) {
    try {
      const client = new S3Client({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: buffer,
          ContentType: mime,
        }),
        {abortSignal: controller.signal},
      );
      clearTimeout(timer);

      return {
        url: `${normalizedBase}${folder}/${filename}`,
        storage: 'aws-s3',
        key: objectKey,
      };
    } catch (err) {
      // Save local fallback copy so preview continues working if S3 bucket/network is restricted
      const localPath = path.join(getUploadsDir(), filename);
      fs.writeFileSync(localPath, buffer);
      return {
        url: `/api/v1/uploads/${filename}`,
        storage: 'local-fallback',
        key: objectKey,
        error: err instanceof Error ? err.message : 'S3 upload failed',
      };
    }
  }

  const localPath = path.join(getUploadsDir(), filename);
  fs.writeFileSync(localPath, buffer);
  return {
    url: `/api/v1/uploads/${filename}`,
    storage: 'local-fallback',
    key: filename,
  };
}
