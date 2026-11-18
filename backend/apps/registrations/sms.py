import os
import re
import requests
from django.conf import settings


def send_otp_sms(mobile: str, otp: str, is_resend: bool = False) -> dict:
    user = getattr(settings, "SMS_USER", "")
    password = getattr(settings, "SMS_PASSWORD", "")
    sender = getattr(settings, "SMS_SENDER", "STYUSH")
    sms_type = getattr(settings, "SMS_TYPE", "3")
    template_id = (
        getattr(settings, "RE_SMS_TEMPLATE_ID", "") or getattr(settings, "SMS_TEMPLATE_ID", "")
        if is_resend
        else getattr(settings, "SMS_TEMPLATE_ID", "")
    )
    gateway_url = os.environ.get(
        "SMS_GATEWAY_URL", "http://api.bulksmsgateway.in/sendmessage.php"
    )

    if not user or not password or not template_id:
        return {"dispatched": False, "provider": "console", "template_id": template_id}

    clean_mobile = re.sub(r"\D", "", mobile)
    raw_template = os.environ.get(
        "SMS_MESSAGE_TEMPLATE",
        "Dear user your OTP to verify your Gramadevata User account is {otp}. Thank You! team Sathayush.",
    )
    message = raw_template.replace("{otp}", str(otp))

    try:
        resp = requests.get(
            gateway_url,
            params={
                "user": user,
                "password": password,
                "mobile": clean_mobile,
                "message": message,
                "sender": sender,
                "type": sms_type,
                "template_id": template_id,
            },
            timeout=5,
        )
        body = resp.text[:200]
        lower_body = body.lower()
        failed = any(word in lower_body for word in ("error", "invalid", "failed"))
        return {
            "dispatched": resp.ok and not failed,
            "provider": "bulksmsgateway",
            "template_id": template_id,
            "status_code": resp.status_code,
            "gateway_response": body,
        }
    except Exception as exc:
        return {
            "dispatched": False,
            "provider": "bulksmsgateway",
            "template_id": template_id,
            "error": str(exc),
        }
