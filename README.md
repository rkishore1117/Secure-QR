# Secure QR Verification System

An enterprise identity registration, OTP verification, administrator approval, cryptographic QR credential issuance, live camera verification scanner, and Excel reporting platform.

## Architecture Overview

- **Frontend (`src/app/`)**: Angular 21 standalone zoneless application with Tailwind CSS v4, Reactive Forms, Signals, `@zxing/browser` + `jsqr` camera/image QR scanning, WebSocket real-time notifications, and responsive layouts across 320px–1920px viewports.
- **Live Preview Runtime Backend (`src/server/` & `src/server.ts`)**: Express 5 SSR API server backed by persistent SQLite (`node:sqlite` in `data/secure_qr.db`), SHA-256 hashed 256-bit QR tokens, HMAC-SHA256 OTP hashes, JWT HS256 auth + refresh tokens, `qrcode` PNG generation, `exceljs` `.xlsx` export, and `ws` WebSocket notification push.
- **Portable Django + MySQL 8 Backend (`backend/`, `database/`, `deployment/`)**: Complete Django 5 + DRF + Channels + OpenPyXL + MySQL 8 codebase, DDL schema, ER diagram, Docker Compose, Nginx, Gunicorn, and backup scripts for standalone Python/MySQL server hosting.

## Seeded Test Accounts (Local Database)

- **Super Admin**: `superadmin@secureqr.gov` / `SuperAdmin@2026!`
- **Delegated Verifier Admin**: `admin.verifier@secureqr.gov` / `Verifier@2026!`
- **Approved Member (Active QR)**: `aarav.sharma@enterprise.org` / `Member@2026!`
- **Resubmission Required Member**: `sofia.rodriguez@civicgrid.org` / `Member@2026!`

## Running Locally (Angular + Express Live Stack)

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
```

## Deploying Portable Django + MySQL 8 Stack

See `deployment/docker-compose.yml`, `database/schema.sql`, and `documentation/postman_collection.json`.
