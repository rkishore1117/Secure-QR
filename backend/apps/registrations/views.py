import hashlib
import hmac
import os
import secrets
from datetime import timedelta
from django.db import transaction
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from apps.accounts.models import UserAccount
from .models import OTPVerification, RegistrationRequest, UserRecord
from .sms import send_otp_sms


def _hash_otp(mobile: str, otp: str) -> str:
    pepper = os.environ.get("OTP_PEPPER", "secure-qr-otp-pepper").encode()
    return hmac.new(pepper, f"{mobile}:{otp}".encode(), hashlib.sha256).hexdigest()


class SendOtpView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        mobile = str(request.data.get("mobile", "")).strip()
        purpose = str(request.data.get("purpose", "REGISTRATION")).upper()
        if not mobile:
            return Response(
                {"error": "Please enter a valid mobile number."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if purpose == "REGISTRATION" and UserAccount.objects.filter(mobile=mobile).exists():
            return Response(
                {"error": "This mobile number is already registered."},
                status=status.HTTP_409_CONFLICT,
            )

        cutoff = timezone.now() - timedelta(minutes=30)
        recent = OTPVerification.objects.filter(mobile=mobile, created_at__gte=cutoff).order_by("-id")
        is_resend = recent.exists()

        otp = f"{secrets.randbelow(900000) + 100000}"
        otp_rec = OTPVerification.objects.create(
            mobile=mobile,
            purpose=purpose,
            otp_hash=_hash_otp(mobile, otp),
            expires_at=timezone.now() + timedelta(minutes=5),
            ip_address=request.META.get("REMOTE_ADDR"),
        )
        sms_result = send_otp_sms(mobile, otp, is_resend=is_resend)
        return Response(
            {
                "otpRequestId": otp_rec.id,
                "mobile": mobile,
                "expiresInSeconds": 300,
                "smsProvider": sms_result.get("provider"),
                "smsDispatched": sms_result.get("dispatched", False),
                "message": "Verification code sent to your mobile number.",
            }
        )


class VerifyOtpView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        mobile = str(request.data.get("mobile", "")).strip()
        otp = str(request.data.get("otp", "")).strip()
        latest = OTPVerification.objects.filter(mobile=mobile, used_at__isnull=True).order_by("-id").first()
        if not latest:
            return Response({"error": "No active verification code found."}, status=status.HTTP_400_BAD_REQUEST)
        if latest.expires_at < timezone.now():
            return Response({"error": "This code has expired. Please request a new one."}, status=status.HTTP_400_BAD_REQUEST)
        if latest.attempts >= latest.max_attempts:
            return Response({"error": "Too many incorrect attempts."}, status=status.HTTP_429_TOO_MANY_REQUESTS)

        if not hmac.compare_digest(latest.otp_hash, _hash_otp(mobile, otp)):
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
            id=otp_id, mobile=mobile, verified_at__isnull=False, used_at__isnull=True
        ).first()
        if not otp_rec:
            return Response({"error": "Please verify your mobile number via SMS first."}, status=status.HTTP_400_BAD_REQUEST)

        if UserAccount.objects.filter(email=email).exists() or UserAccount.objects.filter(mobile=mobile).exists():
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
                is_mobile_verified=True,
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
                notes="Application submitted with verified mobile number.",
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
