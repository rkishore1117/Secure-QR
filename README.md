# Secure QR Verification Authority

An enterprise identity registration, Email OTP verification, administrator approval, cryptographic QR credential issuance, live camera verification scanner, and automated Excel reporting platform.

## Architecture Overview

- **Frontend (`src/app/`)**: Angular 21 standalone zoneless application with Tailwind CSS v4, Reactive Forms, Signals, `@zxing/browser` + `jsqr` camera/image QR scanning, WebSocket real-time notifications, and responsive layouts across 320px–1920px viewports.
- **Primary SSR & API Server (`src/server/` & `src/server.ts`)**: Express 5 SSR API server connected to **AWS RDS MySQL (`secure_qr_verification`)** over optional TLS, SHA-256 hashed 256-bit QR tokens, HMAC-SHA256 OTP hashes, JWT HS256 auth + refresh tokens, `qrcode` PNG generation, `exceljs` `.xlsx` export, AWS S3 upload (`sathayushstorage`), `ws` WebSocket notification push, and multi-transport email delivery (**Brevo HTTPS API** -> Apps Script Webhook -> Resend HTTPS -> **SMTP fallback**).
- **Django Backend (`backend/`, `database/`, `deployment/`)**: Django 5 + DRF + Channels + OpenPyXL + AWS RDS MySQL codebase with separated development/production env validation (`backend/config/env.py`), Brevo HTTPS + SMTP email service (`backend/apps/registrations/email_service.py`), health check endpoints, DDL schema, Docker Compose, Nginx, Gunicorn, and `deployment/start.sh`.

## Environment Configuration

Copy `.env.example` to `.env` for local development (never commit `.env` to git) and configure the same variables in your cloud hosting dashboard (e.g., Render Environment Variables):

- **Database (AWS RDS MySQL):** `DB_HOST`, `DB_PORT=3306`, `DB_NAME=secure_qr_verification`, `DB_USER`, `DB_PASSWORD`, `DB_SSL=true`
- **Email OTP & Reports:** `BREVO_API_KEY` (recommended over HTTPS port `443` on cloud hosts where SMTP ports `465`/`587` are blocked), optional `EMAIL_WEBHOOK_URL` / `RESEND_API_KEY`, and SMTP fallback (`EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USE_TLS`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `DEFAULT_FROM_EMAIL`)
- **Security & Admin:** `JWT_SECRET`, `OTP_PEPPER`, `ALLOW_DEV_OTP_HINT=false`, `STRICT_PRODUCTION_CONFIG=true`, `FIXED_ADMIN_EMAIL`, `FIXED_ADMIN_PASSWORD`
- **AWS S3 Media:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_REGION_NAME`, `AWS_STORAGE_BUCKET_NAME`, `FILE_PATH`

## Health & Connectivity Endpoints

- `GET /api/v1/public/health` — Non-PII check reporting live database connectivity and email configuration status.
- `GET /api/v1/admin/health` — Admin-only live probe running a real MySQL connection ping and email provider authentication check (`Brevo /v3/account` or `SMTP verify()`).
- `GET /api/v1/admin/settings/db-status` — Super Admin integration diagnostics and S3/DB/Email overview.

## Running & Building

```bash
npm install
npm run dev       # Development Angular SSR + Express API on port 3000
npm run build     # Production SSR build
npm run serve:ssr:app
```

## Deploying to Render

Use the included `render.yaml` Blueprint (`npm install && npm run build`, start `npm run serve:ssr:app`, `healthCheckPath: /api/v1/public/health`) and fill all `sync: false` variables in the Render Environment tab.
