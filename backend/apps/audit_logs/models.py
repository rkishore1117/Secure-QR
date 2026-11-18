from django.db import models
from apps.accounts.models import UserAccount


class AdminActivityLog(models.Model):
    actor_user = models.ForeignKey(UserAccount, null=True, blank=True, on_delete=models.SET_NULL)
    actor_email = models.EmailField()
    actor_role = models.CharField(max_length=20)
    action = models.CharField(max_length=64, db_index=True)
    target_type = models.CharField(max_length=64)
    target_id = models.CharField(max_length=64, blank=True)
    details = models.JSONField(default=dict)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "admin_activity_logs"
