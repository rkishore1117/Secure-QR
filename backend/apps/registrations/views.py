import hashlib
import hmac
import re
import secrets
from datetime import timedelta
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from apps.accounts.models import UserAccount
from .email_service import send_otp_email
from .models import OTPVerification, RegistrationRequest, UserRecord

_EMAIL_RE = re.compile(r"^\S+@\S+\.\S+$")


def _hash_otp(email: str, otp: str) -> str:
    pepper = str(getattr(settings, "OTP_PEPPER", "") or "dev-only-otp-pepper").encode("utf-8")
    return hmac.new(pepper, f"{email.strip().lower()}:{otp}".encode("utf-8"), hashlib.sha256).hexdigest()


class SendOtpView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = "otp_send"

    def post(self, request):
        email = str(request.data.get("email", "")).strip().lower()
        raw_purpose = str(request.data.get("purpose", "REGISTRATION")).strip().upper()
        purpose = "PASSWORD_RESET" if raw_purpose == "PASSWORD_RESET" else "REGISTRATION"

        if not _EMAIL_RE.match(email):
            return Response(
                {"error": "Please enter a valid email address."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if purpose == "REGISTRATION":
            if UserAccount.objects.filter(email__iexact=email).exists():
                return Response(
                    {"error": "This email address is already registered."},
                    status=status.HTTP_409_CONFLICT,
                )
        else:
            account = UserAccount.objects.filter(email__iexact=email, deleted_at__isnull=True).first()
            if not account:
                return Response(
                    {"error": "No registered account found with this email address."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            if not account.is_active:
                return Response(
                    {"error": "This account is currently deactivated. Please contact your Super Admin."},
                    status=status.HTTP_403_FORBIDDEN,
                )

        now = timezone.now()
        window_start = now - timedelta(minutes=30)
        recent_qs = OTPVerification.objects.filter(
            email__iexact=email, purpose=purpose, created_at__gte=window_start
        ).order_by("-id")
        recent_list = list(recent_qs[:5])

        if len(recent_list) >= 5:
            return Response(
                {"error": "OTP resend limit reached for this email address. Try again in 30 minutes."},
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )

        if recent_list:
            elapsed_seconds = (now - recent_list[0].created_at).total_seconds()
            if elapsed_seconds < 30:
                wait_seconds = max(1, int(30 - elapsed_seconds))
                return Response(
                    {"error": f"Please wait {wait_seconds}s before requesting another OTP."},
                    status=status.HTTP_429_TOO_MANY_REQUESTS,
                )

        otp = f"{secrets.randbelow(900000) + 100000}"
        otp_rec = OTPVerification.objects.create(
            email=email,
            mobile="",
            purpose=purpose,
            otp_hash=_hash_otp(email, otp),
            expires_at=now + timedelta(minutes=5),
            ip_address=request.META.get("REMOTE_ADDR"),
        )

        outcome = send_otp_email(
            recipient=email,
            otp=otp,
            expiry_minutes=5,
            is_resend=len(recent_list) > 0,
            purpose=purpose,
        )

        if not outcome.dispatched:
            otp_rec.delete()
            err_status = (
                status.HTTP_502_BAD_GATEWAY if outcome.configured else status.HTTP_503_SERVICE_UNAVAILABLE
            )
            return Response(
                {
                    "error": (
                        f"Could not deliver verification email ({outcome.error or 'Email delivery failed'})."
                        if outcome.configured
                        else "No email delivery provider is configured on this server. Set BREVO_API_KEY, EMAIL_WEBHOOK_URL, or EMAIL_HOST_USER/EMAIL_HOST_PASSWORD."
                    ),
                    "emailDispatched": False,
                    "emailConfigured": outcome.configured,
                    "emailProvider": outcome.provider,
                    "emailError": outcome.error,
                },
                status=err_status,
            )

        # Supersede any earlier unused OTPs for this email & purpose
        OTPVerification.objects.filter(
            email__iexact=email, purpose=purpose, used_at__isnull=True, id__lt=otp_rec.id
        ).update(used_at=now)

        return Response(
            {
                "otpRequestId": otp_rec.id,
                "email": email,
                "expiresInSeconds": 300,
                "emailProvider": outcome.provider,
                "emailDispatched": True,
                "emailConfigured": outcome.configured,
                "emailError": None,
                "message": f"Verification code sent to {email}.",
            }
        )


class VerifyOtpView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        email = str(request.data.get("email", "")).strip().lower()
        otp = str(request.data.get("otp", "")).strip()
        latest = OTPVerification.objects.filter(email__iexact=email, used_at__isnull=True).order_by("-id").first()
        if not latest:
            return Response({"error": "No active verification code found."}, status=status.HTTP_400_BAD_REQUEST)
        if latest.expires_at < timezone.now():
            return Response({"error": "This code has expired. Please request a new one."}, status=status.HTTP_400_BAD_REQUEST)
        if latest.attempts >= latest.max_attempts:
            return Response({"error": "Too many incorrect attempts."}, status=status.HTTP_429_TOO_MANY_REQUESTS)

        if not hmac.compare_digest(latest.otp_hash, _hash_otp(email, otp)):
            latest.attempts += 1
            latest.save(update_fields=["attempts"])
            return Response({"error": "Incorrect verification code."}, status=status.HTTP_400_BAD_REQUEST)

        latest.verified_at = timezone.now()
        latest.save(update_fields=["verified_at"])
        return Response({"verified": True, "otpVerificationId": latest.id, "verifiedAt": latest.verified_at})


class RegisterUserView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def post(self, request):
        data = request.data
        email = str(data.get("email", "")).strip().lower()
        mobile = str(data.get("mobile", "")).strip()
        password = str(data.get("password", ""))
        otp_id = data.get("otpVerificationId")

        otp_rec = OTPVerification.objects.filter(
            id=otp_id, email__iexact=email, verified_at__isnull=False, used_at__isnull=True
        ).first()
        if not otp_rec:
            return Response({"error": "Please verify your email address with the one-time code first."}, status=status.HTTP_400_BAD_REQUEST)

        if UserAccount.objects.filter(email__iexact=email).exists() or UserAccount.objects.filter(mobile=mobile).exists():
            return Response({"error": "An account with this email or mobile already exists."}, status=status.HTTP_409_CONFLICT)

        now = timezone.now()
        with transaction.atomic():
            otp_rec.used_at = now
            otp_rec.save(update_fields=["used_at"])

            user = UserAccount.objects.create_user(
                email=email,
                mobile=mobile,
                password=password,
                role="USER",
                is_mobile_verified=False,
                is_email_verified=True,
            )
            reg_id = f"SQR-{now.year}-{100000 + user.id:06d}"
            # STORAGES["default"] automatically stores profile_photo & id_proof_document in AWS S3 (sathayush/photos/ and sathayush/id_proofs/)
            rec = UserRecord.objects.create(
                user=user,
                registration_id=reg_id,
                full_name=str(data.get("fullName", "")).strip(),
                address=str(data.get("address", "")).strip(),
                city=str(data.get("city", "")).strip(),
                district=str(data.get("district", "")).strip(),
                state=str(data.get("state", "")).strip(),
                country=str(data.get("country", "")).strip(),
                postal_code=str(data.get("postalCode", "")).strip(),
                profile_photo=request.FILES.get("profilePhoto"),
                id_proof_type=str(data.get("idProofType", "National ID")),
                id_proof_document=request.FILES.get("idProofDocument"),
                consent_accepted=True,
                consent_timestamp=now,
                approval_status="PENDING",
            )
            RegistrationRequest.objects.create(
                user_record=rec,
                request_type="INITIAL",
                status="PENDING",
                notes="Application submitted with verified email OTP.",
            )

        return Response(
            {
                "success": True,
                "registrationId": reg_id,
                "status": "PENDING",
                "profilePhotoUrl": rec.profile_photo.url if rec.profile_photo else "",
                "idProofUrl": rec.id_proof_document.url if rec.id_proof_document else "",
                "message": "Your application has been received and is awaiting review.",
            },
            status=status.HTTP_201_CREATED,
        )
