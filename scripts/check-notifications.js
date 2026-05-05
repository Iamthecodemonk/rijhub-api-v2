import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import connectDB from '../src/config/db.js';
import initFirebase from '../src/utils/firebaseAdmin.js';
import mongoose from 'mongoose';

// Load .env from repository root (walk up until .env or package.json found)
function findRepoEnv(startDir) {
  let cur = startDir;
  for (let i = 0; i < 6; i++) { // limit depth to avoid infinite loops
    const envPath = path.join(cur, '.env');
    const pkgPath = path.join(cur, 'package.json');
    if (fs.existsSync(envPath)) return envPath;
    if (fs.existsSync(pkgPath)) return envPath; // prefer .env at repo root even if missing
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = findRepoEnv(process.cwd()) || findRepoEnv(__dirname);
if (envPath) {
  const r = dotenv.config({ path: envPath });
  if (r.error) console.warn('dotenv failed to load', r.error);
  else console.log('Loaded env from', envPath);
} else {
  console.warn('.env not found in repo root or ancestors; relying on process env');
}

function mask(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 8) return '******';
  return s.slice(0, 4) + '...' + s.slice(-4);
}

console.log('cwd=', process.cwd());
console.log('__dirname=', __dirname);
console.log('ENV MONGO_URI=', !!process.env.MONGO_URI, 'SMTP_HOST=', !!process.env.SMTP_HOST);
console.log('MONGO_URI (masked)=', mask(process.env.MONGO_URI));
console.log('SMTP_HOST (masked)=', mask(process.env.SMTP_HOST));
console.log('SERVICE_ACCOUNT_KEY_BASE64 present=', !!process.env.SERVICE_ACCOUNT_KEY_BASE64);

async function safeImport(path) {
  try {
    return await import(path);
  } catch (e) {
    return null;
  }
}

async function timeout(promise, ms) {
  let id;
  const timeout = new Promise((_, rej) => { id = setTimeout(() => rej(new Error('timeout')), ms); });
  return Promise.race([promise.finally(() => clearTimeout(id)), timeout]);
}

async function main() {
  console.log('Checking notification configuration...');

  // Connect DB if configured
  if (process.env.MONGO_URI) {
    await connectDB();
  } else {
    console.warn('MONGO_URI not set; DB checks will be skipped');
  }

  const results = {
    smtp: { configured: false, details: {} },
    firebase: { configured: false, details: {} },
    sendchamp: { configured: false },
    termii: { configured: false },
    twilio: { configured: false },
    deviceTokens: { count: null },
    notifications: { count: null },
    socketIo: { note: 'Requires running server to check runtime socket.io presence' }
  };

  // SMTP / nodemailer
  const smtpHost = process.env.SMTP_HOST || null;
  if (smtpHost) {
    results.smtp.configured = true;
    results.smtp.details.host = smtpHost;
    results.smtp.details.port = process.env.SMTP_PORT || null;
    try {
      const mod = await safeImport('nodemailer');
      const nodemailer = mod?.default || mod;
      if (nodemailer) {
        results.smtp.details.nodemailer = true;
        // Attempt to create transporter and verify (with timeout)
        try {
          const port = Number(process.env.SMTP_PORT) || 587;
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: port,
            secure: port === 465,
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
          });
          if (transporter && typeof transporter.verify === 'function') {
            try {
              await timeout(transporter.verify(), 5000);
              results.smtp.details.verify = 'ok';
            } catch (e) {
              results.smtp.details.verify = `failed: ${e.message}`;
            }
          }
        } catch (e) {
          results.smtp.details.verify = `failed to init transporter: ${e.message}`;
        }
      } else {
        results.smtp.details.nodemailer = false;
      }
    } catch (e) {
      results.smtp.details.nodemailer = false;
    }
  }

  // Firebase admin
  try {
    const admin = initFirebase();
    if (admin) {
      results.firebase.configured = true;
      try {
        results.firebase.appName = admin?.apps?.[0]?.name || 'default';
      } catch (e) {}
    } else {
      results.firebase.configured = false;
    }
  } catch (e) {
    results.firebase.configured = false;
    results.firebase.error = e?.message || String(e);
  }

  // SendChamp / Termii / Twilio
  results.sendchamp.configured = !!process.env.SENDCHAMP_API_KEY;
  results.termii.configured = !!process.env.TERMII_API_KEY;
  results.twilio.configured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

  // Count device tokens and notifications if DB connected
  try {
    if (mongoose.connection.readyState === 1) {
      try {
        const DeviceTokenMod = await safeImport('../src/models/DeviceToken.js');
        const NotificationMod = await safeImport('../src/models/Notification.js');
        const DeviceToken = DeviceTokenMod?.default;
        const Notification = NotificationMod?.default;
        if (DeviceToken) results.deviceTokens.count = await DeviceToken.countDocuments();
        if (Notification) results.notifications.count = await Notification.countDocuments();
      } catch (e) {
        results.deviceTokens.error = e?.message || String(e);
      }
    } else {
      results.deviceTokens.note = 'DB not connected; cannot count DeviceToken or Notification documents';
    }
  } catch (e) {
    results.deviceTokens.error = e?.message || String(e);
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error('Check failed:', err);
  process.exit(2);
});
