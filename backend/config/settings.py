import os
from datetime import timedelta
from pathlib import Path
from dotenv import load_dotenv
from config.env import (
    build_mysql_ssl_options,
    is_production_env,
    read_env,
    validate_production_environment,
)

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR.parent / ".env"
if ENV_FILE.exists():
    load_dotenv(ENV_FILE)
else:
    load_dotenv()

IS_PRODUCTION = is_production_env()
validate_production_environment()

SECRET_KEY = read_env("DJANGO_SECRET_KEY", "dev-only-insecure-secret-key-change-in-production")
DEBUG = False if IS_PRODUCTION else read_env("DJANGO_DEBUG", "False").lower() == "true"
ALLOWED_HOSTS = [
    h.strip()
    for h in read_env("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if h.strip()
]

INSTALLED_APPS = [
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",
    "drf_spectacular",
    "channels",
    "apps.accounts",
    "apps.registrations",
    "apps.qr_management",
    "apps.notifications",
    "apps.verification",
    "apps.exports",
    "apps.audit_logs",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
ASGI_APPLICATION = "config.asgi.application"
WSGI_APPLICATION = "config.wsgi.application"
AUTH_USER_MODEL = "accounts.UserAccount"

_MYSQL_OPTIONS = {
    "charset": "utf8mb4",
    "connect_timeout": int(read_env("DB_CONNECT_TIMEOUT", "8")),
    "init_command": "SET sql_mode='STRICT_TRANS_TABLES'",
}
_MYSQL_OPTIONS.update(build_mysql_ssl_options())

DATABASES = {
    "default": {
        "ENGINE": read_env("DB_ENGINE", "django.db.backends.mysql"),
        "NAME": read_env("DB_NAME", "secure_qr_verification"),
        "USER": read_env("DB_USER", "GrmAdmin"),
        "PASSWORD": read_env("DB_PASSWORD", ""),
        "HOST": read_env("DB_HOST", "127.0.0.1"),
        "PORT": read_env("DB_PORT", "3306"),
        "CONN_MAX_AGE": int(read_env("DB_CONN_MAX_AGE", "60")),
        "CONN_HEALTH_CHECKS": True,
        "OPTIONS": _MYSQL_OPTIONS,
    }
}

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [read_env("REDIS_URL", "redis://127.0.0.1:6379/0")]},
    }
}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": (
        "rest_framework.permissions.IsAuthenticated",
    ),
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "60/minute",
        "user": "240/minute",
        "otp_send": "5/15m",
        "otp_verify": "10/15m",
    },
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=60),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
}

CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in read_env("CORS_ALLOWED_ORIGINS", "http://localhost:4200,http://localhost:3000").split(",")
    if origin.strip()
]

SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "SAMEORIGIN"
if IS_PRODUCTION:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# Email Delivery Configuration (Brevo HTTPS Preferred + Webhook Relay + SMTP Fallback)
BREVO_API_KEY = read_env("BREVO_API_KEY")
EMAIL_WEBHOOK_URL = read_env("EMAIL_WEBHOOK_URL")
EMAIL_WEBHOOK_SECRET = read_env("EMAIL_WEBHOOK_SECRET")
EMAIL_BACKEND = read_env("EMAIL_BACKEND", "django.core.mail.backends.smtp.EmailBackend")
EMAIL_HOST = read_env("EMAIL_HOST", "smtp.gmail.com")
EMAIL_PORT = int(read_env("EMAIL_PORT", "587"))
EMAIL_USE_TLS = read_env("EMAIL_USE_TLS", "True").lower() == "true"
EMAIL_TIMEOUT = int(read_env("EMAIL_TIMEOUT", "10"))
EMAIL_HOST_USER = read_env("EMAIL_HOST_USER")
EMAIL_HOST_PASSWORD = read_env("EMAIL_HOST_PASSWORD")
DEFAULT_FROM_EMAIL = read_env("DEFAULT_FROM_EMAIL", EMAIL_HOST_USER or "kishore.sathayush@gmail.com")
OTP_PEPPER = read_env("OTP_PEPPER", "dev-only-otp-pepper-change-in-production")

# SMS OTP Gateway Configuration
SMS_GATEWAY_URL = read_env("SMS_GATEWAY_URL", "http://api.bulksmsgateway.in/sendmessage.php")
SMS_USER = read_env("SMS_USER")
SMS_PASSWORD = read_env("SMS_PASSWORD")
SMS_SENDER = read_env("SMS_SENDER", "STYUSH")
SMS_TYPE = read_env("SMS_TYPE", "3")
SMS_TEMPLATE_ID = read_env("SMS_TEMPLATE_ID")
RE_SMS_TEMPLATE_ID = read_env("RE_SMS_TEMPLATE_ID")

# Fixed Super Admin & Daily Report Recipient
FIXED_ADMIN_EMAIL = read_env("FIXED_ADMIN_EMAIL", "kishore.sathayush@gmail.com")
FIXED_ADMIN_PASSWORD = read_env("FIXED_ADMIN_PASSWORD")
DAILY_REPORT_RECIPIENT_EMAIL = read_env("DAILY_REPORT_RECIPIENT_EMAIL", FIXED_ADMIN_EMAIL)

# AWS S3 Media Storage
AWS_ACCESS_KEY_ID = read_env("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = read_env("AWS_SECRET_ACCESS_KEY")
AWS_S3_REGION_NAME = read_env("AWS_S3_REGION_NAME", "ap-south-1")
AWS_STORAGE_BUCKET_NAME = read_env("AWS_STORAGE_BUCKET_NAME")
FILE_PATH = read_env("FILE_PATH") or read_env("File_path")

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

if AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY and AWS_STORAGE_BUCKET_NAME:
    STORAGES = {
        "default": {
            "BACKEND": "storages.backends.s3.S3Storage",
            "OPTIONS": {
                "bucket_name": AWS_STORAGE_BUCKET_NAME,
                "region_name": AWS_S3_REGION_NAME,
                "location": "sathayush",
                "file_overwrite": False,
            },
        },
        "staticfiles": {
            "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
        },
    }
    MEDIA_URL = FILE_PATH or f"https://{AWS_STORAGE_BUCKET_NAME}.s3.{AWS_S3_REGION_NAME}.amazonaws.com/sathayush/"
else:
    MEDIA_URL = "/media/"
    MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
