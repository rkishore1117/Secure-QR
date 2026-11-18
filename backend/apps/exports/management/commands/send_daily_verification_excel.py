import io
from datetime import datetime, timezone
import openpyxl
from openpyxl.styles import Font, PatternFill
from django.conf import settings
from django.core.mail import EmailMessage
from django.core.management.base import BaseCommand
from apps.registrations.models import UserRecord


class Command(BaseCommand):
    help = "Generate verified users Excel workbook and email it to the fixed administrator."

    def handle(self, *args, **options):
        recipient = getattr(
            settings, "DAILY_REPORT_RECIPIENT_EMAIL", "kishore.sathayush@gmail.com"
        )
        from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "")
        qs = (
            UserRecord.objects.select_related("user")
            .filter(deleted_at__isnull=True)
            .order_by("-created_at")
        )

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Verified Registrations"
        ws.freeze_panes = "A2"

        headers = [
            "Serial Number",
            "User ID",
            "Registration ID",
            "Full Name",
            "Mobile",
            "Email",
            "Address",
            "City",
            "District",
            "State",
            "Country",
            "Registration Date",
            "Approval Status",
            "QR Status",
            "QR Validity",
            "Last Verification Date",
        ]
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="0F172A")

        count = 0
        for idx, rec in enumerate(qs, start=1):
            count += 1
            latest_qr = rec.qr_codes.order_by("-id").first()
            ws.append(
                [
                    idx,
                    rec.user_id,
                    rec.registration_id,
                    rec.full_name,
                    rec.user.mobile,
                    rec.user.email,
                    rec.address,
                    rec.city,
                    rec.district,
                    rec.state,
                    rec.country,
                    rec.created_at.strftime("%Y-%m-%d %H:%M:%S"),
                    rec.approval_status,
                    latest_qr.status if latest_qr else "NOT_ISSUED",
                    latest_qr.expires_at.strftime("%Y-%m-%d") if latest_qr else "N/A",
                    (
                        latest_qr.last_verified_at.strftime("%Y-%m-%d %H:%M:%S")
                        if latest_qr and latest_qr.last_verified_at
                        else "Never"
                    ),
                ]
            )

        ws.auto_filter.ref = f"A1:P{max(1, count + 1)}"

        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        filename = f"SecureQR_Verified_Users_{today}.xlsx"

        msg = EmailMessage(
            subject=f"Daily Member Verification Report — {today}",
            body=(
                f"Hello Kishore,\n\n"
                f"Attached is today's updated member verification Excel workbook ({filename}) "
                f"containing {count} member record(s), including registration details, approval status, "
                f"and QR pass validity.\n\nWarm regards,\nSecure QR Verification Team"
            ),
            from_email=from_email,
            to=[recipient],
        )
        msg.attach(
            filename,
            buf.getvalue(),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        msg.send(fail_silently=False)
        self.stdout.write(
            self.style.SUCCESS(f"Sent {filename} ({count} records) to {recipient}")
        )
