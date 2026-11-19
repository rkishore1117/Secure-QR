import logging
import time
from dataclasses import dataclass
from typing import Optional
import requests
from django.conf import settings
from django.core.mail import EmailMultiAlternatives, get_connection

logger = logging.getLogger("secure_qr.email")


@dataclass
class EmailDeliveryOutcome:
    dispatched: bool
    configured: bool
    provider: str
    error: Optional[str] = None


def _redact_secrets(message: str) -> str:
    clean = str(message)
    for attr in ("BREVO_API_KEY", "EMAIL_WEBHOOK_SECRET", "EMAIL_HOST_PASSWORD"):
        val = str(getattr(settings, attr, "") or "")
        if len(val) >= 4:
            clean = clean.replace(val, "[REDACTED]")
    return clean[:300]


def _get_smtp_password() -> str:
    host = str(getattr(settings, "EMAIL_HOST", "") or "").lower()
    password = str(getattr(settings, "EMAIL_HOST_PASSWORD", "") or "")
    if "gmail.com" in host:
        return "".join(password.split())
    return password


def _has_brevo() -> bool:
    return bool(getattr(settings, "BREVO_API_KEY", ""))


def _has_webhook() -> bool:
    url = str(getattr(settings, "EMAIL_WEBHOOK_URL", "") or "")
    return url.startswith("http://") or url.startswith("https://")


def _has_smtp() -> bool:
    return bool(getattr(settings, "EMAIL_HOST_USER", "") and _get_smtp_password())


def get_primary_email_provider() -> tuple[bool, str]:
    if _has_brevo():
        return True, "brevo-https"
    if _has_webhook():
        return True, "https-webhook"
    if _has_smtp():
        return True, "gmail-smtp"
    return False, "console"


def _send_via_brevo(recipient: str, subject: str, text_body: str, html_body: str) -> None:
    api_key = str(getattr(settings, "BREVO_API_KEY", "") or "")
    from_email = str(getattr(settings, "DEFAULT_FROM_EMAIL", "") or "kishore.sathayush@gmail.com")
    payload = {
        "sender": {"name": "Secure QR Verification", "email": from_email},
        "to": [{"email": recipient}],
        "subject": subject,
        "textContent": text_body,
        "htmlContent": html_body,
    }
    headers = {
        "api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    last_exc: Optional[Exception] = None
    for attempt in range(1, 3):
        try:
            resp = requests.post(
                "https://api.brevo.com/v3/smtp/email",
                json=payload,
                headers=headers,
                timeout=12,
            )
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(0.4 * attempt)
                continue
            if not resp.ok:
                raise RuntimeError(f"Brevo API HTTP {resp.status_code}: {resp.text[:200]}")
            return
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < 2:
                time.sleep(0.4 * attempt)
                continue
            raise RuntimeError(f"Brevo HTTPS request failed: {exc}") from exc
    if last_exc:
        raise last_exc


def _send_via_webhook(recipient: str, subject: str, text_body: str, html_body: str) -> None:
    url = str(getattr(settings, "EMAIL_WEBHOOK_URL", "") or "")
    secret = str(getattr(settings, "EMAIL_WEBHOOK_SECRET", "") or "")
    payload = {
        "secret": secret,
        "to": recipient,
        "subject": subject,
        "text": text_body,
        "html": html_body,
        "senderName": "Secure QR Verification",
    }
    for attempt in range(1, 3):
        try:
            resp = requests.post(url, json=payload, timeout=12)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(0.4 * attempt)
                continue
            if not resp.ok:
                raise RuntimeError(f"Webhook HTTP {resp.status_code}: {resp.text[:180]}")
            return
        except requests.RequestException as exc:
            if attempt < 2:
                time.sleep(0.4 * attempt)
                continue
            raise RuntimeError(f"Webhook relay failed: {exc}") from exc


def _send_via_smtp(recipient: str, subject: str, text_body: str, html_body: str) -> None:
    host = str(getattr(settings, "EMAIL_HOST", "smtp.gmail.com"))
    port = int(getattr(settings, "EMAIL_PORT", 587))
    use_tls = bool(getattr(settings, "EMAIL_USE_TLS", True))
    user = str(getattr(settings, "EMAIL_HOST_USER", ""))
    password = _get_smtp_password()
    from_email = str(getattr(settings, "DEFAULT_FROM_EMAIL", "") or user)
    timeout = int(getattr(settings, "EMAIL_TIMEOUT", 10))

    connection = get_connection(
        backend="django.core.mail.backends.smtp.EmailBackend",
        host=host,
        port=port,
        username=user,
        password=password,
        use_tls=use_tls and port != 465,
        use_ssl=(port == 465),
        timeout=timeout,
        fail_silently=False,
    )
    msg = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=from_email,
        to=[recipient],
        connection=connection,
    )
    msg.attach_alternative(html_body, "text/html")
    msg.send(fail_silently=False)


def send_otp_email(
    recipient: str,
    otp: str,
    expiry_minutes: int = 5,
    is_resend: bool = False,
    purpose: str = "REGISTRATION",
) -> EmailDeliveryOutcome:
    configured, primary = get_primary_email_provider()
    if not configured:
        logger.error("Email delivery aborted: no email provider configured.")
        return EmailDeliveryOutcome(
            dispatched=False,
            configured=False,
            provider="console",
            error="No email delivery provider is configured (set BREVO_API_KEY, EMAIL_WEBHOOK_URL, or EMAIL_HOST_USER/EMAIL_HOST_PASSWORD).",
        )

    is_reset = purpose == "PASSWORD_RESET"
    subject = (
        f"Resent Password Reset Code ({otp}) — Secure QR"
        if is_reset and is_resend
        else f"Password Reset Verification Code ({otp}) — Secure QR"
        if is_reset
        else f"Your Resent Verification Code ({otp}) — Secure QR"
        if is_resend
        else f"Your Verification Code ({otp}) — Secure QR"
    )
    text_body = (
        f"Hello,\n\nYour one-time verification code is: {otp}\n\n"
        f"This code expires in {expiry_minutes} minutes. Never share it with anyone.\n\n"
        "Secure QR Verification Authority"
    )
    html_body = (
        "<div style='font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;"
        "border:1px solid #E2E8F0;border-radius:12px;padding:24px;color:#0F172A;'>"
        "<h2 style='margin:0 0 10px 0;'>Verify Your Email Address</h2>"
        f"<p style='font-size:14px;color:#475569;'>Use the 6-digit code below (valid for {expiry_minutes} minutes):</p>"
        f"<div style='background:#F8FAFC;border:1px solid #CBD5E1;border-radius:10px;padding:16px;text-align:center;"
        f"font-family:monospace;font-size:32px;font-weight:700;letter-spacing:8px;'>{otp}</div>"
        "</div>"
    )

    chain = []
    if _has_brevo():
        chain.append(("brevo-https", _send_via_brevo))
    if _has_webhook():
        chain.append(("https-webhook", _send_via_webhook))
    if _has_smtp():
        chain.append(("gmail-smtp", _send_via_smtp))

    domain = recipient.split("@", 1)[1] if "@" in recipient else "unknown"
    errors: list[str] = []

    for provider_name, sender_fn in chain:
        try:
            sender_fn(recipient, subject, text_body, html_body)
            return EmailDeliveryOutcome(dispatched=True, configured=True, provider=provider_name)
        except Exception as exc:
            safe_err = _redact_secrets(str(exc))
            logger.error(
                "Email delivery failure provider=%s recipient_domain=%s error=%s",
                provider_name,
                domain,
                safe_err,
            )
            errors.append(f"{provider_name}: {safe_err}")

    return EmailDeliveryOutcome(
        dispatched=False,
        configured=True,
        provider=primary,
        error=" | ".join(errors),
    )


def check_email_provider_health() -> dict:
    configured, primary = get_primary_email_provider()
    if not configured:
        return {
            "configured": False,
            "healthy": False,
            "provider": "console",
            "detail": "No email delivery provider is configured.",
        }

    if _has_brevo():
        try:
            resp = requests.get(
                "https://api.brevo.com/v3/account",
                headers={"api-key": str(settings.BREVO_API_KEY), "Accept": "application/json"},
                timeout=6,
            )
            if resp.ok:
                return {
                    "configured": True,
                    "healthy": True,
                    "provider": "brevo-https",
                    "detail": "Brevo HTTPS API authenticated and reachable.",
                }
            return {
                "configured": True,
                "healthy": False,
                "provider": "brevo-https",
                "detail": f"Brevo authentication failed (HTTP {resp.status_code}).",
            }
        except requests.RequestException as exc:
            return {
                "configured": True,
                "healthy": False,
                "provider": "brevo-https",
                "detail": _redact_secrets(str(exc)),
            }

    if _has_webhook():
        return {
            "configured": True,
            "healthy": True,
            "provider": "https-webhook",
            "detail": "HTTPS webhook email relay configured.",
        }

    try:
        port = int(getattr(settings, "EMAIL_PORT", 587))
        conn = get_connection(
            backend="django.core.mail.backends.smtp.EmailBackend",
            host=str(getattr(settings, "EMAIL_HOST", "smtp.gmail.com")),
            port=port,
            username=str(getattr(settings, "EMAIL_HOST_USER", "")),
            password=_get_smtp_password(),
            use_tls=bool(getattr(settings, "EMAIL_USE_TLS", True)) and port != 465,
            use_ssl=(port == 465),
            timeout=6,
        )
        conn.open()
        conn.close()
        return {
            "configured": True,
            "healthy": True,
            "provider": "gmail-smtp",
            "detail": f"SMTP connection verified ({settings.EMAIL_HOST}:{port}).",
        }
    except Exception as exc:
        return {
            "configured": True,
            "healthy": False,
            "provider": "gmail-smtp",
            "detail": _redact_secrets(str(exc)),
        }
