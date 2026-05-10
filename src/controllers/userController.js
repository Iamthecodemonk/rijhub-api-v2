import User from '../models/User.js';
import cloudinary from '../utils/cloudinary.js';
import bcrypt from 'bcryptjs';
import Artisan from '../models/Artisan.js';
import Booking from '../models/Booking.js';
import Transaction from '../models/Transaction.js';
import Chat from '../models/Chat.js';
import Quote from '../models/Quote.js';
import Application from '../models/Application.js';
import Job from '../models/Job.js';
import DeviceToken from '../models/DeviceToken.js';
import Kyc from '../models/Kyc.js';
import Notification from '../models/Notification.js';
import Review from '../models/Review.js';
import Wallet from '../models/Wallet.js';
import DeviceTokenAudit from '../models/DeviceTokenAudit.js';
import mongoose from 'mongoose';

function getUserKycFlags(status) {
  if (status === 'approved') {
    return { kycLevel: 2, kycVerified: true, isVerified: true };
  }
  return { kycLevel: 1, kycVerified: false, isVerified: false };
}

function buildPublicKycDetails(kycInfo = null) {
  if (!kycInfo) return null;
  return {
    status: kycInfo.status,
    providerStatus: kycInfo.providerStatus || null,
    failureReason: kycInfo.failureReason || null,
    idType: kycInfo.IdType || kycInfo.idType || null,
    verified: kycInfo.status === 'approved',
    submittedAt: kycInfo.createdAt,
  };
}

export async function getAllUsers(req, reply) {
  try {
    const { page = 1, limit = 50, role, q } = req.query || {};
    const filters = {};
    if (role) filters.role = role;
    if (q) filters.$or = [
      { name: { $regex: q, $options: 'i' } },
      { email: { $regex: q, $options: 'i' } },
    ];

    const total = await User.countDocuments(filters);
    const users = await User.find(filters)
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ createdAt: -1 })
      .lean();

    // expose total in header for client-side pagination
    try { reply.header('X-Total-Count', String(total)); } catch (e) { /* ignore if headers already sent */ }

    return reply.send({ success: true, data: users, meta: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit || 1)) } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, message: 'Server error' });
  }
}

export async function getUserById(req, reply) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return reply.code(404).send({ success: false, message: 'Not found' });
    return reply.send({ success: true, data: user });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, message: 'Server error' });
  }
}

export async function getMyProfile(req, reply) {
  try {
    const userId = req.user?.id;
    console.log(userId);
    if (!userId) return reply.code(401).send({ success: false, message: 'Unauthorized' });
    const [user, latestKyc] = await Promise.all([
      User.findById(userId),
      Kyc.findOne({ userId }).sort({ createdAt: -1 }).lean(),
    ]);
    if (!user) return reply.code(404).send({ success: false, message: 'User not found' });

    if (latestKyc) {
      const nextFlags = getUserKycFlags(latestKyc.status);
      const needsSync =
        user.kycLevel !== nextFlags.kycLevel ||
        !!user.kycVerified !== nextFlags.kycVerified ||
        !!user.isVerified !== nextFlags.isVerified;

      if (needsSync) {
        user.kycLevel = nextFlags.kycLevel;
        user.kycVerified = nextFlags.kycVerified;
        user.isVerified = nextFlags.isVerified;
        try {
          await User.findByIdAndUpdate(userId, { $set: nextFlags });
        } catch (syncErr) {
          req.log?.warn?.({ err: syncErr?.message || syncErr, userId }, 'failed to sync user kyc flags from latest kyc record');
        }
      }
    }

    const data = user.toObject ? user.toObject() : user;
    data.kycDetails = buildPublicKycDetails(latestKyc);

    return reply.send({ success: true, data });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Server error' });
  }
}

export async function createUser(req, reply) {
  try {
    const newUser = await User.create(req.body);
    return reply.code(201).send({ success: true, data: newUser });
  } catch (err) {
    req.log.error(err);
    reply.code(400).send({ success: false, message: err.message });
  }
}

export async function deleteProfileImage(req, reply) {
  try {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Unauthorized' });
    const user = await User.findById(userId);
    if (!user) return reply.code(404).send({ success: false, message: 'User not found' });
    const img = user.profileImage;
    if (!img || !img.public_id) return reply.code(404).send({ success: false, message: 'No profile image found' });
    try {
      await cloudinary.uploader.destroy(img.public_id, { resource_type: 'auto' });
    } catch (err) {
      req.log?.warn?.('cloudinary destroy failed', err?.message || err);
    }
    user.profileImage = {};
    await user.save();
    return reply.send({ success: true, message: 'Profile image removed' });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to delete profile image' });
  }
}

export async function updateMyProfile(req, reply) {
  try {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Unauthorized' });

    // Accept either JSON body or multipart with files (upload middleware attaches request.uploadedFiles)
    const body = req.body || {};

    // whitelist allowed fields
    const allowed = ['name', 'email', 'phone'];
    const updates = {};
    for (const k of allowed) if (k in body) updates[k] = body[k];

    // Handle password change explicitly
    if (body.password) {
      if (typeof body.password !== 'string' || body.password.length < 6) {
        return reply.code(400).send({ success: false, message: 'Password must be at least 6 characters' });
      }
      const hashed = await bcrypt.hash(body.password, 10);
      updates.password = hashed;
    }

    // If email provided, ensure uniqueness
    if (updates.email) {
      const existing = await User.findOne({ email: updates.email, _id: { $ne: userId } });
      if (existing) return reply.code(409).send({ success: false, message: 'Email already in use' });
    }

    // Handle uploaded profile image (if upload middleware used)
    if (req.uploadedFiles && Array.isArray(req.uploadedFiles) && req.uploadedFiles.length) {
      const file = req.uploadedFiles.find(f => f.field === 'profileImage') || req.uploadedFiles[0];
      if (file && file.buffer) {
        try {
          const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
          const res = await cloudinary.uploader.upload(dataUri, { folder: 'profiles', public_id: `user_${userId}_${Date.now()}`, overwrite: true, resource_type: 'auto' });
          updates.profileImage = { url: res.secure_url || res.url, public_id: res.public_id };
        } catch (err) {
          req.log?.warn?.('cloudinary upload failed', err?.message || err);
          return reply.code(500).send({ success: false, message: 'Failed to upload profile image' });
        }
      }
    }

    const user = await User.findByIdAndUpdate(userId, updates, { new: true });
    if (!user) return reply.code(404).send({ success: false, message: 'User not found' });
    return reply.send({ success: true, data: user });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to update profile' });
  }
}

// Delete authenticated user's account and related data across collections
export async function deleteMyAccount(req, reply) {
  return performUserDeletion(req.user?.id, req, reply);
}

// Helper to perform deletion logic for a given userId
async function performUserDeletion(targetUserId, req, reply) {
  try {
    if (!targetUserId) return reply.code(400).send({ success: false, message: 'user id required' });

    // sanitize common client id formats (some clients send "user:abcdef...")
    const raw = String(targetUserId);
    const candidate = raw.startsWith('user:') ? raw.split(':').pop() : raw;

    if (!mongoose.Types.ObjectId.isValid(candidate)) return reply.code(400).send({ success: false, message: 'invalid user id' });
    const userId = candidate;

    let user = await User.findById(userId).lean();
    // If no user found, allow admin to pass an Artisan _id — map to the owning user
    if (!user) {
      try {
        const artisan = await Artisan.findById(userId).lean();
        if (artisan && artisan.userId) {
          req.log?.info?.({ reqId: req.id, artisanId: userId, mappedUserId: artisan.userId }, 'performUserDeletion: mapped artisan id to user id');
          // use the artisan's userId as the target for deletion
          const mappedUserId = String(artisan.userId);
          if (!mongoose.Types.ObjectId.isValid(mappedUserId)) return reply.code(400).send({ success: false, message: 'invalid mapped user id' });
          user = await User.findById(mappedUserId).lean();
          if (!user) return reply.code(404).send({ success: false, message: 'User not found for provided artisan id' });
          // overwrite userId variable so downstream deletes use the correct id
          userId = mappedUserId;
        } else {
          return reply.code(404).send({ success: false, message: 'User not found' });
        }
      } catch (e) {
        req.log?.warn?.('performUserDeletion: artisan lookup failed', e?.message || e);
        return reply.code(404).send({ success: false, message: 'User not found' });
      }
    }

    const publicIds = [];
    if (user.profileImage && user.profileImage.public_id) publicIds.push(user.profileImage.public_id);

    try {
      const kycs = await Kyc.find({ userId }).lean();
      for (const k of kycs) {
        if (k.profileImage && k.profileImage.public_id) publicIds.push(k.profileImage.public_id);
        if (k.IdUploadFront && k.IdUploadFront.public_id) publicIds.push(k.IdUploadFront.public_id);
        if (k.IdUploadBack && k.IdUploadBack.public_id) publicIds.push(k.IdUploadBack.public_id);
      }
    } catch (e) { req.log?.warn?.('performUserDeletion: failed to read KYC records', e?.message || e); }

    try {
      const jobs = await Job.find({ clientId: userId }).lean();
      for (const j of jobs) {
        if (Array.isArray(j.attachments)) {
          for (const a of j.attachments) if (a && a.public_id) publicIds.push(a.public_id);
        }
      }
    } catch (e) { req.log?.warn?.('performUserDeletion: failed to read Jobs', e?.message || e); }

    for (const pid of publicIds) {
      try { await cloudinary.uploader.destroy(pid, { resource_type: 'auto' }); } catch (e) { req.log?.warn?.('cloudinary destroy failed', pid, e?.message || e); }
    }

    try {
      await Promise.all([
        Artisan.deleteMany({ userId }),
        Booking.deleteMany({ $or: [{ customerId: userId }, { artisanId: userId }] }),
        Transaction.deleteMany({ $or: [{ payerId: userId }, { payeeId: userId }] }),
        Chat.deleteMany({ participants: userId }),
        Quote.deleteMany({ $or: [{ customerId: userId }, { artisanId: userId }] }),
        Job.deleteMany({ clientId: userId }),
        DeviceToken.deleteMany({ userId }),
        Kyc.deleteMany({ userId }),
        Notification.deleteMany({ userId }),
        Review.deleteMany({ $or: [{ customerId: userId }, { artisanId: userId }] }),
        Wallet.deleteMany({ userId }),
        DeviceTokenAudit.deleteMany({ $or: [{ oldUserId: userId }, { newUserId: userId }] }),
      ]);
    } catch (e) {
      req.log?.error?.('performUserDeletion: failed to remove related documents', e?.message || e);
      return reply.code(500).send({ success: false, message: 'Failed to remove related data' });
    }

    try {
      await User.deleteOne({ _id: userId });
    } catch (e) {
      req.log?.error?.('performUserDeletion: failed to delete user', e?.message || e);
      return reply.code(500).send({ success: false, message: 'Failed to delete user record' });
    }

    return reply.send({ success: true, message: 'Account and related data deleted' });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to delete account' });
  }
}

export async function deleteUserById(req, reply) {
  try {
    const targetId = req.params?.id;
    if (!targetId) return reply.code(400).send({ success: false, message: 'id param required' });
    return performUserDeletion(targetId, req, reply);
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to delete user' });
  }
}

// Get full aggregated profile for a user (admin or the user themself)
export async function getFullCustomerProfile(req, reply) {
  try {
    const targetId = req.params?.id;
    const requester = req.user;
    if (!targetId) return reply.code(400).send({ success: false, message: 'id param required' });
    // allow admin or the user themself
    if (String(requester?.id) !== String(targetId) && requester?.role !== 'admin') return reply.code(403).send({ success: false, message: 'Forbidden' });
    if (!mongoose.Types.ObjectId.isValid(String(targetId))) return reply.code(400).send({ success: false, message: 'invalid id' });
    // pagination params: limit and per-collection cursors (createdAt ISO)
    const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
    const txCursor = req.query?.transactionsCursor || null;
    const bookingsCursor = req.query?.bookingsCursor || null;
    const jobsCursor = req.query?.jobsCursor || null;
    const quotesCursor = req.query?.quotesCursor || null;
    const notificationsCursor = req.query?.notificationsCursor || null;
    const reviewsCursor = req.query?.reviewsCursor || null;
    const applicationsCursor = req.query?.applicationsCursor || null;
    const chatsCursor = req.query?.chatsCursor || null;

    // helper to load a collection with cursor (createdAt). returns { items, nextCursor }
    const loadWithCursor = async (Model, filter = {}, options = {}) => {
      const sortField = options.sortField || 'createdAt';
      const populate = options.populate || null;
      const cursor = options.cursor || null;
      const q = { ...filter };
      if (cursor) {
        const dt = new Date(cursor);
        if (!isNaN(dt)) q[sortField] = { $lt: dt };
      }
      let query = Model.find(q).sort({ [sortField]: -1 }).limit(Number(limit) + 1);
      if (populate) query = query.populate(populate);
      const docs = await query.lean();
      let next = null;
      if (docs.length > limit) {
        const last = docs[limit - 1];
        next = last && last[sortField] ? new Date(last[sortField]).toISOString() : null;
        docs.splice(limit); // trim
      }
      return { items: docs, nextCursor: next };
    };

    const [user, artisan, wallet] = await Promise.all([
      User.findById(targetId).lean(),
      Artisan.findOne({ userId: targetId }).lean(),
      Wallet.findOne({ userId: targetId }).lean(),
    ]);
    if (!user) return reply.code(404).send({ success: false, message: 'User not found' });

    const [transactionsRes, bookingsRes, jobsRes, quotesRes, kycs, deviceTokens, notificationsRes, reviewsRes, applicationsRes, chatsRes] = await Promise.all([
      loadWithCursor(Transaction, { $or: [{ payerId: targetId }, { payeeId: targetId }] }, { cursor: txCursor, populate: [{ path: 'payerId', select: 'name email' }, { path: 'payeeId', select: 'name email' }] }),
      loadWithCursor(Booking, { $or: [{ customerId: targetId }, { artisanId: targetId }] }, { cursor: bookingsCursor, populate: [{ path: 'artisanId', select: 'name email profileImage' }, { path: 'customerId', select: 'name email profileImage' }] }),
      loadWithCursor(Job, { clientId: targetId }, { cursor: jobsCursor, populate: { path: 'clientId', select: 'name email profileImage' } }),
      loadWithCursor(Quote, { $or: [{ customerId: targetId }, { artisanId: targetId }] }, { cursor: quotesCursor, populate: [{ path: 'artisanId', select: 'name email profileImage' }, { path: 'customerId', select: 'name email profileImage' }] }),
      Kyc.find({ userId: targetId }).lean(),
      DeviceToken.find({ userId: targetId }).lean(),
      loadWithCursor(Notification, { userId: targetId }, { cursor: notificationsCursor }),
      loadWithCursor(Review, { $or: [{ customerId: targetId }, { artisanId: targetId }] }, { cursor: reviewsCursor }),
      loadWithCursor(Application, { $or: [{ artisanId: targetId }, { clientId: targetId }] }, { cursor: applicationsCursor, populate: { path: 'artisanId', select: 'name email' } }).catch(()=>({ items: [], nextCursor: null })),
      loadWithCursor(Chat, { participants: targetId }, { cursor: chatsCursor, sortField: 'updatedAt' }),
    ]);

    const data = {
      user,
      artisanProfile: artisan || null,
      wallet: wallet || null,
      transactions: transactionsRes.items || [],
      bookings: bookingsRes.items || [],
      jobs: jobsRes.items || [],
      quotes: quotesRes.items || [],
      kycs: kycs || [],
      deviceTokens: deviceTokens || [],
      notifications: notificationsRes.items || [],
      reviews: reviewsRes.items || [],
      applications: applicationsRes.items || [],
      chats: chatsRes.items || [],
      cursors: {
        transactions: transactionsRes.nextCursor || null,
        bookings: bookingsRes.nextCursor || null,
        jobs: jobsRes.nextCursor || null,
        quotes: quotesRes.nextCursor || null,
        notifications: notificationsRes.nextCursor || null,
        reviews: reviewsRes.nextCursor || null,
        applications: applicationsRes.nextCursor || null,
        chats: chatsRes.nextCursor || null,
      },
      counts: {
        transactions: (transactionsRes.items || []).length,
        bookings: (bookingsRes.items || []).length,
        jobs: (jobsRes.items || []).length,
        quotes: (quotesRes.items || []).length,
        kycs: (kycs || []).length,
        notifications: (notificationsRes.items || []).length,
        reviews: (reviewsRes.items || []).length,
        applications: (applicationsRes.items || []).length,
        chats: (chatsRes.items || []).length,
      },
    };

    return reply.send({ success: true, data });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to fetch full profile' });
  }
}
