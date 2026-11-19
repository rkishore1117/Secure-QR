from django.conf import settings
from django.db import connections
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from apps.accounts.permissions import HasAdminPermission
from apps.registrations.email_service import (
    check_email_provider_health,
    get_primary_email_provider,
)


class PublicHealthView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        db_cfg = settings.DATABASES.get("default", {})
        db_connected = False
        db_error = None
        try:
            with connections["default"].cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
            db_connected = True
        except Exception as exc:
            db_error = str(exc)

        email_configured, email_provider = get_primary_email_provider()
        payload = {
            "databaseConnected": db_connected,
            "databaseEngine": "mysql-rds" if "mysql" in str(db_cfg.get("ENGINE", "")).lower() else "other",
            "databaseName": db_cfg.get("NAME", ""),
            "emailConfigured": email_configured,
            "emailProvider": email_provider,
            "checkedAt": timezone.now().isoformat(),
        }
        if not db_connected and db_error:
            payload["databaseStatus"] = "unreachable"
        return Response(
            payload,
            status=status.HTTP_200_OK if (db_connected and email_configured) else status.HTTP_503_SERVICE_UNAVAILABLE,
        )


class AdminHealthCheckView(APIView):
    permission_classes = [HasAdminPermission]

    def get(self, request):
        db_cfg = settings.DATABASES.get("default", {})
        db_connected = False
        db_error = None
        try:
            with connections["default"].cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
            db_connected = True
        except Exception as exc:
            db_error = str(exc)

        email_health = check_email_provider_health()
        ok = bool(db_connected and email_health.get("healthy"))
        return Response(
            {
                "ok": ok,
                "database": {
                    "configured": bool(db_cfg.get("HOST") and db_cfg.get("USER")),
                    "connected": db_connected,
                    "host": db_cfg.get("HOST", ""),
                    "database": db_cfg.get("NAME", ""),
                    "error": db_error,
                },
                "email": email_health,
                "checkedAt": timezone.now().isoformat(),
            },
            status=status.HTTP_200_OK if ok else status.HTTP_503_SERVICE_UNAVAILABLE,
        )
