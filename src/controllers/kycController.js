import Kyc from '../models/Kyc.js';
import User from '../models/User.js';
import Artisan from '../models/Artisan.js';
import cloudinary from '../utils/cloudinary.js';
import mongoose from 'mongoose';

function getUserKycFlags(status) {
  if (status === 'approved') {
    return { kycLevel: 2, kycVerified: true, isVerified: true };
  }
  return { kycLevel: 1, kycVerified: false, isVerified: false };
}

function buildKycStatusPayload(record = null, artisan = null, user = null) {
  return {
    status: record?.status || 'not_submitted',
    provider: record?.provider || null,
    providerStatus: record?.providerStatus || null,
    verificationType: record?.verificationType || null,
    failureReason: record?.failureReason || null,
    reviewedBy: record?.reviewedBy || null,
    submittedAt: record?.createdAt || null,
    verifiedAt: record?.verifiedAt || null,
    verified: !!(record?.status === 'approved' || artisan?.verified || user?.kycVerified || user?.isVerified),
    artisan: artisan ? {
      _id: artisan._id,
      userId: artisan.userId,
      verified: !!artisan.verified,
    } : null,
    user: user ? {
      _id: user._id,
      kycVerified: !!user.kycVerified,
      isVerified: !!user.isVerified,
      kycLevel: user.kycLevel || 0,
    } : null,
  };
}

export async function submitKyc(request, reply) {
  try {
    const payload = request.body || {};
    // console.log(request);
    console.log(payload)
    console.log('working');
    // If upload middleware recorded errors, return a clear response
    if (request.uploadErrors && request.uploadErrors.length) {
      request.log?.warn?.({ reqId: request.id, errors: request.uploadErrors }, 'KYC submit aborted due to upload errors');
      return reply.code(502).send({ success: false, message: 'Failed to upload one or more files', errors: request.uploadErrors, reqId: request.id });
    }
    // If a previous middleware already uploaded to Cloudinary, use those results
    // Only treat uploadedFiles as pre-uploaded when they include a `url` (cloudinary result).
    if (request.uploadedFiles && request.uploadedFiles.length && request.uploadedFiles[0].url) {
      for (const f of request.uploadedFiles) {
        if (!payload.files) payload.files = [];
        if (f.field && ['IdUploadFront', 'IdUploadBack', 'profileImage'].includes(f.field)) {
          payload[f.field] = { url: f.url, public_id: f.public_id };
        } else {
          payload.files.push({ filename: f.filename, mimetype: f.mimetype, url: f.url, public_id: f.public_id });
        }
      }
    } else if (request.isMultipart && typeof request.parts === 'function') {
      // stream parts directly to Cloudinary
      for await (const part of request.parts()) {
        if (part.file) {
          try {
            const res = await new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream({ folder: 'kyc', resource_type: 'auto' }, (err, result) => {
                if (err) return reject(err);
                resolve(result);
              });
              part.file.pipe(uploadStream);
            });
            const url = res.secure_url || res.url;
            const public_id = res.public_id;
            const fieldName = part.fieldname || part.field; // Fastify multipart uses 'fieldname'
            if (!payload.files) payload.files = [];
            if (fieldName && ['IdUploadFront', 'IdUploadBack', 'profileImage'].includes(fieldName)) {
              payload[fieldName] = { url, public_id };
            } else {
              payload.files.push({ filename: part.filename, mimetype: part.mimetype, url, public_id });
            }
          } catch (err) {
            request.log?.warn?.('cloudinary kyc upload failed', err?.message || err);
          }
        } else if (part.value !== undefined) {
          // Handle non-file form fields
          const fieldName = part.fieldname || part.field;
          try {
            const value = typeof part.value === 'string' && (part.value.startsWith('{') || part.value.startsWith('[')) 
              ? JSON.parse(part.value) 
              : part.value;
            payload[fieldName] = value;
          } catch {
            payload[fieldName] = part.value;
          }
        }
      }
    } else if (request.uploadedFiles && request.uploadedFiles.length) {
      // fallback to buffered files
      const streamUpload = (buffer, options = {}) => new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
          if (error) return reject(error);
          resolve(result);
        });
        uploadStream.end(buffer);
      });

      for (const f of request.uploadedFiles) {
        try {
          const res = await streamUpload(f.buffer, { folder: 'kyc', resource_type: 'auto' });
          const url = res.secure_url || res.url;
          const public_id = res.public_id;
          if (!payload.files) payload.files = [];
          if (f.field && ['IdUploadFront', 'IdUploadBack', 'profileImage'].includes(f.field)) {
            payload[f.field] = { url, public_id };
          } else {
            payload.files.push({ filename: f.filename, mimetype: f.mimetype, url, public_id });
          }
        } catch (err) {
          request.log?.warn?.('cloudinary kyc upload failed', err?.message || err);
        }
      }
    }
    // Kyc.create
    const kyc = await Kyc.create({ userId: request.user?.id || payload.userId, ...payload });

    // update user's KYC flags so the user document reflects the submission
    try {
      const uid = request.user?.id || payload.userId;
      if (uid) {
        await User.findByIdAndUpdate(uid, { $set: getUserKycFlags(kyc.status) });
      }
    } catch (err) {
      request.log?.warn?.({ err: err?.message || err, reqId: request.id }, 'failed to update user kyc flags');
    }

    return reply.code(201).send({ success: true, data: kyc });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(400).send({ success: false, message: err.message });
  }
}

export async function getKycStatus(request, reply) {
  try {
    const userId = request.user?.id || request.query.userId;
    if (!userId) return reply.code(400).send({ success: false, message: 'userId required' });
    const record = await Kyc.findOne({ userId }).sort({ createdAt: -1 });
    if (!record) return reply.code(404).send({ success: false, message: 'No KYC record' });
    return reply.send({ success: true, data: { status: record.status, reviewedBy: record.reviewedBy } });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to get KYC status' });
  }
}

export async function getArtisanKycStatus(request, reply) {
  try {
    const id = String(request.params?.id || '').trim();
    if (!id) return reply.code(400).send({ success: false, message: 'artisan id required' });
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ success: false, message: 'invalid artisan id' });
    }

    const artisan = await Artisan.findOne({
      $or: [
        { _id: id },
        { userId: id },
      ],
    }).lean();

    if (!artisan) return reply.code(404).send({ success: false, message: 'Artisan not found' });

    const [record, user] = await Promise.all([
      Kyc.findOne({ userId: artisan.userId }).sort({ createdAt: -1 }).lean(),
      User.findById(artisan.userId).select('_id kycVerified isVerified kycLevel').lean(),
    ]);

    return reply.send({
      success: true,
      data: buildKycStatusPayload(record, artisan, user),
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to get artisan KYC status' });
  }
}

export async function deleteKycFile(request, reply) {
  try {
    const { id } = request.params;
    const { field } = request.query; // expected: IdUploadFront | IdUploadBack | profileImage
    if (!field) return reply.code(400).send({ success: false, message: 'field query param required' });
    const allowed = ['IdUploadFront', 'IdUploadBack', 'profileImage'];
    if (!allowed.includes(field)) return reply.code(400).send({ success: false, message: 'invalid field' });
    const record = await Kyc.findById(id);
    if (!record) return reply.code(404).send({ success: false, message: 'KYC record not found' });
    // only owner or admin
    const userId = String(request.user?.id);
    if (String(record.userId) !== userId && request.user?.role !== 'admin') return reply.code(403).send({ success: false, message: 'Forbidden' });

    const fileObj = record[field];
    if (!fileObj || !fileObj.public_id) {
      return reply.code(404).send({ success: false, message: 'No file to delete' });
    }
    try {
      await cloudinary.uploader.destroy(fileObj.public_id, { resource_type: 'auto' });
    } catch (err) {
      request.log?.warn?.('cloudinary destroy failed', err?.message || err);
    }
    record[field] = null;
    await record.save();
    return reply.send({ success: true, message: 'File removed', data: record });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to delete file' });
  }
}
