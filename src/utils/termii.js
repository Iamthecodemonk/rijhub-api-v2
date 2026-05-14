import axios from 'axios';

const API_BASE = 'https://v3.api.termii.com';

/**
 * Sends an OTP via Termii.
 */
async function sendOtp(to, code, options = {}) {
  const API_KEY = process.env.TERMII_API_KEY;
  if (!API_KEY) return { success: false, error: 'termii_api_key_missing' };
  // support both sendOtp(to, options) and sendOtp(to, code, options)
  if (typeof code === 'object') {
    options = code || {};
    code = undefined;
  }

  const from = options.from || process.env.TERMII_SENDER_ID || 'N-Alert';
  const channel = options.channel || process.env.TERMII_CHANNEL || 'dnd';
  const pin_length = options.pin_length || 6;
  
  // FIX: Termii's /sms/otp/send expects pin_time_to_live in MINUTES (Max 60).
  // If your env var is in seconds (e.g., 300), we convert it.
  const ttlInSeconds = Number(process.env.TERMII_PIN_TTL) || 300;
  let ttlMinutes = options.pin_time_to_live || Math.round(ttlInSeconds / 60);
  
  // Final safety check: must be between 1 and 60.
  ttlMinutes = Math.min(60, Math.max(1, ttlMinutes));

  const COMPANY = process.env.COMPANY_NAME || 'RijHub';
  const defaultMessage = `Your ${COMPANY} verification code is {{pin}}. It expires in ${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'}`;

  const payload = {
    api_key: API_KEY,
    to: String(to),
    from,
    channel,
    message_type: 'NUMERIC',
    pin_attempts: options.pin_attempts || 3,
    pin_time_to_live: ttlMinutes, // Now sending minutes (e.g., 5)
    pin_length,
    pin_type: 'NUMERIC',
    message_text: options.message_text || options.message || defaultMessage,
    pin_placeholder: options.pin_placeholder || '{{pin}}',
  };

  // If server provided a PIN (code) we must NOT call the OTP endpoint with a 'pin' field
  // Termii's OTP endpoint does not accept 'pin' — instead use the Messaging API to send the code.
  const providedPin = code || options.pin || options.otp;
  if (providedPin) {
    const COMPANY = 'RijHub';
    const message = options.message_text || options.message || `Your ${COMPANY} verification code is ${providedPin}.`;
    const msgPayload = {
      api_key: API_KEY,
      to: String(to),
      from,
      sms: message,
      type: 'plain',
      channel
    };

    try {
      const url = `${API_BASE}/api/sms/send`;
      const res = await axios.post(url, msgPayload, { timeout: 10000 });
      return { success: true, provider: 'termii', manual: true, info: res.data };
    } catch (e) {
      return { success: false, provider: 'termii', error: e?.response?.data || e?.message || String(e) };
    }
  }

  // Otherwise, let Termii generate and manage the OTP using their OTP endpoint
  try {
    const url = `${API_BASE}/api/sms/otp/send`;
    const res = await axios.post(url, payload, { timeout: 10000 });

    if (res.data && (res.data.pinId || res.data.status === 'success' || res.status === 200)) {
      return { success: true, provider: 'termii', pinId: res.data.pinId, info: res.data };
    }

    return { success: false, provider: 'termii', error: res.data };
  } catch (e) {
    return { success: false, provider: 'termii', error: e?.response?.data || e?.message || String(e) };
  }
}

/**
 * Verifies the OTP entered by the user.
 */
async function verifyOtp(pinId, code) {
  const API_KEY = process.env.TERMII_API_KEY;
  if (!API_KEY) return { success: false, error: 'termii_api_key_missing' };

  try {
    const url = `${API_BASE}/api/sms/otp/verify`;
    const payload = { 
      api_key: API_KEY, 
      pin_id: pinId, 
      pin: String(code) 
    };

    const res = await axios.post(url, payload, { timeout: 10000 });
    
    // Termii returns 'verified': true or 'verified': "true"
    if (res.data && (res.data.verified === true || res.data.verified === "true")) {
      return { success: true, provider: 'termii', info: res.data };
    }
    
    return { success: false, provider: 'termii', error: res.data };
  } catch (e) {
    return { 
      success: false, 
      provider: 'termii', 
      error: e?.response?.data || e?.message || String(e) 
    };
  }
}

export { sendOtp, verifyOtp };
export default { sendOtp, verifyOtp };
