from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models


class Role(models.Model):
    name = models.CharField(max_length=32, unique=True)
    description = models.TextField(blank=True)

    class Meta:
        db_table = "roles"


class Permission(models.Model):
    code = models.CharField(max_length=64, unique=True)
    label = models.CharField(max_length=128)
    description = models.TextField(blank=True)

    class Meta:
        db_table = "permissions"


class UserAccountManager(BaseUserManager):
    def create_user(self, email, mobile, password=None, **extra_fields):
        if not email or not mobile:
            raise ValueError("Email and mobile number are required")
        email = self.normalize_email(email)
        user = self.model(email=email, mobile=mobile, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, mobile, password=None, **extra_fields):
        extra_fields.setdefault("role", "SUPER_ADMIN")
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("is_mobile_verified", True)
        return self.create_user(email, mobile, password, **extra_fields)


class UserAccount(AbstractBaseUser, PermissionsMixin):
    ROLE_CHOICES = [
        ("SUPER_ADMIN", "Super Admin"),
        ("ADMIN", "Admin"),
        ("USER", "Registered User"),
    ]

    email = models.EmailField(unique=True, db_index=True)
    mobile = models.CharField(max_length=20, unique=True, db_index=True)
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default="USER", db_index=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    is_mobile_verified = models.BooleanField(default=False)
    is_email_verified = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    objects = UserAccountManager()
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["mobile"]

    class Meta:
        db_table = "user_accounts"


class AdminProfile(models.Model):
    user = models.OneToOneField(UserAccount, on_delete=models.CASCADE, related_name="admin_profile")
    full_name = models.CharField(max_length=150)
    department = models.CharField(max_length=120, default="Verification Operations")
    designation = models.CharField(max_length=120, default="Verification Officer")
    permissions = models.ManyToManyField(Permission, blank=True)
    created_by = models.ForeignKey(
        UserAccount, null=True, blank=True, on_delete=models.SET_NULL, related_name="created_admins"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "admin_profiles"
