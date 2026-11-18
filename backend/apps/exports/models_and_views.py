import openpyxl
from openpyxl.styles import Font, PatternFill
from django.db import models
from django.http import HttpResponse
from rest_framework.views import APIView
from apps.accounts.models import UserAccount
from apps.accounts.permissions import HasAdminPermission
from apps.registrations.models import UserRecord


class ExportHistory(models.Model):
    admin_user = models.ForeignKey(UserAccount, on_delete=models.CASCADE)
    admin_email = models.EmailField()
    filters = models.JSONField(default=dict)
    record_count = models.PositiveIntegerField()
    filename = models.CharField(max_length=255)
    exported_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "export_history"


class ExcelExportView(APIView):
    permission_classes = [HasAdminPermission]
    required_permission = "can_export_excel"

    def get(self, request):
        qs = UserRecord.objects.select_related("user").filter(deleted_at__isnull=True)
        status = request.query_params.get("status")
        if status and status != "ALL":
            qs = qs.filter(approval_status=status)

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Verified Registrations"
        ws.freeze_panes = "A2"

        headers = [
            "Serial Number", "User ID", "Registration ID", "Full Name", "Mobile", "Email",
            "Address", "City", "District", "State", "Country", "Registration Date",
            "Approval Status", "QR Status", "QR Validity", "Last Verification Date",
        ]
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="0F172A")

        for idx, rec in enumerate(qs, start=1):
            latest_qr = rec.qr_codes.order_by("-id").first()
            ws.append([
                idx, rec.user_id, rec.registration_id, rec.full_name, rec.user.mobile, rec.user.email,
                rec.address, rec.city, rec.district, rec.state, rec.country,
                rec.created_at.strftime("%Y-%m-%d %H:%M:%S"), rec.approval_status,
                latest_qr.status if latest_qr else "NOT_ISSUED",
                latest_qr.expires_at.strftime("%Y-%m-%d") if latest_qr else "N/A",
                latest_qr.last_verified_at.strftime("%Y-%m-%d %H:%M:%S") if latest_qr and latest_qr.last_verified_at else "Never",
            ])

        ws.auto_filter.ref = f"A1:P{max(1, qs.count() + 1)}"
        filename = "SecureQR_Export.xlsx"
        ExportHistory.objects.create(
            admin_user=request.user,
            admin_email=request.user.email,
            filters=dict(request.query_params),
            record_count=qs.count(),
            filename=filename,
        )

        resp = HttpResponse(
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        resp["Content-Disposition"] = f'attachment; filename="{filename}"'
        wb.save(resp)
        return resp
