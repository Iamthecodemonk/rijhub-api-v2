import Notification from '../models/Notification.js';
import DeviceToken from '../models/DeviceToken.js';
import initFirebase from './firebaseAdmin.js';
const Artisan = (await import('../models/Artisan.js')).default;
const User = (await import('../models/User.js')).default;

let transporter = null;
let transporterInitAttempted = false;

async function initTransporter(fastify) {
  if (transporter) return transporter;
  transporterInitAttempted = true;
  if (!process.env.SMTP_HOST) return null;
  try {
    const mod = await import('nodemailer');
    const nodemailer = mod?.default || mod;
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: port,
      secure: port === 465, // true for 465, false for other ports like 587
      auth: process.env.SMTP_USER ? { 
        user: process.env.SMTP_USER, pass: process.env.SMTP_PASS 
      } : undefined,
    });
    return transporter;
  } catch (err) {
    // nodemailer not installed or failed to import — log and continue without email
    transporter = null;
    transporterInitAttempted = false;
    fastify?.log?.warn?.('nodemailer not available; email notifications disabled');
    return null;
  }
}

export async function createNotification(fastify, userId, { type, title, body, data = {} }) {
  // Normalize userId so callers may pass populated objects or raw ids
  const uid = (userId && (userId._id || userId.id)) ? (userId._id || userId.id) : userId;
  const uidStr = uid ? String(uid) : uid;
  fastify?.log?.info?.({ userId: uidStr, type, title, sendEmail: !!data?.sendEmail }, 'notification:create:start');
  const n = await Notification.create({ userId: uidStr, type, title, body, data });
  fastify?.log?.info?.({ notificationId: String(n._id), userId: uidStr, type }, 'notification:create:in_app_saved');
  // try emitting over websocket/socket if available
  try {
    if (fastify && fastify.io && uidStr) {
      fastify.io.to(uidStr).emit('notification', n);
      fastify?.log?.info?.({ notificationId: String(n._id), userId: uidStr }, 'notification:socket:emitted');
    } else {
      fastify?.log?.debug?.({ notificationId: String(n._id), hasFastify: !!fastify, hasIo: !!fastify?.io, userId: uidStr }, 'notification:socket:skipped');
    }
  } catch (e) {
    fastify?.log?.error?.('socket emit failed', e?.message);
  }

  // optional email
  try {
    // lazy initialize transporter if needed
    if (!transporter) await initTransporter(fastify);
    if (transporter && data?.sendEmail) {
      const to = data.email || data.to;
      if (to) {
        fastify?.log?.info?.({ notificationId: String(n._id), to, subject: title }, 'notification:email:sending');
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'no-reply@example.com',
          to,
          subject: title,
          text: body,
        });
        fastify?.log?.info?.({ notificationId: String(n._id), to }, 'notification:email:sent');
      } else {
        fastify?.log?.warn?.({ notificationId: String(n._id), dataKeys: Object.keys(data || {}) }, 'notification:email:skipped_missing_recipient');
      }
    } else if (data?.sendEmail) {
      fastify?.log?.warn?.({ notificationId: String(n._id), smtpHostConfigured: !!process.env.SMTP_HOST }, 'notification:email:skipped_no_transporter');
    } else {
      fastify?.log?.debug?.({ notificationId: String(n._id) }, 'notification:email:skipped_not_requested');
    }
  } catch (e) {
    fastify?.log?.error?.({ err: e, message: e?.message, stack: e?.stack }, 'sendMail failed');
  }

  // Send push via FCM if tokens exist
  try {
    // initialize firebase admin if configured
    const admin = initFirebase();
    if (admin) {
      const tokens = (await DeviceToken.find({ userId: uidStr }).lean()).map(d => d.token).filter(Boolean);
      if (tokens.length) {
        fastify?.log?.info?.({ notificationId: String(n._id), userId: uidStr, tokenCount: tokens.length }, 'notification:fcm:sending');
        // build individual messages per token and use sendAll (sendMulticast deprecated)
        const perTokenData = Object.keys(data || {}).reduce((acc, k) => { acc[k] = String(data[k]); return acc; }, {});
        const messages = tokens.map(t => ({ notification: { title: title || '', body: body || '' }, data: perTokenData, token: t }));
        // send messages individually to avoid deprecated batch APIs
        const sendResults = await Promise.allSettled(messages.map(msg => admin.messaging().send(msg)));
        const failures = [];
        sendResults.forEach((r, i) => {
          if (r.status === 'rejected') {
            const token = messages[i]?.token || tokens[i];
            failures.push(token);
          }
        });
        if (failures.length) {
          try { await DeviceToken.deleteMany({ token: { $in: failures } }); } catch (e) { fastify?.log?.warn?.('failed to cleanup device tokens', e?.message); }
        }
        fastify?.log?.info?.({ notificationId: String(n._id), userId: uidStr, tokenCount: tokens.length, failureCount: failures.length }, 'notification:fcm:done');
      } else {
        fastify?.log?.debug?.({ notificationId: String(n._id), userId: uidStr }, 'notification:fcm:skipped_no_tokens');
      }
    } else {
      fastify?.log?.warn?.({ notificationId: String(n._id), firebaseConfigured: false }, 'notification:fcm:skipped_firebase_not_configured');
    }
  } catch (e) {
    fastify?.log?.warn?.('fcm send failed', e?.message || e);
  }

  return n;
}

// Send password reset email
export async function sendPasswordResetEmail(fastify, email, resetToken, userName = 'User') {
  try {
    // Initialize transporter if needed
    if (!transporter) await initTransporter(fastify);
    
    if (!transporter) {
      fastify?.log?.warn?.('Email transport not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env');
      return { success: false, message: 'Email service not configured' };
    }

    // Only include the token in emails by default. Optional web reset link can be set via MOBILE_RESET_URL_WEB
    const webResetUrl = process.env.MOBILE_RESET_URL_WEB || null;

    const mailOptions = {
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'Password Reset Request - RijHub Platform',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            :root{--brand:#a20125;--dark:#020202;--soft:#f3e6e9}
            body{font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,'Helvetica Neue',Arial; background:#ffffff; color:var(--dark); margin:0}
            .container{max-width:600px;margin:0 auto;padding:0}
            .header{background:var(--brand);color:#fff;padding:28px 20px;text-align:center;border-radius:8px 8px 0 0}
            .header h1{margin:0;font-size:20px;letter-spacing:0.2px}
            .card{background:var(--soft);padding:28px;border-radius:0 0 8px 8px;border:1px solid rgba(0,0,0,0.04)}
            .lead{font-size:15px;margin:0 0 18px;color:var(--dark)}
            .token{display:inline-block;padding:16px 28px;font-size:28px;font-weight:700;color:var(--brand);background:#fff;border:2px solid var(--brand);border-radius:10px;letter-spacing:4px}
            .cta{display:inline-block;margin-top:18px;padding:12px 20px;background:var(--dark);color:#fff;text-decoration:none;border-radius:8px}
            .footer{padding:18px;text-align:center;color:#666;font-size:12px}
            .warning{color:var(--brand);font-weight:700;margin-top:12px}
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Password Reset Request</h1>
            </div>
            <div class="content">
              <p>Hello ${userName},</p>
              <p>We received a request to reset your password for your Artisan Platform account.</p>
              <p class="lead">Use the token below to reset your password in the app or web form.</p>
              <div style="text-align:center">
                <span class="token">${resetToken}</span>
              </div>
              ${webResetUrl ? `
                <p style="text-align:center;margin-top:18px"><a class="cta" href="${webResetUrl}">Open web reset page</a></p>
              ` : ''}
              <p class="warning">⚠️ This token will expire in 1 hour.</p>
              <p>If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
            </div>
            <div class="footer">
              <p>© 2026 Artisan Platform. All rights reserved.</p>
              <p>For support, contact us at support@rijhub.com</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
    Hello ${userName},

    We received a request to reset your password for your Artisan Platform account.

    Use this token to reset your password (expires in 1 hour):
    ${resetToken}

    If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.

    © 2026 Artisan Platform
    For support, contact us at support@rijhub.com
      `
    };

        await transporter.sendMail(mailOptions);
        fastify?.log?.info?.({ email }, 'Password reset email sent successfully');
    
    return { success: true, message: 'Password reset email sent' };
  } catch (err) {
    fastify?.log?.error?.({ email, err, error: err.message, stack: err.stack, code: err.code, response: err.response }, 'Failed to send password reset email');
    return { success: false, message: 'Failed to send email', error: err.message };
  }
}

// Generic email sender
export async function sendEmail(fastify, to, subject, html, text) {
  try {
    if (!transporter) await initTransporter(fastify);
    if (!transporter) {
      fastify?.log?.warn?.('Email transport not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env');
      return { success: false, message: 'Email service not configured' };
    }
    const mailOptions = {
      from: process.env.SMTP_FROM || 'no-reply@rijhub.com',
      to,
      subject,
      html: html || text || '',
      text: text || (html ? html.replace(/<[^>]*>/g, '') : ''),
    };
    await transporter.sendMail(mailOptions);
    return { success: true };
  } catch (err) {
    fastify?.log?.error?.({ to, err }, 'sendEmail failed');
    return { success: false, message: err?.message || String(err) };
  }
}

// Notify a set of artisans when a new job is posted.
// Options:
// - tradeFilter: array of trades to limit recipients to artisans who offer those trades
// - limit: max number of artisans to notify (default: 0 => no limit)
// - title/body: override notification title/body
// - sendEmail: boolean to include email if artisan has email
export async function notifyArtisansAboutJob(fastify, job, options = {}) {
  try {
    const tradeFilter = options.tradeFilter || (Array.isArray(job.trade) && job.trade.length ? job.trade : null);
    const q = {};
    if (tradeFilter && Array.isArray(tradeFilter) && tradeFilter.length) q.trade = { $in: tradeFilter };

    let query = Artisan.find(q).sort({ createdAt: -1 });
    if (options.limit && Number(options.limit) > 0) query = query.limit(Number(options.limit));

    const artisans = await query.populate('userId', 'name email');
    const title = options.title || `New job posted: ${job.title || 'New Job'}`;
    const body = options.body || (job.description ? job.description.substring(0, 200) : 'A new job was posted that may interest you.');

    for (const art of artisans) {
      try {
        if (!art?.userId) continue;
        const userId = art.userId._id || art.userId;
        await createNotification(fastify, userId, { type: 'job', title, body, data: { jobId: job._id, jobTitle: job.title, sendEmail: !!options.sendEmail, email: art.userId.email } });
      } catch (e) {
        fastify?.log?.warn?.('notifyArtisansAboutJob - notify failed', e?.message || e);
      }
    }

    return { ok: true, count: artisans.length };
  } catch (err) {
    fastify?.log?.error?.('notifyArtisansAboutJob failed', err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}
