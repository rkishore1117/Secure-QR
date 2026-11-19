import os
import re
from pathlib import Path
from django.core.exceptions import ImproperlyConfigured

_PLACEHOLDER_RE = re.compile(r"^(replace[-_]with|your[-_]|changeme$|example$|MY_)", re.IGNORECASE)


def read_env(key: str, default: str = "") -> str:
    raw = os.environ.get(key, "")
    val = raw.strip().strip('"').strip("'")
    if not val or _PLACEHOLDER_RE.match(val):
        return default
    return val


def is_production_env() -> bool:
    django_env = read_env("DJANGO_ENV").lower()
    if django_env == "production":
        return True
    if django_env == "development":
        return False
    return bool(
        read_env("RENDER")
        or read_env("RENDER_SERVICE_ID")
        or read_env("STRICT_PRODUCTION_CONFIG").lower() == "true"
    )


def build_mysql_ssl_options() -> dict:
    ssl_flag = read_env("DB_SSL").lower()
    host = read_env("DB_HOST").lower()
    if ssl_flag in {"false", "0", "disable"}:
        return {}
    ca_path = read_env("DB_SSL_CA")
    if ca_path and Path(ca_path).exists():
        return {"ssl": {"ca": ca_path}}
    if ssl_flag in {"true", "1", "require"} or ".rds.amazonaws.com" in host:
        if ca_path:
            return {"ssl": {"ca": ca_path}}
        return {"ssl": {"ssl_mode": "PREFERRED"}}
    return {}


def validate_production_environment() -> None:
    if read_env("SKIP_STRICT_ENV_CHECK").lower() == "true":
        return
    if not is_production_env():
        return

    missing: list[str] = []
    for key in ("DJANGO_SECRET_KEY", "OTP_PEPPER", "DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"):
        if not read_env(key):
            missing.append(key)

    db_engine = read_env("DB_ENGINE", "django.db.backends.mysql").lower()
    if "sqlite" in db_engine:
        raise ImproperlyConfigured(
            "SQLite is forbidden in production. Configure AWS RDS MySQL via DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME."
        )

    has_brevo = bool(read_env("BREVO_API_KEY"))
    has_webhook = bool(read_env("EMAIL_WEBHOOK_URL"))
    has_smtp = bool(read_env("EMAIL_HOST_USER") and read_env("EMAIL_HOST_PASSWORD"))
    if not (has_brevo or has_webhook or has_smtp):
        missing.append("BREVO_API_KEY (or EMAIL_WEBHOOK_URL / EMAIL_HOST_USER + EMAIL_HOST_PASSWORD)")

    if missing:
        raise ImproperlyConfigured(
            "Production startup blocked — missing mandatory environment variables: "
            + ", ".join(missing)
        )
