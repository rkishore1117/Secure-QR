from django.db import models
from apps.accounts.models import UserAccount
from apps.qr_management.models import QRCode
from apps.registrations.models import UserRecord


class QRScanLog(models.Model):
    RESULT_CHOICES = [
        ("VALID", "Valid"),
        ("INVALID", "Invalid"),
        ("EXPIRED", "Expired"),
        ("REVOKED", "Revoked"),
        ("INACTIVE_USER", "Inactive User"),
        ("UNAPPROVED_USER", "Unapproved User"),
    ]

    qr_code = models.ForeignKey(QRCode, null=True, blank=True, on_delete=models.SET_NULL)
    user_record = models.ForeignKey(UserRecord, null=True, blank=True, on_delete=models.SET_NULL)
    scanned_by_admin = models.ForeignKey(UserAccount, on_delete=models.CASCADE)
    scanned_token_prefix = models.CharField(max_length=16)
    result_status = models.CharField(max_length=24, choices=RESULT_CHOICES, db_index=True)
    reason = models.TextField()
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField(blank=True)
    scanned_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "qr_scan_logs"
