import Kyc from '../models/Kyc.js';
import User from '../models/User.js';
import Artisan from '../models/Artisan.js';
import { createNotification } from '../utils/notifier.js';
import crypto from 'crypto';
import { getDojahWidgetConfig, getVerificationDetails, normalizeBase64Image, verifyNinWithSelfie } from '../services/dojahService.js';

const APPROVED_FLAGS = { kycLevel: 2, kycVerified: true, isVerified: true };
const UNAPPROVED_FLAGS = { kycLevel: 1, kycVerified: false, isVerified: false };
const PENDING_DOJAH_STATUSES = ['pending', 'ongoing', 'abandoned'];
const FAILED_DOJAH_STATUSES = ['failed', 'rejected'];

function readSelfieVerification(dojahResponse = {}) {
  const entity = dojahResponse?.entity || dojahResponse?.data?.entity || {};
  const verification = entity.selfie_verification || entity.selfieVerification || {};
  const match = verification.match === true || String(verification.match).toLowerCase() === 'true';
  const confidenceValue = Number(
    verification.confidence_value ??
    verification.confidenceValue ??
    verification.confidence ??
    0
  );

  return { entity, verification, match, confidenceValue };
}

function sanitizeDojahResponse(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = JSON.parse(JSON.stringify(value));
  const entity = clone.entity || clone.data?.entity;
  if (entity) {
    if (entity.photo) entity.photo = '[redacted]';
    if (entity.image) entity.image = '[redacted]';
    if (entity.selfie_image) entity.selfie_image = '[redacted]';
  }
  return clone;
}

function readDojahSdkStatus(dojahResponse = {}) {
  const rawStatus = dojahResponse.verification_status ||
    dojahResponse.verificationStatus ||
    dojahResponse.status_text ||
    dojahResponse.entity?.verificationStatus ||
    dojahResponse.entity?.verification_status ||
    '';
  return String(rawStatus || '').trim();
}

function readDojahMetadata(dojahResponse = {}) {
  return dojahResponse.metadata ||
    dojahResponse.data?.metadata ||
    dojahResponse.entity?.metadata ||
    {};
}

function readDojahReferenceId(dojahResponse = {}, fallback = '') {
  return dojahResponse.reference_id ||
    dojahResponse.referenceId ||
    dojahResponse.entity?.reference_id ||
    dojahResponse.entity?.referenceId ||
    fallback;
}

function readDojahSdkChecks(dojahResponse = {}) {
  const data = dojahResponse.data || dojahResponse.entity?.data || {};
  const selfie = data.selfie || data.liveness || data.face_liveness || {};
  const faceMatch = data.face_match || data.faceMatch || data.selfie_match || data.government_data || data.id || {};
  const overallStatus = dojahResponse.status;
  const verificationStatus = readDojahSdkStatus(dojahResponse);
  const normalizedStatus = verificationStatus.toLowerCase();
  const livenessPassed = selfie.status !== false;
  const faceMatchPassed = faceMatch.status !== false;
  const overallPassed = overallStatus !== false;
  const completed = normalizedStatus === 'completed';
  const pending = PENDING_DOJAH_STATUSES.includes(normalizedStatus);
  const failed = FAILED_DOJAH_STATUSES.includes(normalizedStatus) || overallStatus === false;
  const confidenceValue = Number(
    dojahResponse.confidenceValue ??
    dojahResponse.confidence_value ??
    dojahResponse.confidence ??
    selfie.data?.confidenceValue ??
    selfie.data?.confidence_value ??
    selfie.data?.confidence ??
    faceMatch.data?.confidenceValue ??
    faceMatch.data?.confidence_value ??
    faceMatch.data?.confidence ??
    0
  );

  return {
    verificationStatus,
    completed,
    pending,
    failed,
    livenessPassed,
    faceMatchPassed,
    overallPassed,
    match: completed && overallPassed && livenessPassed && faceMatchPassed,
    confidenceValue,
  };
}

function readFailureReason(dojahResponse = {}, fallback = 'Verification failed') {
  const data = dojahResponse.data || {};
  return dojahResponse.message ||
    dojahResponse.reason ||
    dojahResponse.failureReason ||
    data.selfie?.message ||
    data.liveness?.message ||
    data.face_match?.message ||
    data.id?.message ||
    fallback;
}

function metadataBelongsToUser(metadata = {}, userId) {
  const expected = String(userId || '');
  const candidates = [
    metadata.userId,
    metadata.user_id,
    metadata.rijhubUserId,
    metadata.rijhub_user_id,
    metadata.customerId,
    metadata.customer_id,
  ].filter(Boolean).map(String);
  return candidates.includes(expected);
}

function makeSdkReferenceId(userId) {
  const stamp = Date.now().toString(36);
  return `rij_kyc_${stamp}_${userId}`;
}

function verifyDojahWebhookSignature(request) {
  const secret = process.env.DOJAH_WEBHOOK_SECRET;
  if (!secret) return true;

  const signature = request.headers['x-dojah-signature'] || request.headers['x-dojah-signature'.toLowerCase()];
  if (!signature) return false;

  const payload = request.rawBody || JSON.stringify(request.body || {});
  const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expected = String(digest);
  const received = String(signature).replace(/^sha256=/, '');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}

function buildSyncedUser(user) {
  return user ? {
    _id: user._id,
    kycVerified: user.kycVerified,
    isVerified: user.isVerified,
    kycLevel: user.kycLevel,
  } : null;
}

function buildSyncedArtisan(artisan) {
  return artisan ? {
    _id: artisan._id,
    verified: artisan.verified,
  } : null;
}

async function readMultipartPayload(request) {
  const payload = {};
  if (!request.isMultipart || typeof request.parts !== 'function') return payload;

  for await (const part of request.parts()) {
    const field = part.fieldname || part.field;
    if (!field) continue;

    if (part.file) {
      const chunks = [];
      for await (const chunk of part.file) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (field === 'selfie' || field === 'selfieImage' || field === 'selfie_image') {
        payload.selfieImage = buffer.toString('base64');
      }
      continue;
    }

    payload[field] = part.value;
  }

  return payload;
}

async function syncVerificationState({ userId, status, request }) {
  const approved = status === 'approved';
  const flags = approved ? APPROVED_FLAGS : UNAPPROVED_FLAGS;
  const [user, artisan] = await Promise.all([
    User.findByIdAndUpdate(userId, { $set: flags }, { new: true }),
    Artisan.findOneAndUpdate({ userId }, { $set: { verified: approved } }, { new: true }),
  ]);

  if (approved && user) {
    await createNotification(request.server, userId, {
      type: 'verification',
      title: 'ID verification approved',
      body: 'Your ID has been verified. You can now apply for jobs.',
      data: { verified: true, sendEmail: true, email: user.email },
    }).catch((err) => request.log?.warn?.('verification notification failed', err?.message || err));
  }

  return { user, artisan };
}

async function persistSdkVerification({ userId, referenceId, dojahResponse, status, providerStatus, failureReason, request }) {
  const checks = readDojahSdkChecks(dojahResponse);
  const threshold = Number(process.env.DOJAH_NIN_SELFIE_CONFIDENCE_THRESHOLD || 90);
  const entity = dojahResponse?.data?.government_data?.data?.nin?.entity ||
    dojahResponse?.data?.government_data?.data?.bvn?.entity ||
    {};

  const kyc = await Kyc.findOneAndUpdate(
    { userId },
    {
      $set: {
        userId,
        IdType: dojahResponse.id_type || dojahResponse.verification_type || 'NIN',
        idNumber: dojahResponse.verification_value || dojahResponse.value || entity.nin || entity.bvn || undefined,
        provider: 'dojah_sdk',
        verificationType: 'sdk_widget',
        referenceId,
        status,
        providerStatus,
        verifiedAt: status === 'approved' ? new Date() : undefined,
        failureReason,
        firstName: entity.first_name || entity.firstname || dojahResponse.data?.user_data?.data?.first_name || undefined,
        lastName: entity.last_name || entity.lastname || entity.surname || dojahResponse.data?.user_data?.data?.last_name || undefined,
        selfieVerification: {
          match: checks.match,
          confidenceValue: checks.confidenceValue,
          threshold,
        },
        providerResponse: sanitizeDojahResponse(dojahResponse),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, sort: { createdAt: -1 } }
  );

  const synced = await syncVerificationState({ userId, status, request });
  return { kyc, synced, checks, threshold };
}

export async function getDojahConfig(request, reply) {
  try {
    const config = getDojahWidgetConfig();
    return reply.send({
      success: true,
      data: config,
    });
  } catch (err) {
    const statusCode = err.code === 'DOJAH_WIDGET_CONFIG_MISSING' ? 500 : 500;
    return reply.code(statusCode).send({
      success: false,
      message: err.message || 'Failed to load Dojah SDK config',
    });
  }
}

export async function startDojahSdkSession(request, reply) {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });

  try {
    const referenceId = makeSdkReferenceId(userId);
    await Kyc.findOneAndUpdate(
      { userId },
      {
        $set: {
          userId,
          provider: 'dojah_sdk',
          verificationType: 'sdk_widget',
          referenceId,
          status: 'pending',
          providerStatus: 'started',
          failureReason: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, sort: { createdAt: -1 } }
    );

    await syncVerificationState({ userId, status: 'pending', request });

    return reply.send({
      success: true,
      data: { referenceId },
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to start Dojah verification session' });
  }
}

export async function verifyDojahReference(request, reply) {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });

  try {
    const referenceId = String(request.body?.referenceId || request.body?.reference_id || '').trim();
    if (!referenceId) return reply.code(400).send({ success: false, message: 'referenceId is required' });

    const existing = await Kyc.findOne({ referenceId }).lean();
    if (existing && String(existing.userId) !== String(userId)) {
      return reply.code(403).send({ success: false, message: 'referenceId belongs to a different user' });
    }

    let dojahResponse;
    try {
      dojahResponse = await getVerificationDetails(referenceId);
    } catch (err) {
      const statusCode = err.response?.status === 404 ? 404 : 502;
      const message = statusCode === 404
        ? 'referenceId not found at Dojah'
        : err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to fetch Dojah verification details';
      return reply.code(statusCode).send({ success: false, message });
    }

    const returnedReferenceId = readDojahReferenceId(dojahResponse, referenceId);
    if (String(returnedReferenceId) !== String(referenceId)) {
      return reply.code(400).send({ success: false, message: 'Dojah returned a different referenceId' });
    }

    const metadata = readDojahMetadata(dojahResponse);
    if (!existing && Object.keys(metadata || {}).length && !metadataBelongsToUser(metadata, userId)) {
      return reply.code(403).send({ success: false, message: 'referenceId belongs to a different user' });
    }
    if (!existing && !Object.keys(metadata || {}).length) {
      return reply.code(403).send({
        success: false,
        message: 'referenceId belongs to a different user',
      });
    }

    const checks = readDojahSdkChecks(dojahResponse);
    if (checks.pending) {
      const { kyc } = await persistSdkVerification({
        userId,
        referenceId,
        dojahResponse,
        status: 'pending',
        providerStatus: checks.verificationStatus || 'Pending',
        failureReason: null,
        request,
      });

      return reply.send({
        success: true,
        message: 'Verification still in progress',
        data: {
          status: kyc.status,
          provider: 'dojah',
          verificationType: 'sdk_widget',
          referenceId,
        },
      });
    }

    const approved = checks.completed && checks.match;
    const status = approved ? 'approved' : 'rejected';
    const failureReason = approved ? null : readFailureReason(dojahResponse, checks.failed ? 'Verification failed' : 'Liveness or face match check failed');
    const { kyc, synced, threshold } = await persistSdkVerification({
      userId,
      referenceId,
      dojahResponse,
      status,
      providerStatus: approved ? 'verified' : 'not_verified',
      failureReason,
      request,
    });

    return reply.send({
      success: true,
      message: approved ? 'KYC verification approved' : 'KYC verification rejected',
      data: {
        status: kyc.status,
        match: approved,
        confidenceValue: checks.confidenceValue,
        threshold,
        provider: 'dojah',
        verificationType: 'sdk_widget',
        referenceId,
        failureReason,
        user: buildSyncedUser(synced.user),
        artisan: buildSyncedArtisan(synced.artisan),
      },
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to verify Dojah reference' });
  }
}

export async function dojahWebhook(request, reply) {
  try {
    if (!verifyDojahWebhookSignature(request)) {
      return reply.code(401).send({ success: false, message: 'Invalid Dojah webhook signature' });
    }

    const payload = request.body || {};
    const referenceId = readDojahReferenceId(payload, payload.referenceId || payload.reference_id);
    if (!referenceId) return reply.code(400).send({ success: false, message: 'referenceId is required' });

    const kyc = await Kyc.findOne({ referenceId });
    if (!kyc) return reply.code(404).send({ success: false, message: 'KYC session not found for referenceId' });

    const checks = readDojahSdkChecks(payload);
    const status = checks.pending ? 'pending' : checks.completed && checks.match ? 'approved' : 'rejected';
    const providerStatus = checks.verificationStatus || (status === 'approved' ? 'Completed' : status);
    const failureReason = status === 'rejected' ? readFailureReason(payload, 'Verification failed') : null;

    await persistSdkVerification({
      userId: kyc.userId,
      referenceId,
      dojahResponse: payload,
      status,
      providerStatus,
      failureReason,
      request,
    });

    return reply.send({ success: true, message: 'Webhook processed' });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to process Dojah webhook' });
  }
}

export async function verifyNinSelfie(request, reply) {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });

  try {
    const multipartPayload = await readMultipartPayload(request);
    const payload = { ...(request.body || {}), ...multipartPayload };
    const nin = String(payload.nin || payload.idNumber || '').trim();
    const selfieImage = normalizeBase64Image(payload.selfieImage || payload.selfie_image || payload.selfie || '');
    const firstName = payload.firstName || payload.first_name;
    const lastName = payload.lastName || payload.last_name;
    const confidenceThreshold = Number(process.env.DOJAH_NIN_SELFIE_CONFIDENCE_THRESHOLD || 90);

    if (!nin) return reply.code(400).send({ success: false, message: 'nin is required' });
    if (!/^\d{11}$/.test(nin)) return reply.code(400).send({ success: false, message: 'nin must be 11 digits' });
    if (!selfieImage) return reply.code(400).send({ success: false, message: 'selfieImage is required' });

    let dojahResponse;
    try {
      dojahResponse = await verifyNinWithSelfie({ nin, selfieImage, firstName, lastName });
    } catch (err) {
      const failureReason = err.code === 'DOJAH_CONFIG_MISSING'
        ? err.message
        : err.response?.data?.message || err.response?.data?.error || err.message || 'Dojah verification failed';

      const kyc = await Kyc.findOneAndUpdate(
        { userId },
        {
          $set: {
            userId,
            IdType: 'NIN',
            idNumber: nin,
            provider: 'dojah',
            verificationType: 'nin_selfie',
            status: 'pending_review',
            providerStatus: 'failed',
            failureReason,
            providerResponse: sanitizeDojahResponse(err.response?.data || null),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, sort: { createdAt: -1 } }
      );

      await syncVerificationState({ userId, status: kyc.status, request });
      request.log?.warn?.({ err: failureReason, userId }, 'Dojah NIN selfie verification moved to manual review');

      return reply.code(err.code === 'DOJAH_CONFIG_MISSING' ? 500 : 202).send({
        success: err.code !== 'DOJAH_CONFIG_MISSING',
        message: err.code === 'DOJAH_CONFIG_MISSING'
          ? 'Dojah verification is not configured'
          : 'Automatic verification could not be completed. KYC moved to manual review.',
        data: {
          status: kyc.status,
          failureReason,
        },
      });
    }

    const { entity, match, confidenceValue } = readSelfieVerification(dojahResponse);
    const approved = match && confidenceValue >= confidenceThreshold;
    const status = approved ? 'approved' : 'rejected';
    const failureReason = approved
      ? null
      : `Selfie verification failed or confidence below threshold (${confidenceValue}/${confidenceThreshold})`;

    const kyc = await Kyc.findOneAndUpdate(
      { userId },
      {
        $set: {
          userId,
          IdType: 'NIN',
          idNumber: nin,
          provider: 'dojah',
          verificationType: 'nin_selfie',
          status,
          providerStatus: approved ? 'verified' : 'not_verified',
          verifiedAt: approved ? new Date() : undefined,
          failureReason,
          firstName: entity.first_name || entity.firstname || firstName || undefined,
          lastName: entity.last_name || entity.lastname || lastName || undefined,
          selfieVerification: {
            match,
            confidenceValue,
            threshold: confidenceThreshold,
          },
          providerResponse: sanitizeDojahResponse(dojahResponse),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, sort: { createdAt: -1 } }
    );

    const synced = await syncVerificationState({ userId, status, request });

    return reply.send({
      success: true,
      message: approved ? 'NIN selfie verification approved' : 'NIN selfie verification rejected',
      data: {
        status: kyc.status,
        match,
        confidenceValue,
        threshold: confidenceThreshold,
        user: synced.user ? {
          _id: synced.user._id,
          kycVerified: synced.user.kycVerified,
          isVerified: synced.user.isVerified,
          kycLevel: synced.user.kycLevel,
        } : null,
        artisan: synced.artisan ? {
          _id: synced.artisan._id,
          verified: synced.artisan.verified,
        } : null,
      },
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to verify NIN selfie' });
  }
}
