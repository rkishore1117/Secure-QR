from django.db import models
from apps.accounts.models import UserAccount


class UserFieldConfig(models.Model):
    FIELD_TYPES = [("text", "Text"), ("select", "Select"), ("date", "Date"), ("file", "File")]
    field_key = models.SlugField(max_length=64, unique=True)
    label = models.CharField(max_length=120)
    field_type = models.CharField(max_length=16, choices=FIELD_TYPES, default="text")
    is_required = models.BooleanField(default=False)
    is_enabled = models.BooleanField(default=True)
    is_editable_on_resubmit = models.BooleanField(default=True)
    options_json = models.JSONField(default=list)
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "user_field_configs"


class UserRecord(models.Model):
    STATUS_CHOICES = [
        ("PENDING", "Pending"),
        ("APPROVED", "Approved"),
        ("REJECTED", "Rejected"),
        ("RESUBMISSION_REQUIRED", "Resubmission Required"),
    ]

    user = models.OneToOneField(UserAccount, on_delete=models.CASCADE, related_name="record")
    registration_id = models.CharField(max_length=32, unique=True, db_index=True)
    full_name = models.CharField(max_length=160)
    dob = models.DateField(null=True, blank=True)
    gender = models.CharField(max_length=32, blank=True)
    address = models.TextField()
    city = models.CharField(max_length=100, db_index=True)
    district = models.CharField(max_length=100)
    state = models.CharField(max_length=100, db_index=True)
    country = models.CharField(max_length=100)
    postal_code = models.CharField(max_length=24)
    profile_photo = models.ImageField(upload_to="photos/")
    id_proof_type = models.CharField(max_length=64, default="National Passport")
    id_proof_document = models.FileField(upload_to="id_proofs/", null=True, blank=True)
    dynamic_fields = models.JSONField(default=dict)
    consent_accepted = models.BooleanField(default=True)
    consent_timestamp = models.DateTimeField()
    approval_status = models.CharField(
        max_length=32, choices=STATUS_CHOICES, default="PENDING", db_index=True
    )
    rejection_reason = models.TextField(blank=True)
    resubmission_note = models.TextField(blank=True)
    reviewed_by = models.ForeignKey(
        UserAccount, null=True, blank=True, on_delete=models.SET_NULL, related_name="reviewed_records"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "user_records"
        indexes = [models.Index(fields=["state", "city"])]


class RegistrationRequest(models.Model):
    REQUEST_TYPES = [("INITIAL", "Initial"), ("RESUBMISSION", "Resubmission")]
    user_record = models.ForeignKey(UserRecord, on_delete=models.CASCADE, related_name="requests")
    request_type = models.CharField(max_length=16, choices=REQUEST_TYPES, default="INITIAL")
    status = models.CharField(max_length=32, choices=UserRecord.STATUS_CHOICES, default="PENDING")
    notes = models.TextField(blank=True)
    submitted_at = models.DateTimeField(auto_now_add=True)
    processed_by = models.ForeignKey(UserAccount, null=True, blank=True, on_delete=models.SET_NULL)
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "registration_requests"


class OTPVerification(models.Model):
    mobile = models.CharField(max_length=20, db_index=True)
    purpose = models.CharField(max_length=32, default="REGISTRATION")
    otp_hash = models.CharField(max_length=64)
    expires_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=5)
    verified_at = models.DateTimeField(null=True, blank=True)
    used_at = models.DateTimeField(null=True, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "otp_verifications"
