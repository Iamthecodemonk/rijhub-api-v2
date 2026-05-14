import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import crypto from 'crypto';
import axios from 'axios';
import User from '../models/User.js';
import RegistrationOtp from '../models/RegistrationOtp.js';
import Admin from '../models/Admin.js';
import DeviceToken from '../models/DeviceToken.js';
import cloudinary from '../utils/cloudinary.js';
import { sendPasswordResetEmail, createNotification, sendEmail } from '../utils/notifier.js';
import { sendSms as sendChampSms } from '../utils/sendchamp.js';
import { sendOtp as providerSendOtp, verifyOtp as providerVerifyOtp } from '../utils/otpProvider.js';
import initFirebase from '../utils/firebaseAdmin.js';
import { OAuth2Client } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import dotenv from 'dotenv';
dotenv.config();  

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
// Apple's JWKS endpoint (used to verify identity tokens)
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

// Build a client secret JWT for server-to-server exchanges with Apple
function makeAppleClientSecret() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 60 * 60 * 24 * 180, // up to 6 months
    aud: 'https://appleid.apple.com',
    sub: process.env.APPLE_BUNDLE_ID || process.env.APPLE_CLIENT_ID,
  };
  const privateKey = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return jwt.sign(payload, privateKey, { algorithm: 'ES256', keyid: process.env.APPLE_KEY_ID });
}

// Exchange an authorization code for tokens at Apple's token endpoint
async function exchangeCodeForToken(code) {
  const clientSecret = makeAppleClientSecret();
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: process.env.APPLE_BUNDLE_ID || process.env.APPLE_CLIENT_ID,
    client_secret: clientSecret,
  });
  const _fetch = globalThis.fetch ? globalThis.fetch : (await import('node-fetch')).default;
  const res = await _fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Apple token exchange failed: ' + text);
  return JSON.parse(text);
}

// Register a new user (handles optional profile upload via req.file())
export const registerUser = async (req, reply) => {
  try {
    const body = req.body || {};
    const { name, email, password, role, googleIdToken, adminCode } = body;
    let phone = body.phone;

    // Quick diagnostic: ensure mongoose connection state is healthy
    // readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const state = mongoose.connection?.readyState;
    req.log?.info?.(`mongoose.readyState=${state}`);
    if (state !== 1) {
      // don't abruptly exit; return a helpful error so caller can see DB is not ready
      return reply.code(503).send({ message: 'Database not connected (mongoose.readyState=' + state + ')' });
    }

    // simple validation - require email and either password or google token
    if (!email) return reply.code(400).send({ message: 'Email is required' });
    if (!password && !googleIdToken) return reply.code(400).send({ message: 'Provide password or Google token' });

    // Normalize email to lowercase and trim
    const normalizedEmail = email.toLowerCase().trim();

    // handle optional single file upload (fastify-multipart)
    let profileImage = {};
    try {
      if (req.isMultipart && typeof req.parts === 'function') {
        try {
          for await (const part of req.parts()) {
            if (part.file) {
              // upload to cloudinary if configured
              const uploadStream = cloudinary.uploader.upload_stream(
                { folder: 'artisan_profiles', resource_type: 'auto' },
                (err, res) => {
                  if (err) req.log.error(err);
                  else profileImage = { url: res?.secure_url || '', public_id: res?.public_id };
                }
              );
              part.file.pipe(uploadStream);
            }
          }
        } catch (multipartErr) {
          // multipart parsing failed or request wasn't multipart; log and continue
          req.log?.warn?.({ reqId: req.id, err: multipartErr?.message || multipartErr }, 'multipart parsing skipped');
        }
      }
    } catch (e) {
      req.log?.error?.(e);
    }

    // If a Google token is provided, verify it and extract profile info
    let googleId;
    if (googleIdToken) {
      try {
        const ticket = await googleClient.verifyIdToken({ idToken: googleIdToken, audience: [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_IOS_CLIENT_ID] });
        const payload = ticket.getPayload();
        googleId = payload.sub;
        if (payload.picture && !profileImage.url) profileImage = { url: payload.picture, public_id: '' };
        // prefer email from token if not passed
        if (!email && payload.email) body.email = payload.email;
        // prefer phone from token if not passed (common claim names: phone_number, phone, phoneNumber)
        const tokenPhone = payload.phone_number || payload.phone || payload.phoneNumber;
        if (!phone && tokenPhone) {
          phone = String(tokenPhone).trim();
          body.phone = phone;
        }
      } catch (err) {
        // decode token to surface audience for debugging
        try {
          const decoded = jwt.decode(googleIdToken, { complete: true }) || {};
          req.log?.error?.('Google token verification failed', { err: err?.message || err, aud: decoded.payload?.aud });
          return reply.code(400).send({ message: 'Invalid Google token (audience=' + (decoded.payload?.aud || 'unknown') + ')' });
        } catch (dErr) {
          req.log?.error?.('Google token verification failed', err);
          return reply.code(400).send({ message: 'Invalid Google token' });
        }
      }
    }

    // check existing across users and admins
    let existingUser = null;
    // only query with fields that were actually provided to avoid accidental matches
    const userOr = [];
    if (normalizedEmail) userOr.push({ email: normalizedEmail });
    if (phone) userOr.push({ phone: phone.trim() });
    if (userOr.length) {
      existingUser = await User.findOne({ $or: userOr });
    }

    let existingAdmin = null;
    if (normalizedEmail) {
      existingAdmin = await Admin.findOne({ email: normalizedEmail });
    }

    // log diagnostic info to help identify false positives (neutral label)
    req.log?.info?.({ reqId: req.id, check: 'registration-check', email: normalizedEmail, phone, foundUser: !!existingUser, foundAdmin: !!existingAdmin }, 'registration existence check');

    if (existingUser || existingAdmin) {
      req.log?.warn?.({ reqId: req.id, existingUser: existingUser && { id: existingUser._id, email: existingUser.email, phone: existingUser.phone }, existingAdmin: existingAdmin && { id: existingAdmin._id, email: existingAdmin.email } }, 'registration conflict - user/admin exists');
      return reply.code(409).send({ message: 'User already exists' });
    }

    // If an adminCode is provided and matches the server's invite code, create an Admin account
    if (adminCode) {
      const invite = process.env.ADMIN_INVITE_CODE || process.env.ADMIN_CODE;
      if (!invite || adminCode !== invite) {
        return reply.code(403).send({ message: 'Invalid admin invite code' });
      }
      // require password for admin creation
      if (!password) return reply.code(400).send({ message: 'Password required for admin registration' });

      const hashedPassword = await bcrypt.hash(password, 10);
      const adminPayload = { name, email: normalizedEmail, password: hashedPassword };
      if (phone) adminPayload.phone = phone.trim();
      if (role) adminPayload.role = role;
      if (profileImage) adminPayload.profileImage = profileImage;

      const admin = await Admin.create(adminPayload);
      const token = jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET || 'changeme', {
        expiresIn: '7d',
      });
      return reply.code(201).send({ message: 'Admin registered successfully', admin: { id: admin._id, email: admin.email, name: admin.name }, token });
    }

    // create user - if googleIdToken provided we won't require a password
    // Allow normal registrations to be either 'customer' or 'artisan', but
    // prevent clients from setting 'admin' directly. Default to 'customer'.
    const allowedRoles = ['customer', 'artisan'];
    const safeRole = allowedRoles.includes(role) ? role : 'customer';
    let userPayload = {
      name,
      email: normalizedEmail,
      phone: phone ? phone.trim() : undefined,
      role: safeRole,
      profileImage,
    };

    if (googleId) {
      userPayload.googleId = googleId;
      userPayload.provider = 'google';
    }

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      userPayload.password = hashedPassword;
    }
    // If Google OAuth registration, create the user immediately
    if (googleId) {
      const user = await User.create(userPayload);
      req.log?.info?.({ userId: String(user._id), email: user.email, role: user.role }, 'google registration:user_created');

      // Auto-register device token if supplied in the request (mobile clients)
      try {
        const deviceToken = req.body?.deviceToken || req.body?.fcmToken || req.body?.notificationToken || req.body?.token;
        const platform = req.body?.platform || req.body?.devicePlatform || null;
        if (deviceToken) {
          await DeviceToken.updateOne({ token: deviceToken }, { $set: { userId: user._id, platform, updatedAt: new Date() } }, { upsert: true });
          req.log?.info?.({ userId: String(user._id), platform, tokenPrefix: String(deviceToken).slice(0, 12) }, 'google registration:device_token_saved');
        } else {
          req.log?.warn?.({ userId: String(user._id) }, 'google registration:device_token_missing');
        }
      } catch (dtErr) {
        req.log?.warn?.('device token auto-register failed', dtErr?.message || dtErr);
      }

      const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'changeme', {
        expiresIn: '7d',
      });

      // Send welcome notification and email (if SMTP configured)
      try {
        req.log?.info?.({ userId: String(user._id), email: user.email }, 'google registration:welcome_notification_start');
        await createNotification(req.server, user._id, {
          type: 'welcome',
          title: 'Welcome to RijHub',
          body: `Welcome ${user.name || 'there'}! Your account has been created successfully.`,
          data: { sendEmail: true, email: user.email }
        });
        req.log?.info?.({ userId: String(user._id), email: user.email }, 'google registration:welcome_notification_done');
      } catch (notifErr) {
        req.log?.warn?.('welcome notification failed', notifErr?.message || notifErr);
      }

      // include current device tokens for the newly created user
      try {
        const deviceTokens = await DeviceToken.find({ userId: user._id }).select('token platform -_id').lean();
        reply.code(201).send({ message: 'User registered successfully', user, token, deviceTokens });
      } catch (dtErr) {
        req.log?.warn?.('failed to fetch device tokens', dtErr?.message || dtErr);
        reply.code(201).send({ message: 'User registered successfully', user, token });
      }
      return;
    }

    // Normal registration flow: create OTP and store pending payload
    try {
      // Generate a 6-digit numeric OTP (server-visible)
      let otp;
      if (typeof crypto.randomInt === 'function') {
        otp = String(crypto.randomInt(100000, 1000000));
      } else {
        otp = String(Math.floor(100000 + Math.random() * 900000));
      }
      const codeHash = crypto.createHash('sha256').update(otp).digest('hex');
      const expiresAt = new Date(Date.now() + (15 * 60 * 1000)); // 15 minutes

      await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { codeHash, payload: userPayload, expiresAt, attempts: 0, createdAt: new Date() }, { upsert: true, new: true });

      const COMPANY = 'RijHub';
      const subject = `${COMPANY} — Verify your email`;
      const html = `<p>Hello ${userPayload.name || 'User'},</p><p>Your ${COMPANY} verification code is <strong>${otp}</strong>. It expires in 15 minutes.</p><p>If you did not request this, ignore this email.</p>`;
      const text = `Your ${COMPANY} verification code is ${otp}. It expires in 15 minutes.`;

      // Prefer configured OTP provider (SendChamp or Twilio) if phone provided
      let deliveredMeta = null;
      if (phone) {
        // Send the OTP in the background so we don't block the registration response
        (async () => {
          let provider = (process.env.OTP_PROVIDER || (process.env.SENDCHAMP_API_KEY ? 'sendchamp' : 'email')).toLowerCase();
          try {
            // Build provider options. When using SendChamp we allow switching to WhatsApp templates
            const options = { ttl: 15 * 60 };
            if (provider === 'sendchamp') {
              const useSms = String(process.env.SENDCHAMP_USE_SMS || 'true').toLowerCase() === 'true';
              if (!useSms) {
                options.channel = 'whatsapp';
                // Allow override from request (client) or env for template and sender
                options.template = req.body?.whatsappTemplate || process.env.SENDCHAMP_WHATSAPP_TEMPLATE || process.env.SENDCHAMP_WHATSAPP_TEMPLATE_CODE;
                options.sender = req.body?.whatsappSender || process.env.SENDCHAMP_WHATSAPP_SENDER || process.env.SENDCHAMP_DEFAULT_SENDER;
              } else {
                options.channel = 'sms';
              }
            }

            const otpRes = await providerSendOtp(phone.trim(), otp, options);
            const methodName = provider === 'sendchamp' ? (options.channel === 'whatsapp' ? 'sendchamp_whatsapp' : 'sendchamp_otp') : provider;
            const bgDelivered = { method: methodName, result: otpRes, timestamp: new Date() };
            // try to persist provider result (full response)
            try {
              await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: bgDelivered }, { upsert: false });
            } catch (persistErr) {
              req.log?.warn?.('failed to persist otp delivered meta', persistErr?.message || persistErr);
            }

            try {
              const emailRes = await sendEmail(req.server, normalizedEmail, subject, html, text);
              if (emailRes && emailRes.success === true) {
                await RegistrationOtp.findOneAndUpdate(
                  { email: normalizedEmail },
                  { delivered: { method: 'email', result: emailRes, timestamp: new Date(), alsoSentVia: bgDelivered } },
                  { upsert: false }
                );
              } else {
                req.log?.warn?.({ email: normalizedEmail, result: emailRes }, 'registration OTP email send failed');
              }
            } catch (emailErr) {
              req.log?.warn?.('registration OTP email send failed', emailErr?.message || emailErr);
            }

            // If provider returned non-success (use explicit success flag), attempt email fallback
            if (!(otpRes && otpRes.success === true)) {
              req.log?.warn?.({ email: normalizedEmail, phone: phone?.trim(), provider, method: methodName, result: otpRes }, 'otp provider returned non-success (background)');
              // persist attempted endpoints/details with error detail where available
              const failureMeta = {
                method: methodName,
                result: otpRes,
                error: otpRes?.error || otpRes?.response || otpRes?.status || null,
                timestamp: new Date(),
              };
              try {
                await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: failureMeta }, { upsert: false });
              } catch (persistErr2) {
                req.log?.warn?.('failed to persist otp delivered meta after failure', persistErr2?.message || persistErr2);
              }

              try {
                const emailRes = await sendEmail(req.server, normalizedEmail, subject, html, text);
                const emailMeta = { method: 'email', result: emailRes, timestamp: new Date() };
                if (emailRes && emailRes.success === true) {
                  await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: emailMeta }, { upsert: false });
                } else {
                  await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: emailMeta }, { upsert: false });
                }
              } catch (emailErr) {
                req.log?.warn?.('background email fallback failed', emailErr?.message || emailErr);
              }
            }
          } catch (e) {
            req.log?.warn?.({ email: normalizedEmail, phone: phone?.trim(), provider, error: e?.response?.data || e?.message || String(e) }, 'otp provider background exception');
            // persist exception details for debugging
            try {
              const excMeta = { method: 'provider_exception', error: e?.response?.data || e?.message || String(e), timestamp: new Date() };
              await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: excMeta }, { upsert: false });
            } catch (persistExcErr) {
              req.log?.warn?.('failed to persist otp exception meta', persistExcErr?.message || persistExcErr);
            }
            try {
              await sendEmail(req.server, normalizedEmail, subject, html, text);
              await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: { method: 'email', result: { success: true }, timestamp: new Date() } }, { upsert: false });
            } catch (emailErr) {
              req.log?.warn?.('background email fallback failed', emailErr?.message || emailErr);
            }
          }
        })();

        // Respond immediately — the OTP request has been accepted and will be sent shortly
        return reply.code(200).send({ success: true, message: 'Verification request accepted. You will receive the code shortly.' });
      }

      // Fallback: send email using notifier
      try {
        await sendEmail(req.server, normalizedEmail, subject, html, text);
        deliveredMeta = deliveredMeta || { method: 'email', result: { success: true } };
      } catch (e) {
        deliveredMeta = deliveredMeta || { method: 'email', result: { success: false, error: e?.message || e } };
      }

      // persist delivery metadata
      try {
        await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: deliveredMeta }, { upsert: false });
      } catch (e) { req.log?.warn?.('failed to persist delivered meta', e?.message || e); }

      return reply.code(200).send({ success: true, message: 'Verification code sent. Use /api/auth/verify-otp to complete registration.' });
    } catch (e) {
      req.log?.error?.('registerUser: failed to create OTP', e?.message || e);
      return reply.code(500).send({ message: 'Failed to initiate registration' });
    }
  } catch (err) {
    req.log?.error?.(err);
    reply.code(500).send({ message: 'Registration failed' });
  }
};

export const loginUser = async (req, reply) => {
  try {
    const { email, password } = req.body || {};
    // console.log('de',req);
    // console.log('working');
    if (!email || !password) return reply.code(400).send({ message: 'Email and password required' });
    
    // Normalize email for case-insensitive lookup
    const normalizedEmail = email.toLowerCase().trim();
    
    // Try to find a normal User first
    const user = await User.findOne({ email: normalizedEmail }).select('+password');
    if (user && user.banned) return reply.code(403).send({ message: 'Account banned' });
    if (user) {
      const match = await bcrypt.compare(password, user.password || '');
      if (!match) return reply.code(401).send({ message: 'Invalid credentials' });
      // Auto-register device token if supplied
      try {
        const deviceToken = req.body?.deviceToken || req.body?.fcmToken || req.body?.notificationToken || req.body?.token;
        const platform = req.body?.platform || req.body?.devicePlatform || null;
        if (deviceToken) {
          await DeviceToken.updateOne({ token: deviceToken }, { $set: { userId: user._id, platform, updatedAt: new Date() } }, { upsert: true });
        }
      } catch (dtErr) {
        req.log?.warn?.('device token auto-register failed', dtErr?.message || dtErr);
      }

      const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'changeme', {
        expiresIn: '7d',
      });
      try {
        const deviceTokens = await DeviceToken.find({ userId: user._id }).select('token platform -_id').lean();
        return reply.send({ success: true, user, token, deviceTokens });
      } catch (dtErr) {
        req.log?.warn?.('failed to fetch device tokens', dtErr?.message || dtErr);
        return reply.send({ success: true, user, token });
      }
    }

    // If no User found, allow Admins to authenticate via the same endpoint
    const admin = await Admin.findOne({ email: normalizedEmail });
    if (admin) {
      const match = await bcrypt.compare(password, admin.password || '');
      if (!match) return reply.code(401).send({ message: 'Invalid credentials' });
      // create a token with admin role
      // Auto-register device token for admin if supplied (optional)
      try {
        const deviceToken = req.body?.deviceToken || req.body?.fcmToken || req.body?.notificationToken || req.body?.token;
        const platform = req.body?.platform || req.body?.devicePlatform || null;
        if (deviceToken) {
          await DeviceToken.updateOne({ token: deviceToken }, { $set: { userId: admin._id, platform, updatedAt: new Date() } }, { upsert: true });
        }
      } catch (dtErr) {
        req.log?.warn?.('device token auto-register failed', dtErr?.message || dtErr);
      }

      const token = jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET || 'changeme', {
        expiresIn: '7d',
      });
      // don't send the password hash back
      const safeAdmin = admin.toObject ? admin.toObject() : { id: admin._id, email: admin.email, name: admin.name };
      if (safeAdmin.password) delete safeAdmin.password;
      return reply.send({ success: true, admin: safeAdmin, token });
    }

    // nothing matched
    return reply.code(401).send({ message: 'Invalid credentials' });
  } catch (err) {
    req.log?.error?.(err);
    reply.code(500).send({ message: 'Login failed' });
  }
};

// Verify registration OTP and finalize user creation
export const verifyRegistrationOtp = async (req, reply) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) return reply.code(400).send({ success: false, message: 'email and otp required' });
    const normalizedEmail = String(email).toLowerCase().trim();
    const record = await RegistrationOtp.findOne({ email: normalizedEmail });

    // Debug summary for diagnosis (avoid logging the actual OTP)
    try {
      req.log?.info?.({ reqId: req.id, email: normalizedEmail, recordExists: !!record, attempts: record?.attempts, expiresAt: record?.expiresAt, payloadPhone: record?.payload?.phone || record?.payload?.phoneNumber, delivered: record?.delivered }, 'verifyRegistrationOtp: record summary');
    } catch (logErr) {
      req.log?.warn?.('verifyRegistrationOtp: failed to log record summary', logErr?.message || logErr);
    }

    if (!record) return reply.code(404).send({ success: false, message: 'No pending registration found' });
    if (record.expiresAt && record.expiresAt < new Date()) return reply.code(400).send({ success: false, message: 'OTP expired' });

    // If the OTP was delivered via a provider, prefer provider-side verification when possible
    if (record.delivered && record.delivered.method) {
      try {
        const method = String(record.delivered.method || '').toLowerCase();
        // Twilio Verify requires the phone number when verifying
        if (method.includes('twilio') || method.includes('termii')) {
          const phone = record.payload?.phone || record.payload?.phoneNumber || record.delivered?.to || null;
          // If Termii delivered the code via our manual messaging route, skip provider verify
          const deliveredResult = record.delivered?.result || {};
          if (method.includes('termii') && deliveredResult && deliveredResult.manual === true) {
            // provider didn't generate the PIN; fall through to local verification
            req.log?.info?.({ reqId: req.id, email: normalizedEmail }, 'verifyRegistrationOtp: termii manual send detected, skipping provider verify');
          } else {
          if (phone) {
            const verifyRes = await providerVerifyOtp(phone, String(otp));
            if (!(verifyRes && (verifyRes.success === true || verifyRes.status === 'approved' || verifyRes.status === 'verified'))) {
              req.log?.warn?.({ email: normalizedEmail, phone, providerVerifyResult: verifyRes }, 'provider verify failed');
              record.attempts = (record.attempts || 0) + 1;
              await record.save();
              return reply.code(400).send({ success: false, message: 'Invalid code' });
            }
            // provider verified; proceed to finalize registration
          }
          }
        } else if (method.includes('sendchamp')) {
          const delivered = record.delivered.result || {};
          // Try to extract a provider reference from saved delivery metadata
          const reference = delivered?.response?.data?.data?.reference || delivered?.response?.data?.reference || delivered?.reference || delivered?.data?.reference || delivered?.response?.reference;
          if (reference) {
            const verifyRes = await providerVerifyOtp(reference, String(otp));
            if (!(verifyRes && (verifyRes.success === true || verifyRes.response?.data?.status === 'success' || verifyRes.response?.data?.status === 'verified' || verifyRes.response?.data?.status === 'confirmed'))) {
              req.log?.warn?.({ email: normalizedEmail, reference, providerVerifyResult: verifyRes }, 'provider verify failed (sendchamp)');
              record.attempts = (record.attempts || 0) + 1;
              await record.save();
              return reply.code(400).send({ success: false, message: 'Invalid code' });
            }
            // provider verified; proceed
          }
        }
      } catch (e) {
        req.log?.warn?.('provider verify error', e?.message || e);
        // fall through to local verification
      }
    }

    // Local hash verification (fallback)
    const codeHash = crypto.createHash('sha256').update(String(otp)).digest('hex');
    if (codeHash !== record.codeHash) {
      try {
        req.log?.warn?.({ reqId: req.id, email: normalizedEmail, providedOtpLength: String(otp).length, computedHash: codeHash, hasStoredHash: !!record.codeHash }, 'verifyRegistrationOtp: local hash mismatch');
      } catch (logErr) {
        req.log?.warn?.('verifyRegistrationOtp: failed to log local mismatch', logErr?.message || logErr);
      }
      record.attempts = (record.attempts || 0) + 1;
      await record.save();
      return reply.code(400).send({ success: false, message: 'Invalid code' });
    }

    // finalize user creation
    const payload = record.payload || {};
    // ensure email matches
    payload.email = normalizedEmail;
    const user = await User.create(payload);

    // cleanup otp record
    try { await RegistrationOtp.deleteOne({ _id: record._id }); } catch (e) { req.log?.warn?.('failed to cleanup registration otp', e?.message || e); }

    // send welcome notification/email
    try {
      await createNotification(req.server, user._id, { type: 'welcome', title: 'Welcome to RijHub', body: `Welcome ${user.name || 'there'}! Your account is now verified.`, data: { sendEmail: true, email: user.email } });
    } catch (e) { req.log?.warn?.('welcome notification failed', e?.message || e); }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'changeme', { expiresIn: '7d' });
    return reply.send({ success: true, message: 'Registration completed', user, token });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to verify registration' });
  }
};

// Resend OTP: regenerates OTP for an existing pending registration (or creates new)
export const resendOtp = async (req, reply) => {
  try {
    const { email, phone } = req.body || {};
    if (!email) return reply.code(400).send({ success: false, message: 'email is required' });
    const normalizedEmail = String(email).toLowerCase().trim();

    // throttle resends: require at least RESEND_OTP_WINDOW_SECONDS between sends (default 60)
    const RESEND_WINDOW = Number(process.env.RESEND_OTP_WINDOW_SECONDS || 60);
    let record = await RegistrationOtp.findOne({ email: normalizedEmail });
    const now = new Date();
    if (record && record.createdAt && (now - record.createdAt) / 1000 < RESEND_WINDOW) {
      return reply.code(429).send({ success: false, message: `Please wait before requesting a new code (${RESEND_WINDOW}s)` });
    }

    // Generate new OTP and persist
    // Generate a 6-digit numeric OTP for resend
    let otp;
    if (typeof crypto.randomInt === 'function') {
      otp = String(crypto.randomInt(100000, 1000000));
    } else {
      otp = String(Math.floor(100000 + Math.random() * 900000));
    }
    const codeHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + (15 * 60 * 1000)); // 15 minutes

    record = await RegistrationOtp.findOneAndUpdate(
      { email: normalizedEmail },
      { codeHash, expiresAt, attempts: 0, createdAt: now },
      { upsert: true, new: true }
    );

    const COMPANY = process.env.COMPANY_NAME || 'RijHub';
    const subject = `${COMPANY} — Your verification code`;
    const html = `<p>Hello,</p><p>Your ${COMPANY} verification code is <strong>${otp}</strong>. It expires in 15 minutes.</p>`;
    const text = `Your ${COMPANY} verification code is ${otp}. It expires in 15 minutes.`;

    // If phone provided in body prefer it, else try payload or previous record
    const targetPhone = (phone && String(phone).trim()) || record.payload?.phone || record.payload?.phoneNumber || null;

    let deliveredMeta = null;
    if (targetPhone) {
      (async () => {
        let provider = (process.env.OTP_PROVIDER || (process.env.SENDCHAMP_API_KEY ? 'sendchamp' : 'email')).toLowerCase();
        try {
          const options = { ttl: 15 * 60 };
          if (provider === 'sendchamp') {
            const useSms = String(process.env.SENDCHAMP_USE_SMS || 'true').toLowerCase() === 'true';
            if (!useSms) {
              options.channel = 'whatsapp';
              options.template = process.env.SENDCHAMP_WHATSAPP_TEMPLATE;
              options.sender = process.env.SENDCHAMP_WHATSAPP_SENDER;
            } else {
              options.channel = 'sms';
            }
          }

          const otpRes = await providerSendOtp(targetPhone, otp, options);
          const methodName = provider === 'sendchamp' ? (options.channel === 'whatsapp' ? 'sendchamp_whatsapp' : 'sendchamp_otp') : provider;
          deliveredMeta = { method: methodName, result: otpRes, timestamp: new Date() };
          try { await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: deliveredMeta }, { upsert: false }); } catch (e) { req.log?.warn?.('failed to persist delivered meta', e?.message || e); }

          try {
            const emailRes = await sendEmail(req.server, normalizedEmail, subject, html, text);
            if (emailRes && emailRes.success === true) {
              await RegistrationOtp.findOneAndUpdate(
                { email: normalizedEmail },
                { delivered: { method: 'email', result: emailRes, timestamp: new Date(), alsoSentVia: deliveredMeta } },
                { upsert: false }
              );
            } else {
              req.log?.warn?.({ email: normalizedEmail, result: emailRes }, 'resend OTP email send failed');
            }
          } catch (emailErr) {
            req.log?.warn?.('resend OTP email send failed', emailErr?.message || emailErr);
          }

          if (!(otpRes && otpRes.success === true)) {
            // fallback to email
            req.log?.warn?.({ email: normalizedEmail, phone: targetPhone, provider, method: methodName, result: otpRes }, 'otp provider returned non-success on resend');
            try {
              const emailRes = await sendEmail(req.server, normalizedEmail, subject, html, text);
              const emailMeta = { method: 'email', result: emailRes, timestamp: new Date() };
              await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: emailMeta }, { upsert: false });
            } catch (emailErr) { req.log?.warn?.('email fallback failed on resend', emailErr?.message || emailErr); }
          }
        } catch (e) {
          req.log?.warn?.({ email: normalizedEmail, phone: targetPhone, provider, error: e?.response?.data || e?.message || String(e) }, 'otp provider resend exception');
          try { await sendEmail(req.server, normalizedEmail, subject, html, text); await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: { method: 'email', result: { success: true }, timestamp: new Date() } }, { upsert: false }); } catch (emailErr) { req.log?.warn?.('email fallback failed after provider error', emailErr?.message || emailErr); }
        }
      })();

      return reply.send({ success: true, message: 'Resend request accepted. You will receive the code shortly.' });
    }

    // No phone available — send email
    try {
      const emailRes = await sendEmail(req.server, normalizedEmail, subject, html, text);
      deliveredMeta = { method: 'email', result: emailRes, timestamp: new Date() };
      try { await RegistrationOtp.findOneAndUpdate({ email: normalizedEmail }, { delivered: deliveredMeta }, { upsert: false }); } catch (e) { req.log?.warn?.('failed to persist delivered meta', e?.message || e); }
    } catch (e) {
      req.log?.error?.('resendOtp email send failed', e?.message || e);
    }

    return reply.send({ success: true, message: 'Verification code sent via email.' });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to resend OTP' });
  }
};

// Verify registration using provider reference (client-driven)
export const verifyRegistrationWithReference = async (req, reply) => {
    const { email, reference, otp } = req.body || {};
    if (!email || !reference) return reply.code(400).send({ success: false, message: 'email and reference required' });
    const normalizedEmail = String(email).toLowerCase().trim();
    const record = await RegistrationOtp.findOne({ email: normalizedEmail });
    if (!record) return reply.code(404).send({ success: false, message: 'No pending registration found' });
    if (record.expiresAt && record.expiresAt < new Date()) return reply.code(400).send({ success: false, message: 'OTP expired' });
    // Determine provider preference (env override or recorded delivery method)
    const configuredProvider = (process.env.OTP_PROVIDER || (record.delivered && record.delivered.method) || 'sendchamp').toLowerCase();
    // For non-firebase providers we require an otp value
    if (configuredProvider !== 'firebase' && !otp) return reply.code(400).send({ success: false, message: 'otp required for non-firebase providers' });

    if (configuredProvider === 'firebase' || String(record.delivered?.method || '').toLowerCase().includes('firebase')) {
      // For Firebase, `reference` is expected to be the Firebase ID token issued by the client
      const admin = initFirebase();
      if (!admin) {
        req.log?.error?.('firebase not configured but used for verifyRegistrationWithReference');
        return reply.code(500).send({ success: false, message: 'Firebase not configured on server' });
      }
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(String(reference));
      } catch (e) {
        req.log?.warn?.('firebase verify failed', e?.message || e);
        record.attempts = (record.attempts || 0) + 1;
        await record.save();
        return reply.code(400).send({ success: false, message: 'Invalid or expired Firebase token' });
      }

      // Ensure the phone number in the token matches the pending payload phone (if present)
      const tokenPhone = decoded.phone_number || decoded.phone || null;
      const payloadPhone = record.payload?.phone || record.payload?.phoneNumber || null;
      const norm = s => (String(s || '').replace(/\D/g, ''));
      if (payloadPhone && tokenPhone && norm(payloadPhone) !== norm(tokenPhone)) {
        req.log?.warn?.('firebase token phone mismatch', { payloadPhone, tokenPhone });
        record.attempts = (record.attempts || 0) + 1;
        await record.save();
        return reply.code(400).send({ success: false, message: 'Phone number mismatch' });
      }

      // token is valid — finalize registration
      const payload = record.payload || {};
      payload.email = normalizedEmail;
      // mark firebase uid / phoneVerified when available
      if (decoded?.uid) payload.firebaseUid = decoded.uid;
      if (decoded?.phone_number) payload.phone = decoded.phone_number;
      payload.phoneVerified = true;

      // Prevent creating a new account if a suspended (banned) user exists with same email/phone
      const existing = await User.findOne({ $or: [{ email: payload.email }, { phone: payload.phone || null }] });
      if (existing) {
        if (existing.banned) return reply.code(403).send({ success: false, message: 'Account suspended' });
        return reply.code(409).send({ success: false, message: 'User already exists' });
      }

      const user = await User.create(payload);
    try { 
      await RegistrationOtp.deleteOne({ _id: record._id }); 
    } catch (e) {
      req.log?.warn?.('failed to cleanup registration otp', e?.message || e); 
    }

    try {
      await createNotification(req.server, user._id, { type: 'welcome', title: 'Welcome to RijHub', body: `Welcome ${user.name || 'there'}! Your account is now verified.`, data: { sendEmail: true, email: user.email } });
    } catch (e) { req.log?.warn?.('welcome notification failed', e?.message || e); }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'changeme', { expiresIn: '7d' });
    return reply.send({ success: true, message: 'Registration completed', user, token });
  }
};

// Register a new user after Firebase phone verification (client obtains ID token)
export const registerUserWithFirebaseToken = async (req, reply) => {
  try {
    const { idToken, name, email, password, role } = req.body || {};
    if (!idToken || !name || !email || !password || !role) return reply.code(400).send({ message: 'idToken, name, email, password and role are required' });

    const admin = initFirebase();
    if (!admin) return reply.code(500).send({ message: 'Firebase not configured on server' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(String(idToken));
    } catch (e) {
      req.log?.warn?.('firebase idToken verify failed', e?.message || e);
      return reply.code(401).send({ message: 'Invalid or expired Firebase token' });
    }

    const verifiedPhone = decoded.phone_number || decoded.phone || null;
    const normalizedEmail = String(email).toLowerCase().trim();

    // Check duplicates by email or phone
    const existing = await User.findOne({ $or: [{ email: normalizedEmail }, { phone: verifiedPhone }] });
    if (existing) {
      if (existing.banned) return reply.code(403).send({ message: 'Account suspended' });
      return reply.code(409).send({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const allowedRoles = ['customer', 'artisan'];
    const safeRole = allowedRoles.includes(role) ? role : 'customer';

    const userPayload = {
      name,
      email: normalizedEmail,
      password: hashedPassword,
      phone: verifiedPhone,
      role: safeRole,
      firebaseUid: decoded.uid,
      phoneVerified: true,
    };

    const user = await User.create(userPayload);

    // Send welcome notification / email where possible
    try {
      await createNotification(req.server, user._id, { type: 'welcome', title: 'Welcome to RijHub', body: `Welcome ${user.name || 'there'}! Your account has been created.`, data: { sendEmail: true, email: user.email } });
    } catch (e) { req.log?.warn?.('welcome notification failed', e?.message || e); }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'changeme', { expiresIn: '7d' });

    return reply.code(201).send({ token, user: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, firebaseUid: user.firebaseUid, phoneVerified: true, createdAt: user.createdAt } });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ message: 'Registration failed' });
  }
};

export const guestLogin = async (req, reply) => {
  // simple guest user creation or token minting
  try {
    // Create a unique placeholder email because `User.email` is required by the schema.
    const placeholderEmail = `guest+${Date.now()}@guest.local`;
    const guest = await User.create({ name: 'Guest', isGuest: true, role: 'guest', email: placeholderEmail });
    const token = jwt.sign({ id: guest._id, role: guest.role }, process.env.JWT_SECRET || 'changeme', {
      expiresIn: '7d',
    });
    return reply.code(201).send({ success: true, guest, token });
  } catch (err) {
    req.log?.error?.(err);
    reply.code(500).send({ message: 'Guest login failed' });
  }
};

// Verify token with remote issuer (try Authorization header first, fallback to JSON body { token })
export const verifyRemoteToken = async (req, reply) => {
  try {
    // Try Authorization header first
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    let token = null;
    let useAuthHeader = false;
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
      useAuthHeader = true;
    }
    // fallback to JSON body
    if (!token) token = req.body?.token || null;
    if (!token) return reply.code(400).send({ valid: false, message: 'token required' });

    const remoteUrl = process.env.RIJHUB_VERIFY_URL || 'https://rijhub.com/api/auth/verify';

    // If we can, prefer forwarding Authorization header
    const headers = { 'Content-Type': 'application/json' };
    if (useAuthHeader) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      if (useAuthHeader) {
        res = await axios.post(remoteUrl, {}, { headers, timeout: 5000 });
      } else {
        res = await axios.post(remoteUrl, { token }, { headers, timeout: 5000 });
      }
    } catch (err) {
      const status = err?.response?.status || 502;
      const data = err?.response?.data || { message: err?.message || 'remote verification failed' };
      return reply.code(401).send({ valid: false, message: 'remote verification failed', remoteStatus: status, remote: data });
    }

    if (!res || res.status !== 200) {
      return reply.code(401).send({ valid: false, message: 'remote verification failed', remoteStatus: res?.status });
    }

    // Accept either { valid: true, payload } or any 200 with a payload
    const body = res.data || {};
    const isValid = body.valid === true || (body && Object.keys(body).length > 0);
    if (!isValid) return reply.code(401).send({ valid: false, message: 'token invalid', remote: body });

    return reply.send({ valid: true, payload: body });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ valid: false, message: 'verification error' });
  }
};

export const googleCallback = async (req, reply) => {
  // placeholder for OAuth callback handling
  return reply.send({ success: true, message: 'Google callback placeholder' });
};

  export const oauthGoogle = async (req, reply) => {
  try {
    const idToken = req.body?.idToken || req.body?.id_token;
    const role = req.body?.role;
    if (!idToken) return reply.code(400).send({ message: 'idToken required (body.idToken or body.id_token)' });

    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({ idToken, audience: [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_IOS_CLIENT_ID] });
    } catch (verifyErr) {
      // Attempt a best-effort retry: decode the token and if the aud looks like
      // a Google OAuth client id (ends with .apps.googleusercontent.com) include
      // it as an accepted audience and retry verification. This covers cases
      // where mobile tokens use a different client id (e.g., Android) not
      // present in env. Verification still uses Google's keys.
      try {
        const decoded = jwt.decode(idToken, { complete: true }) || {};
        const aud = decoded.payload?.aud;
        req.log?.warn?.('google token verify failed, retrying with token aud', { err: verifyErr?.message || verifyErr, aud });
        if (aud && typeof aud === 'string' && aud.endsWith('.apps.googleusercontent.com')) {
          ticket = await googleClient.verifyIdToken({ idToken, audience: [aud] });
        } else {
          throw verifyErr;
        }
      } catch (retryErr) {
        // rethrow original for outer catch to handle
        throw verifyErr;
      }
    }
    const payload = ticket.getPayload();
    const email = payload.email;
    const googleId = payload.sub;
    const name = payload.name;
    const picture = payload.picture;

    if (!email) return reply.code(400).send({ message: 'Google token did not contain an email' });

    // decide role if provided (only allow customer or artisan)
    const allowedRoles = ['customer', 'artisan'];
    const finalRole = allowedRoles.includes(role) ? role : 'customer';

    // find by googleId or email
    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    if (user && user.banned) return reply.code(403).send({ message: 'Account banned' });
    if (user) {
      // link if needed
      if (!user.googleId) {
        user.googleId = googleId;
        user.provider = 'google';
        if (!user.profileImage || !user.profileImage.url) user.profileImage = { url: picture || '', public_id: '' };
        await user.save();
      }
      // If the client provided a desired role and the existing user has no role or is a guest, set it
      try {
        if (role && allowedRoles.includes(role) && (!user.role || String(user.role) === 'guest')) {
          user.role = role;
          await user.save();
        }
      } catch (e) {
        req.log?.warn?.('oauth role update failed', e?.message || e);
      }
    } else {
      user = await User.create({
        name,
        email,
        googleId,
        provider: 'google',
        role: finalRole,
        profileImage: picture ? { url: picture, public_id: '' } : {},
      });
      // Send welcome notification/email for newly created OAuth users
      try {
        await createNotification(req.server, user._id, {
          type: 'welcome',
          title: 'Welcome to RijHub',
          body: `Welcome ${user.name || 'there'}! Your account has been created successfully via Google OAuth.`,
          data: { sendEmail: true, email: user.email }
        });
      } catch (e) {
        req.log?.warn?.('oauth welcome notification failed', e?.message || e);
      }
    }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'changeme', {
      expiresIn: '7d',
    });
    try {
      const deviceTokens = await DeviceToken.find({ userId: user._id }).select('token platform -_id').lean();
      // console.log(token);
      return reply.send({ success: true, user, token, deviceTokens });
    } catch (dtErr) {
      req.log?.warn?.('failed to fetch device tokens', dtErr?.message || dtErr);
      // console.log(token);
      return reply.send({ success: true, user, token });
    }
  } catch (err) {
    try {
      const decoded = jwt.decode(req.body?.idToken || '', { complete: true }) || {};
      req.log?.error?.('Google OAuth failed', { err: err?.message || err, aud: decoded.payload?.aud });
      return reply.code(400).send({ message: 'Google OAuth failed (audience=' + (decoded.payload?.aud || 'unknown') + ')' });
    } catch (dErr) {
      req.log?.error?.('Google OAuth failed', err);
      return reply.code(500).send({ message: 'Google OAuth failed' });
    }
  }
};

export const oauthApple = async (req, reply) => {
  try {
    const { identityToken, nonce, name, email, role, authorizationCode } = req.body || {};

    let payload;
    // If client provided an authorization code, exchange it for tokens and use the returned id_token
    if (authorizationCode) {
      try {
        const tokenResp = await exchangeCodeForToken(authorizationCode);
        // tokenResp may contain id_token
        if (!tokenResp.id_token) return reply.code(400).send({ message: 'Apple token exchange did not return id_token' });
        const verifyResult = await jwtVerify(tokenResp.id_token, APPLE_JWKS, {
          issuer: 'https://appleid.apple.com',
          audience: process.env.APPLE_BUNDLE_ID || process.env.APPLE_CLIENT_ID,
        });
        payload = verifyResult.payload;
      } catch (err) {
        req.log?.error?.('Apple code exchange/verification failed', err?.message || err);
        return reply.code(401).send({ message: 'Invalid Apple authorization code or token' });
      }
    } else {
      // identityToken flow (client provided id token directly)
      if (!identityToken) return reply.code(400).send({ message: 'identityToken or authorizationCode required' });
      if (!nonce) return reply.code(400).send({ message: 'nonce required for identityToken flow' });
      try {
        const verifyResult = await jwtVerify(identityToken, APPLE_JWKS, {
          issuer: 'https://appleid.apple.com',
          audience: process.env.APPLE_BUNDLE_ID || process.env.APPLE_CLIENT_ID,
        });
        payload = verifyResult.payload;
      } catch (err) {
        req.log?.error?.('Apple token verification failed', err?.message || err);
        return reply.code(401).send({ message: 'Invalid Apple identity token' });
      }

      // Verify nonce: apple returns hashed nonce (sha256 hex)
      const expectedHashedNonce = crypto.createHash('sha256').update(nonce).digest('hex');
      if (!payload.nonce || String(payload.nonce) !== expectedHashedNonce) {
        req.log?.warn?.('Apple nonce mismatch', { expected: expectedHashedNonce, received: payload.nonce });
        return reply.code(401).send({ message: 'Nonce verification failed' });
      }
    }

    const appleUserId = payload.sub;
    const tokenEmail = payload.email;
    const emailVerified = payload.email_verified === 'true' || payload.email_verified === true;

    const userEmail = email || tokenEmail;
    const userName = name || payload.name || null;

    // Decide role
    const allowedRoles = ['customer', 'artisan'];
    const finalRole = allowedRoles.includes(role) ? role : 'customer';

    // Find existing user by apple id or email
    let user = await User.findOne({ $or: [{ appleUserId }, { apple_user_id: appleUserId }, { email: userEmail }] });
    if (user && user.banned) return reply.code(403).send({ message: 'Account banned' });

    if (user) {
      // Link apple id if not present
      if (!user.apple_user_id && appleUserId) {
        try {
          user.apple_user_id = appleUserId;
          user.provider = 'apple';
          if (userName && !user.name) user.name = userName;
          await user.save();
        } catch (e) {
          req.log?.warn?.('apple oauth linking failed', e?.message || e);
        }
      }
      // If role provided and user is guest or unset, update
      try {
        if (role && allowedRoles.includes(role) && (!user.role || String(user.role) === 'guest')) {
          user.role = role;
          await user.save();
        }
      } catch (e) {
        req.log?.warn?.('apple oauth role update failed', e?.message || e);
      }
    } else {
      // Create new user
      if (!userEmail) return reply.code(400).send({ message: 'Email required for new user registration' });
      const payloadObj = {
        name: userName || userEmail.split('@')[0],
        email: userEmail,
        apple_user_id: appleUserId,
        provider: 'apple',
        role: finalRole,
      };
      if (emailVerified) payloadObj.email_verified = true;
      user = await User.create(payloadObj);
      try {
        await createNotification(req.server, user._id, {
          type: 'welcome',
          title: 'Welcome to RijHub',
          body: `Welcome ${user.name || 'there'}! Your account has been created successfully via Apple Sign-In.`,
          data: { sendEmail: true, email: user.email }
        });
      } catch (e) {
        req.log?.warn?.('apple oauth welcome notification failed', e?.message || e);
      }
    }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'changeme', { expiresIn: '7d' });
    return reply.send({ success: true, user, token });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ message: 'Apple OAuth failed' });
  }
};

// Forgot Password - Generate reset token
export const forgotPassword = async (req, reply) => {
  try {
    const { email } = req.body || {};
    if (!email) return reply.code(400).send({ message: 'Email is required' });

    const normalizedEmail = email.toLowerCase().trim();
    
    // Check both User and Admin collections
    let user = await User.findOne({ email: normalizedEmail });
    let isAdmin = false;
    
    if (!user) {
      user = await Admin.findOne({ email: normalizedEmail });
      isAdmin = true;
    }

    if (!user) {
      // For security, don't reveal if email exists or not
      return reply.send({ 
        success: true, 
        message: 'If an account with that email exists, a password reset link has been sent.' 
      });
    }

    // Generate a 6-digit numeric reset token (user-visible)
    let resetToken;
    if (typeof crypto.randomInt === 'function') {
      resetToken = String(crypto.randomInt(100000, 1000000));
    } else {
      resetToken = String(Math.floor(100000 + Math.random() * 900000));
    }
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    // Set token and expiry (1 hour from now)
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    // Send email with reset link
    const emailResult = await sendPasswordResetEmail(
      req.server, 
      user.email, 
      resetToken, 
      user.name || 'User'
    );

    req.log?.info?.({ userId: user._id, email: normalizedEmail, emailSent: emailResult.success }, 'Password reset token generated');

    return reply.send({ 
      success: true, 
      message: 'If an account with that email exists, a password reset link has been sent.',
      // For development/testing - REMOVE IN PRODUCTION
      ...(process.env.NODE_ENV === 'development' && { 
        resetToken,
        resetUrl: `https://rijhub.com/aa/reset-password?token=${resetToken}`
      })
    });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ message: 'Password reset request failed' });
  }
};

// Reset Password - Validate token and update password
export const resetPassword = async (req, reply) => {
  try {
    const { resetToken, newPassword } = req.body || {};
    
    if (!resetToken) return reply.code(400).send({ message: 'Reset token is required' });
    if (!newPassword) return reply.code(400).send({ message: 'New password is required' });
    if (newPassword.length < 6) return reply.code(400).send({ message: 'Password must be at least 6 characters' });

    // Hash the provided token to match stored hash
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    // Find user with valid token that hasn't expired
    let user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() }
    });

    let isAdmin = false;
    if (!user) {
      user = await Admin.findOne({
        resetPasswordToken: hashedToken,
        resetPasswordExpires: { $gt: Date.now() }
      });
      isAdmin = true;
    }

    if (!user) {
      return reply.code(400).send({ 
        message: 'Invalid or expired reset token' 
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset fields
    user.password = hashedPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    req.log?.info?.({ userId: user._id, isAdmin }, 'Password reset successful');

    // Generate new auth token
    const token = jwt.sign(
      { id: user._id, role: isAdmin ? 'admin' : user.role }, 
      process.env.JWT_SECRET || 'changeme', 
      { expiresIn: '7d' }
    );

    return reply.send({ 
      success: true, 
      message: 'Password has been reset successfully',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: isAdmin ? 'admin' : user.role
      }
    });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ message: 'Password reset failed' });
  }
};
