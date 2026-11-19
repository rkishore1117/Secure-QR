#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../backend"

echo "[deploy] Running Django startup & production configuration checks..."
python manage.py check --deploy

echo "[deploy] Applying pending database migrations against configured MySQL RDS..."
python manage.py migrate --noinput

echo "[deploy] Collecting static assets..."
python manage.py collectstatic --noinput

echo "[deploy] Starting ASGI server..."
exec daphne -b 0.0.0.0 -p "${PORT:-8000}" config.asgi:application
