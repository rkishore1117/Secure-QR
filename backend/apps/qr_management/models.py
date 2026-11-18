import hashlib
import io
import os
import secrets
from datetime import timedelta
import qrcode
from django.core.files.base import ContentFile
from django.db import models, transaction
from django.utils import timezone
from apps.accounts.models import UserAccount
from apps.registrations.models import UserRecord


class QRCode(models.Model):
    STATUS_CHOICES = [("ACTIVE", "Active"), ("EXPIRED", "Expired"), ("REVOKED", "Revoked")]

    user_record = models.ForeignKey(UserRecord, on_delete=models.CASCADE, related_name="qr_codes")
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    token_prefix = models.CharField(max_length=16)
    qr_image = models.ImageField(upload_to="qr_codes/")
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="ACTIVE", db_index=True)
    issued_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        UserAccount, null=True, blank=True, on_delete=models.SET_NULL, related_name="revoked_qrs"
    )
    revoke_reason = models.TextField(blank=True)
    issued_by = models.ForeignKey(
        UserAccount, null=True, blank=True, on_delete=models.SET_NULL, related_name="issued_qrs"
    )
    last_verified_at = models.DateTimeField(null=True, blank=True)
    scan_count = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "qr_codes"
        indexes = [models.Index(fields=["user_record", "status"])]


@transaction.atomic
def issue_secure_qr(user_record: UserRecord, admin_user: UserAccount, validity_days: int = 365) -> QRCode:
    if user_record.approval_status != "APPROVED":
        raise ValueError("Only approved users can receive an active QR code.")

    QRCode.objects.filter(user_record=user_record, status="ACTIVE").update(
        status="REVOKED",
        revoked_at=timezone.now(),
        revoked_by=admin_user,
        revoke_reason="Superseded by newly issued QR credential",
    )

    raw_token = secrets.token_urlsafe(32)  # 256 bits of cryptographic entropy
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    base_url = os.environ.get("APP_URL", "https://localhost").rstrip("/")
    verify_url = f"{base_url}/verify?token={raw_token}"

    qr_img = qrcode.make(verify_url)
    buf = io.BytesIO()
    qr_img.save(buf, format="PNG")

    record = QRCode(
        user_record=user_record,
        token_hash=token_hash,
        token_prefix=token_hash[:12],
        status="ACTIVE",
        expires_at=timezone.now() + timedelta(days=validity_days),
        issued_by=admin_user,
    )
    record.qr_image.save(f"qr_{user_record.registration_id}.png", ContentFile(buf.getvalue()), save=False)
    record.save()
    return record
