export interface SmsDispatchResult {
  dispatched: boolean;
  provider: string;
  templateId: string;
  gatewayResponse?: string;
  error?: string;
}

export async function dispatchOtpSms(
  mobile: string,
  otp: string,
  isResend = false,
): Promise<SmsDispatchResult> {
  const user = process.env['SMS_USER'] || '';
  const password = process.env['SMS_PASSWORD'] || '';
  const sender = process.env['SMS_SENDER'] || 'STYUSH';
  const smsType = process.env['SMS_TYPE'] || '3';
  const templateId = isResend
    ? process.env['RE_SMS_TEMPLATE_ID'] || process.env['SMS_TEMPLATE_ID'] || ''
    : process.env['SMS_TEMPLATE_ID'] || '';
  const gatewayUrl =
    process.env['SMS_GATEWAY_URL'] || 'http://api.bulksmsgateway.in/sendmessage.php';

  if (!user || !password || !templateId) {
    return {
      dispatched: false,
      provider: 'console',
      templateId,
    };
  }

  const cleanMobile = mobile.replace(/[^\d]/g, '');
  const rawTemplate =
    process.env['SMS_MESSAGE_TEMPLATE'] ||
    'Dear user your OTP to verify your Gramadevata User account is {otp}. Thank You! team Sathayush.';
  const message = rawTemplate.replace('{otp}', otp);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const params = new URLSearchParams({
      user,
      password,
      mobile: cleanMobile,
      message,
      sender,
      type: smsType,
      template_id: templateId,
    });

    const response = await fetch(`${gatewayUrl}?${params.toString()}`, {
      method: 'GET',
      signal: controller.signal,
    });
    const bodyText = await response.text();
    clearTimeout(timer);

    const lowerBody = bodyText.toLowerCase();
    const failedText =
      lowerBody.includes('error') ||
      lowerBody.includes('invalid') ||
      lowerBody.includes('failed');

    return {
      dispatched: response.ok && !failedText,
      provider: 'bulksmsgateway',
      templateId,
      gatewayResponse: bodyText.slice(0, 200),
      ...(response.ok && !failedText ? {} : {error: bodyText.slice(0, 200) || `HTTP ${response.status}`}),
    };
  } catch (err) {
    return {
      dispatched: false,
      provider: 'bulksmsgateway',
      templateId,
      error: err instanceof Error ? err.message : 'SMS gateway unreachable',
    };
  }
}
