from django.conf import settings
from django.core.management.base import BaseCommand
from apps.accounts.models import AdminProfile, Permission, UserAccount


class Command(BaseCommand):
    help = "Create or update the fixed Super Admin account from environment variables."

    def handle(self, *args, **options):
        email = getattr(settings, "FIXED_ADMIN_EMAIL", "").strip().lower()
        password = getattr(settings, "FIXED_ADMIN_PASSWORD", "")
        mobile = "+919550000955"

        if not email or not password:
            self.stderr.write("FIXED_ADMIN_EMAIL and FIXED_ADMIN_PASSWORD must be set.")
            return

        user, created = UserAccount.objects.get_or_create(
            email=email,
            defaults={
                "mobile": mobile,
                "role": "SUPER_ADMIN",
                "is_active": True,
                "is_staff": True,
                "is_superuser": True,
                "is_mobile_verified": True,
            },
        )
        user.role = "SUPER_ADMIN"
        user.is_active = True
        user.is_staff = True
        user.is_superuser = True
        user.is_mobile_verified = True
        user.set_password(password)
        user.save()

        profile, _ = AdminProfile.objects.get_or_create(
            user=user,
            defaults={
                "full_name": "Kishore (Primary Admin)",
                "department": "Executive Governance",
                "designation": "Fixed Super Administrator",
            },
        )
        all_perms = Permission.objects.all()
        if all_perms.exists():
            profile.permissions.set(all_perms)

        action = "Created" if created else "Updated"
        self.stdout.write(self.style.SUCCESS(f"{action} fixed Super Admin: {email}"))
