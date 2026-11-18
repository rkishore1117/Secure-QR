import re
import MySQLdb
from django.conf import settings
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Create the dedicated Secure QR MySQL database on the configured RDS host."

    def handle(self, *args, **options):
        db_cfg = settings.DATABASES["default"]
        db_name = re.sub(r"[^a-zA-Z0-9_]", "", db_cfg.get("NAME", "secure_qr_verification"))
        conn = MySQLdb.connect(
            host=db_cfg["HOST"],
            port=int(db_cfg.get("PORT", 3306)),
            user=db_cfg["USER"],
            passwd=db_cfg["PASSWORD"],
            charset="utf8mb4",
        )
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"CREATE DATABASE IF NOT EXISTS `{db_name}` "
                    "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
                )
            conn.commit()
            self.stdout.write(
                self.style.SUCCESS(
                    f"Dedicated database '{db_name}' is ready on {db_cfg['HOST']}."
                )
            )
        finally:
            conn.close()
