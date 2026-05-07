import axios from 'axios';

const DEFAULT_DOJAH_BASE_URL = 'https://sandbox.dojah.io';

function getDojahConfig() {
  const baseURL = (process.env.DOJAH_BASE_URL || DEFAULT_DOJAH_BASE_URL).replace(/\/+$/, '');
  const appId = process.env.DOJAH_APP_ID;
  // Normalize secret key: trim, remove surrounding quotes, and strip any leading "Bearer " prefix
  let secretKey = process.env.DOJAH_SECRET_KEY;
  if (typeof secretKey === 'string') {
    secretKey = secretKey.trim();
    if ((secretKey.startsWith('"') && secretKey.endsWith('"')) || (secretKey.startsWith("'") && secretKey.endsWith("'"))) {
      secretKey = secretKey.slice(1, -1).trim();
    }
    secretKey = secretKey.replace(/^Bearer\s+/i, '');
  }

  if (!appId || !secretKey) {
    const missing = [
      !appId ? 'DOJAH_APP_ID' : null,
      !secretKey ? 'DOJAH_SECRET_KEY' : null,
    ].filter(Boolean);
    const err = new Error(`Missing Dojah configuration: ${missing.join(', ')}`);
    err.code = 'DOJAH_CONFIG_MISSING';
    throw err;
  }

  return { baseURL, appId, secretKey };
}

export function getDojahWidgetConfig() {
  const widgetId = process.env.DOJAH_WIDGET_ID;
  if (!widgetId) {
    const err = new Error('Missing Dojah configuration: DOJAH_WIDGET_ID');
    err.code = 'DOJAH_WIDGET_CONFIG_MISSING';
    throw err;
  }

  const baseURL = (process.env.DOJAH_BASE_URL || DEFAULT_DOJAH_BASE_URL).replace(/\/+$/, '');
  const environment = baseURL.includes('sandbox') ? 'sandbox' : 'production';
  return { widgetId, environment };
}

export function normalizeBase64Image(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const commaIndex = raw.indexOf(',');
  if (raw.startsWith('data:') && commaIndex !== -1) {
    return raw.slice(commaIndex + 1).trim();
  }
  return raw;
}

export async function verifyNinWithSelfie({ nin, selfieImage, firstName, lastName }) {
  const { baseURL, appId, secretKey } = getDojahConfig();
  const normalizedSelfie = normalizeBase64Image(selfieImage);

  const body = {
    nin: String(nin || '').trim(),
    selfie_image: normalizedSelfie,
  };

  if (firstName) body.first_name = String(firstName).trim();
  if (lastName) body.last_name = String(lastName).trim();

  const url = `${baseURL}/api/v1/kyc/nin/verify`;
  try {
    const response = await axios.post(url, body, {
      headers: {
        AppId: appId,
        Authorization: secretKey,
        'Content-Type': 'application/json',
      },
      timeout: Number(process.env.DOJAH_TIMEOUT_MS || 30000),
    });
    return response.data;
  } catch (err) {
    // Attach Dojah request context for higher-level logging and debugging
    err._dojahInfo = {
      url,
      method: 'POST',
      requestBodyKeys: Object.keys(body),
      baseURL,
      appId: appId ? String(appId).slice(0, 6) + '...' : undefined,
      authMasked: secretKey ? (String(secretKey).slice(0, 6) + '...') : undefined,
    };
    // Log minimal, non-secret info to stdout/stderr in case caller has no logger
    try {
      console.error('[dojahService] verifyNinWithSelfie error', {
        url: err._dojahInfo.url,
        method: err._dojahInfo.method,
        requestBodyKeys: err._dojahInfo.requestBodyKeys,
        responseStatus: err.response?.status,
        responseDataSnippet: err.response?.data ? (typeof err.response.data === 'object' ? JSON.stringify(err.response.data).slice(0, 400) : String(err.response.data).slice(0, 400)) : undefined,
        authMasked: err._dojahInfo.authMasked,
        message: err.message,
      });
    } catch (logErr) {
      // swallow logging errors
    }
    throw err;
  }
}

export async function getVerificationDetails(referenceId) {
  const { baseURL, appId, secretKey } = getDojahConfig();
  const endpoint = process.env.DOJAH_VERIFICATION_DETAILS_PATH || '/api/v1/kyc/verification';
  const url = `${baseURL}${endpoint}`;
  try {
    const response = await axios.get(url, {
      headers: {
        AppId: appId,
        Authorization: secretKey,
        'Content-Type': 'application/json',
      },
      params: {
        reference_id: String(referenceId || '').trim(),
      },
      timeout: Number(process.env.DOJAH_TIMEOUT_MS || 30000),
    });
    return response.data;
  } catch (err) {
    err._dojahInfo = {
      url,
      method: 'GET',
      params: { reference_id: String(referenceId || '').trim() },
      baseURL,
      appId: appId ? String(appId).slice(0, 6) + '...' : undefined,
      authMasked: secretKey ? (String(secretKey).slice(0, 6) + '...') : undefined,
    };
    try {
      console.error('[dojahService] getVerificationDetails error', {
        url: err._dojahInfo.url,
        method: err._dojahInfo.method,
        params: err._dojahInfo.params,
        responseStatus: err.response?.status,
        responseDataSnippet: err.response?.data ? (typeof err.response.data === 'object' ? JSON.stringify(err.response.data).slice(0, 400) : String(err.response.data).slice(0, 400)) : undefined,
        authMasked: err._dojahInfo.authMasked,
        message: err.message,
      });
    } catch (logErr) { }
    throw err;
  }
}
