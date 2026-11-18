from django.db import models
from apps.accounts.models import UserAccount


class Notification(models.Model):
    recipient_user = models.ForeignKey(
        UserAccount, null=True, blank=True, on_delete=models.CASCADE, related_name="notifications"
    )
    recipient_role = models.CharField(max_length=20, blank=True, db_index=True)
    type = models.CharField(max_length=48)
    title = models.CharField(max_length=180)
    message = models.TextField()
    link_path = models.CharField(max_length=255, blank=True)
    metadata = models.JSONField(default=dict)
    is_read = models.BooleanField(default=False, db_index=True)
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "notifications"
