import axios from 'axios';

const DEFAULT_DOJAH_BASE_URL = 'https://sandbox.dojah.io';

function getDojahConfig() {
  const baseURL = (process.env.DOJAH_BASE_URL || DEFAULT_DOJAH_BASE_URL).replace(/\/+$/, '');
  const appId = process.env.DOJAH_APP_ID;
  const secretKey = process.env.DOJAH_SECRET_KEY;

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

  const response = await axios.post(`${baseURL}/api/v1/kyc/nin/verify`, body, {
    headers: {
      AppId: appId,
      Authorization: secretKey,
      'Content-Type': 'application/json',
    },
    timeout: Number(process.env.DOJAH_TIMEOUT_MS || 30000),
  });

  return response.data;
}

export async function getVerificationDetails(referenceId) {
  const { baseURL, appId, secretKey } = getDojahConfig();
  const endpoint = process.env.DOJAH_VERIFICATION_DETAILS_PATH || '/api/v1/kyc/verification';

  const response = await axios.get(`${baseURL}${endpoint}`, {
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
}
