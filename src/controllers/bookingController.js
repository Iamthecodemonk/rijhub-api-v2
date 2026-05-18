import Booking from '../models/Booking.js';
import Transaction from '../models/Transaction.js';
import Wallet from '../models/Wallet.js';
import Artisan from '../models/Artisan.js';
import Chat from '../models/Chat.js';
import { createNotification } from '../utils/notifier.js';
import { getConfig } from '../utils/config.js';
import axios from 'axios';
import ArtisanService from '../models/ArtisanService.js';
import JobSubCategory from '../models/JobSubCategory.js';
import { sendSms as sendChampSms } from '../utils/sendchamp.js';
import { normalizePaymentMode } from '../utils/paymentMode.js';
import { attemptPaystackTransfer, creditArtisanWalletIfNeeded, ensurePaystackRecipient, getPayoutNotificationState, hasFinalizedPayout, recordArtisanPayoutStatsIfNeeded, recordCustomerSpendStatsIfNeeded } from '../utils/payout.js';
import { getPaystackCallbackUrl } from '../utils/paystack.js';
import { buildPaystackSplitParams } from '../utils/paystackSplit.js';
import { formatNotificationDate, formatNotificationMoney } from '../utils/notificationText.js';

function normalizePhone(phone) {
  if (!phone) return phone;
  try {
    return String(phone).replace(/[^0-9]/g, '');
  } catch (e) { return phone; }
}

// Resolve an incoming artisan identifier (may be Artisan._id or User._id) to the canonical User._id
async function resolveToUserId(id) {
  if (!id) return null;
  try {
    // Try as Artisan._id
    const byArtisanId = await Artisan.findById(id).lean();
    if (byArtisanId && byArtisanId.userId) return String(byArtisanId.userId);
    // Try as Artisan.userId
    const byUserId = await Artisan.findOne({ userId: id }).lean();
    if (byUserId && byUserId.userId) return String(byUserId.userId);
    // Try as a User._id
    try {
      const UserModel = (await import('../models/User.js')).default;
      const u = await UserModel.findById(id).select('_id').lean();
      if (u) return String(u._id);
    } catch (e) {
      // ignore
    }
    return null;
  } catch (e) {
    return null;
  }
}

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const BOOKING_LOCAL_OFFSET_MINUTES = readNumberEnv('BOOKING_LOCAL_OFFSET_MINUTES', 60);
const BOOKING_DUPLICATE_WINDOW_MS = readNumberEnv('BOOKING_DUPLICATE_WINDOW_MS', 60 * 1000);

// Parse schedule input into a Date. If the incoming string has no timezone
// information (e.g. "2024-01-02T15:00:00"), treat it as local booking time
// in the platform timezone (WAT by default) before converting to UTC for
// storage. This keeps "3:00 PM" from drifting by an hour on environments
// running outside the business timezone.
function parseSchedule(input) {
  if (!input) return input;
  try {
    if (typeof input === 'string') {
      // detect ISO-like string without timezone (no Z and no +/- offset)
      const isoNoTz = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
      const match = input.match(isoNoTz);
      if (match) {
        const [, year, month, day, hour, minute, second = '00'] = match;
        const utcMs = Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hour),
          Number(minute),
          Number(second)
        ) - (BOOKING_LOCAL_OFFSET_MINUTES * 60 * 1000);
        return new Date(utcMs);
      }
      return new Date(input);
    }
    // if it's already a Date or number, let Date handle it
    return new Date(input);
  } catch (e) {
    return input;
  }
}

async function ensureCompletedPaidBookingStats({ booking, request }) {
  if (!booking || booking.status !== 'completed' || booking.paymentStatus !== 'paid') {
    return { updated: false, reason: 'booking_not_completed_paid' };
  }

  const customerId = booking.customerId?._id || booking.customerId;
  const artisanId = booking.artisanId?._id || booking.artisanId;
  const amount = Number(booking.price || 0);
  if (!customerId || !artisanId || amount <= 0) {
    return { updated: false, reason: 'missing_booking_parties_or_amount' };
  }

  let tx = await Transaction.findOne({ bookingId: booking._id }).sort({ createdAt: -1 });
  let feePct = 0;
  try {
    const cfgVal = await getConfig('COMPANY_FEE_PCT');
    if (cfgVal !== null && !isNaN(Number(cfgVal))) feePct = Number(cfgVal);
  } catch (e) {
    request.log?.warn?.('Failed to read COMPANY_FEE_PCT while repairing booking stats', e?.message || e);
  }

  const existingFee = tx && tx.companyFee !== undefined && tx.companyFee !== null ? Number(tx.companyFee) : null;
  const fee = existingFee !== null && Number.isFinite(existingFee) ? existingFee : Math.round((amount * feePct) / 100 * 100) / 100;
  const payAmount = Math.round(Number(tx?.transferAmount || (amount - fee)) * 100) / 100;

  if (!tx) {
    tx = await Transaction.create({
      bookingId: booking._id,
      payerId: customerId,
      payeeId: artisanId,
      amount,
      companyFee: fee,
      transferAmount: payAmount,
      status: 'paid',
      releasedAt: new Date(),
    });
    request.log?.warn?.({ bookingId: String(booking._id), transactionId: String(tx._id) }, 'created reconciliation transaction for completed paid booking');
  } else {
    tx.payerId = tx.payerId || customerId;
    tx.payeeId = tx.payeeId || artisanId;
    tx.amount = Number(tx.amount || amount);
    tx.companyFee = Number(tx.companyFee || fee);
    tx.transferAmount = Number(tx.transferAmount || payAmount);
    if (tx.status === 'pending') tx.status = 'paid';
    await tx.save();
  }

  const artisanWallet = await Wallet.findOne({ userId: artisanId }) || await Wallet.create({ userId: artisanId });
  const customerWallet = await Wallet.findOne({ userId: customerId }) || await Wallet.create({ userId: customerId });
  const artisanUpdated = await recordArtisanPayoutStatsIfNeeded({ tx, wallet: artisanWallet, payAmount });
  const customerUpdated = await recordCustomerSpendStatsIfNeeded({ tx, wallet: customerWallet, amount: Number(tx.amount || amount) });

  request.log?.info?.({
    bookingId: String(booking._id),
    transactionId: String(tx._id),
    artisanId: String(artisanId),
    customerId: String(customerId),
    payAmount,
    amount: Number(tx.amount || amount),
    artisanUpdated,
    customerUpdated,
  }, 'completed paid booking stats ensured');

  return { updated: artisanUpdated || customerUpdated, artisanUpdated, customerUpdated, transactionId: tx._id };
}

function applyDirectBookingState(payload, paymentMode) {
  if (paymentMode === 'afterCompletion') {
    payload.paymentMode = 'afterCompletion';
    payload.status = 'awaiting-acceptance';
    return;
  }

  payload.paymentMode = 'upfront';
  payload.status = 'pending';
}

async function ensureBookingChat(booking, request) {
  try {
    if (!booking || booking.chatId || !booking.customerId || !booking.artisanId) return booking;
    const chat = await Chat.create({
      bookingId: booking._id,
      participants: [booking.customerId, booking.artisanId],
      messages: []
    });
    booking.chatId = chat._id;
    await booking.save();
  } catch (e) {
    request.log?.warn?.('create booking chat failed', e?.message || e);
  }
  return booking;
}

async function repairExistingDirectBooking(existingBooking, requestedPaymentMode, request) {
  let changed = false;

  if (requestedPaymentMode === 'afterCompletion') {
    if (existingBooking.paymentMode !== 'afterCompletion') {
      existingBooking.paymentMode = 'afterCompletion';
      changed = true;
    }
    if (existingBooking.status === 'pending') {
      existingBooking.status = 'awaiting-acceptance';
      changed = true;
    }
  }

  if (changed) {
    await existingBooking.save();
  }

  await ensureBookingChat(existingBooking, request);
  return existingBooking;
}

// Orchestration: create booking + initialize payment (one-call hire endpoint)
export async function hireAndInitialize(request, reply) {
  try {
    const { artisanId: incomingArtisanId, schedule, price: providedPrice, notes, email, customerCoords, categoryId, subCategoryId, artisanServiceId, services } = request.body || {};
    if (!incomingArtisanId || !schedule || !email) return reply.code(400).send({ success: false, message: 'artisanId, schedule and email are required' });

    const artisanUserId = await resolveToUserId(incomingArtisanId);
    if (!artisanUserId) return reply.code(404).send({ success: false, message: 'Artisan not found' });

    let price = providedPrice;
    let serviceName = null;

    // If multiple services provided, compute server-side total using ArtisanService pricing
    if (Array.isArray(services) && services.length > 0) {
      // fetch artisan's service price list(s). Search both canonical user id and original incoming id across all categories
      const incomingId = incomingArtisanId;
      const svcDocs = await ArtisanService.find({ artisanId: { $in: [artisanUserId, incomingId] } }).lean();
      request.log?.debug?.({ msg: 'hireAndInitialize: found svcDocs', incomingArtisanId, artisanUserId, svcCount: svcDocs?.length || 0 });
      if (!svcDocs || svcDocs.length === 0) return reply.code(400).send({ success: false, message: 'No services configured for this artisan and category' });

      // aggregate service entries across found docs to support legacy splits
      const allServiceEntries = [];
      for (const d of svcDocs) if (Array.isArray(d.services)) allServiceEntries.push(...d.services);
      try {
        const svcSummary = svcDocs.map(d => ({ id: String(d._id), artisanId: String(d.artisanId), services: (d.services || []).map(s => String(s.subCategoryId)) }));
        request.log?.debug?.({ msg: 'hireAndInitialize: svcSummary', svcSummary, allServiceEntriesCount: allServiceEntries.length });
      } catch (e) { /* ignore logging errors */ }

      const subIds = services.map(s => String(s.subCategoryId));
      const subs = await JobSubCategory.find({ _id: { $in: subIds } }).select('name').lean();
      const subMap = {}; subs.forEach(s => { subMap[String(s._id)] = s; });

      const normalized = [];
      let total = 0;
      for (const s of services) {
        const subId = String(s.subCategoryId);
        const qty = Math.max(1, Number(s.quantity || 1));
        const entry = allServiceEntries.find(x => String(x.subCategoryId) === subId);
        if (!entry) {
          request.log?.debug?.({ msg: 'hireAndInitialize: missing sub service', subId, allServiceEntriesSubIds: allServiceEntries.map(ae => String(ae.subCategoryId)) });
          return reply.code(400).send({ success: false, message: `Sub service ${subId} not offered by artisan` });
        }
        const unit = Number(entry.price || 0);
        const t = unit * qty;
        normalized.push({ subCategoryId: subId, name: subMap[subId]?.name || '', unitPrice: unit, quantity: qty, totalPrice: t });
        total += t;
      }
      price = total;
      serviceName = normalized.map(n => n.name || '').filter(Boolean).join(', ');
      // attach normalized services to payload for persistence
      request.body.services = normalized;
    } else if ((!price || Number(price) === 0) && (subCategoryId || artisanServiceId)) {
      const svcQuery = { artisanId };
      if (artisanServiceId) svcQuery._id = artisanServiceId;
      if (categoryId) svcQuery.categoryId = categoryId;
      // search both user id and original incoming id (to support legacy records)
      const svcDocsSingle = await ArtisanService.find({ artisanId: { $in: [incomingArtisanId, artisanUserId] }, categoryId }).lean();
      if (!svcDocsSingle || svcDocsSingle.length === 0) return reply.code(400).send({ success: false, message: 'No services configured for this artisan and category' });
      let entry = null;
      for (const sd of svcDocsSingle) {
        if (!Array.isArray(sd.services)) continue;
        entry = sd.services.find(s => String(s.subCategoryId) === String(subCategoryId));
        if (entry) break;
      }
      if (!entry) return reply.code(400).send({ success: false, message: 'Sub service not offered by artisan' });
      price = entry.price;
      const sub = await JobSubCategory.findById(subCategoryId).select('name').lean();
      serviceName = sub?.name || null;
    }

    if (!price || Number(price) <= 0) return reply.code(400).send({ success: false, message: 'price is required or must be resolvable from artisan services' });

    const requestedPaymentMode = normalizePaymentMode(request.body?.paymentMode);
    if (request.body?.paymentMode && !requestedPaymentMode) return reply.code(400).send({ success: false, message: 'Invalid paymentMode' });
    const parsedSchedule = parseSchedule(schedule);
    const payload = { artisanId: artisanUserId, schedule: parsedSchedule, price, notes };
    // Direct bookings with deferred payment should wait for artisan acceptance.
    applyDirectBookingState(payload, requestedPaymentMode);
    if (serviceName) payload.service = serviceName;
    if (request.body.services) payload.services = request.body.services;
    // prefer authenticated user id
    if (request.user && request.user.id) payload.customerId = request.user.id;
    const duplicateCutoff = new Date(Date.now() - BOOKING_DUPLICATE_WINDOW_MS);

    // Guard: avoid duplicate booking creation for direct hires
    const existingBooking = await Booking.findOne({
      customerId: payload.customerId,
      artisanId: payload.artisanId,
      schedule: parsedSchedule, // exact schedule match
      price: Number(price),
      status: { $in: ['awaiting-acceptance', 'pending', 'accepted'] }, // only check active bookings
      createdAt: { $gte: duplicateCutoff }
    });
    if (existingBooking) {
      await repairExistingDirectBooking(existingBooking, requestedPaymentMode, request);
      return reply.code(200).send({ success: true, data: { booking: existingBooking, message: 'Booking already exists for this request' } });
    }

    const booking = await Booking.create(payload);

    // create a chat thread for the booking so messaging works even before payment is completed
    await ensureBookingChat(booking, request);

    if (payload.paymentMode === 'afterCompletion') {
      (async () => {
        try {
          const User = (await import('../models/User.js')).default;
          const artisanUser = await User.findById(booking.artisanId).select('phone email name').lean();
          const artisanEmail = artisanUser?.email;
          // Get customer name for better notification
          let customerName = request.user?.name || null;
          if (!customerName && booking.customerId) {
            try { const cu = await User.findById(booking.customerId).select('name').lean(); if (cu) customerName = cu.name; } catch (e) { /* ignore */ }
          }
          const scheduleDate = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
          const bookingName = booking?.service || 'Booking';
          const notificationBody = `${booking.service || 'Service'} for ${formatNotificationMoney(booking.price)} on ${scheduleDate}. Customer: ${customerName || 'N/A'}.`;
          await createNotification(request.server, booking.artisanId, { type: 'booking', title: 'New booking awaiting acceptance', body: notificationBody, data: { bookingId: booking._id, bookingName, sendEmail: true, email: artisanEmail } });
          try {
            const artisanPhone = normalizePhone(artisanUser?.phone);
            let customerPhone = normalizePhone(request.user?.phone || null);
            if (!customerPhone && booking.customerId) {
              try { const cu = await User.findById(booking.customerId).select('phone').lean(); 
                if (cu) { 
                  customerPhone = normalizePhone(cu.phone); } } catch (e) { /* ignore */ }
            }
            if (artisanPhone) {
              const msg = `New booking: ${booking.service || 'N/A'}\nAmount: ${booking.price || 'N/A'}\nSchedule: ${booking.schedule || 'N/A'}\nCustomer: ${customerName || 'N/A'} ${customerPhone ? '(' + customerPhone + ')' : ''}\nNotes: ${booking.notes || ''}`;
              await sendChampSms(artisanPhone, msg);
            }
          } catch (smsErr) {
            request.log?.warn?.('async send SMS to artisan failed', smsErr?.message || smsErr);
          }
        } catch (e) {
          request.log?.warn?.('async notify artisan on booking failed', e?.message || e);
        }
      })();

      return reply.code(201).send({ success: true, message: 'Booking created with pay-after-service payment; customer must pay before completion.', data: { booking } });
    }

    // NOTE: notification moved below to run after payment initialization

    // If Paystack not configured, return booking and instruct client to pay separately
    if (!process.env.PAYSTACK_SECRET_KEY) {
      // notify artisan asynchronously in background so this endpoint returns quickly
      (async () => {
        try {
          const User = (await import('../models/User.js')).default;
          const artisanUser = await User.findById(booking.artisanId).select('phone email name').lean();
          const artisanEmail = artisanUser?.email;
          // Get customer name for better notification
          let customerName = request.user?.name || null;
          if (!customerName && booking.customerId) {
            try { const cu = await User.findById(booking.customerId).select('name').lean(); if (cu) customerName = cu.name; } catch (e) { /* ignore */ }
          }
          const scheduleDate = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
          const bookingName = booking?.service || 'Booking';
          const notificationBody = `${booking.service || 'Service'} for ${formatNotificationMoney(booking.price)} on ${scheduleDate}. Customer: ${customerName || 'N/A'}.`;
          await createNotification(request.server, booking.artisanId, { type: 'booking', title: 'New booking', body: notificationBody, data: { bookingId: booking._id, bookingName, sendEmail: true, email: artisanEmail } });
          try {
            const artisanPhone = normalizePhone(artisanUser?.phone);
            // try to obtain customer info from request.user or booking payload
            let customerPhone = normalizePhone(request.user?.phone || null);
            if (!customerPhone && booking.customerId) {
              try { const cu = await User.findById(booking.customerId).select('phone').lean(); if (cu) { customerPhone = normalizePhone(cu.phone); } } catch (e) { /* ignore */ }
            }
            if (artisanPhone) {
              const msg = `New booking: ${booking.service || 'N/A'}\nAmount: ${booking.price || 'N/A'}\nSchedule: ${booking.schedule || 'N/A'}\nCustomer: ${customerName || 'N/A'} ${customerPhone ? '(' + customerPhone + ')' : ''}\nNotes: ${booking.notes || ''}`;
              await sendChampSms(artisanPhone, msg);
            }
          } catch (smsErr) {
            request.log?.warn?.('async send SMS to artisan failed', smsErr?.message || smsErr);
          }
        } catch (e) {
          request.log?.warn?.('async notify artisan on booking failed', e?.message || e);
        }
      })();

      return reply.code(201).send({ success: true, message: 'Booking created (Paystack not configured)', data: { booking } });
    }

    // initialize paystack transaction
    const amountInKobo = Math.round(Number(price) * 100);
    const callbackUrl = getPaystackCallbackUrl();
    const split = await buildPaystackSplitParams({ artisanUserId: booking.artisanId, amount: Number(price) || 0, request });
    const res = await axios.post('https://api.paystack.co/transaction/initialize', {
      email,
      amount: amountInKobo,
      metadata: { bookingId: booking._id, customerCoords },
      callback_url: callbackUrl,
      ...split.params,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const init = res?.data?.data;
    if (init) {
      // create local transaction record for reconciliation
      await Transaction.create({
        bookingId: booking._id,
        payerId: payload.customerId || null,
        amount: Number(price) || 0,
        status: 'pending',
        paymentGatewayRef: init.reference,
        paystackSplit: split.enabled,
        paystackSubaccountCode: split.meta?.subaccountCode,
        paystackSplitBearer: split.meta?.bearer,
        paystackTransactionCharge: split.meta?.transactionCharge,
        paystackSplitMeta: split.meta,
        companyFee: split.meta?.companyFee,
        transferAmount: split.meta?.transferAmount,
      });
    }

    // notify artisan asynchronously after payment initialization to avoid blocking response
    (async () => {
      try {
        const User = (await import('../models/User.js')).default;
        const artisanUser = await User.findById(booking.artisanId).select('phone email name').lean();
        const artisanEmail = artisanUser?.email;
        // Get customer name for better notification
        let customerName = request.user?.name || null;
        if (!customerName && booking.customerId) {
          try { const cu = await User.findById(booking.customerId).select('name').lean(); if (cu) customerName = cu.name; } catch (e) { /* ignore */ }
        }
        const scheduleDate = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
        const bookingName = booking?.service || 'Booking';
        const notificationBody = `${booking.service || 'Service'} for ${formatNotificationMoney(booking.price)} on ${scheduleDate}. Customer: ${customerName || 'N/A'}. Payment pending.`;
        await createNotification(request.server, booking.artisanId, { type: 'booking', title: 'New booking - payment pending', body: notificationBody, data: { bookingId: booking._id, bookingName, sendEmail: true, email: artisanEmail } });
        try {
          const artisanPhone = artisanUser?.phone;
          if (artisanPhone) {
            // try to obtain customer info from request.user or booking payload
            let customerName = request.user?.name || null;
            let customerPhone = normalizePhone(request.user?.phone || null);
            if (!customerName && booking.customerId) {
              try { const cu = await User.findById(booking.customerId).select('name phone').lean(); if (cu) { customerName = cu.name; customerPhone = normalizePhone(cu.phone); } } catch (e) { /* ignore */ }
            }
            const msg = `New booking: ${booking.service || 'N/A'}\nAmount: ${booking.price || 'N/A'}\nSchedule: ${booking.schedule || 'N/A'}\nCustomer: ${customerName || 'N/A'} ${customerPhone ? '(' + customerPhone + ')' : ''}\nNotes: ${booking.notes || ''}`;
            await sendChampSms(artisanPhone, msg);
          }
        } catch (smsErr) {
          request.log?.warn?.('async send SMS to artisan after payment init failed', smsErr?.message || smsErr);
        }
      } catch (e) {
        request.log?.warn?.('async notify artisan after payment init failed', e?.message || e);
      }
    })();

    return reply.code(201).send({ success: true, data: { booking, payment: res.data.data } });
  } catch (err) {
    request.log?.error?.(err?.response?.data || err?.message || err);
    return reply.code(500).send({ success: false, message: 'Failed to create booking and initialize payment' });
  }
}

export async function listBookings(request, reply) {
  try {
    const { page = 1, limit = 20, status } = request.query || {};
    const q = {};
    if (status) q.status = status;
    const bookings = await Booking.find(q)
      .select('service schedule status price customerId artisanId acceptedQuote createdAt paymentStatus')
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ createdAt: -1 })
      .lean();
    return reply.send({ success: true, data: bookings });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list bookings' });
  }
}

// GET bookings for a specific customer with artisan user and profile details
export async function getCustomerBookings(request, reply) {
  try {
    const customerId = request.params.customerId || request.query.customerId || request.user?.id;
    if (!customerId) return reply.code(400).send({ success: false, message: 'customerId is required' });

    // authorize: customer themselves or admin
    if (String(request.user?.id) !== String(customerId) && request.user?.role !== 'admin') {
      return reply.code(403).send({ success: false, message: 'Forbidden' });
    }

    const { page = 1, limit = 20, status } = request.query || {};
    const q = { customerId };
    if (status) q.status = status;

    // fetch bookings with projection and lean
    const bookings = await Booking.find(q)
      .select('service schedule status price customerId artisanId acceptedQuote createdAt paymentStatus')
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ createdAt: -1 })
      .lean();

    // attach artisan user basic fields in batch
    const artisanIds = [...new Set(bookings.map(b => String(b.artisanId || '')).filter(Boolean))];
    const UserModel = (await import('../models/User.js')).default;
    const artisanUsers = artisanIds.length ? await UserModel.find({ _id: { $in: artisanIds } }, 'name email profileImage phone').lean() : [];
    const artisanMapUser = {}; for (const u of artisanUsers) artisanMapUser[String(u._id)] = u;

    // attach artisan profiles
    const artisanProfiles = artisanIds.length ? await Artisan.find({ userId: { $in: artisanIds } }).lean() : [];
    const artisanProfileMap = {}; artisanProfiles.forEach(a => { artisanProfileMap[String(a.userId)] = a; });

    const result = bookings.map(b => ({
      booking: b,
      artisanUser: artisanMapUser[String(b.artisanId)] || null,
      artisanProfile: artisanProfileMap[String(b.artisanId)] || null,
    }));

    return reply.send({ success: true, data: result });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to fetch customer bookings' });
  }
}

// GET bookings for a specific artisan with customer user and profile details
export async function getArtisanBookings(request, reply) {
  try {
    const artisanId = request.params.artisanId || request.query.artisanId || request.user?.id;
    if (!artisanId) return reply.code(400).send({ success: false, message: 'artisanId is required' });

    // authorize: artisan themselves or admin
    if (String(request.user?.id) !== String(artisanId) && request.user?.role !== 'admin') {
      return reply.code(403).send({ success: false, message: 'Forbidden' });
    }

    const { page = 1, limit = 20, status } = request.query || {};
    const q = { artisanId };
    if (status) q.status = status;

    // fetch bookings with projection and lean
    const bookings = await Booking.find(q)
      .select('service schedule status price customerId artisanId acceptedQuote createdAt paymentStatus')
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ createdAt: -1 })
      .lean();

    const customerIds = [...new Set(bookings.map(b => String(b.customerId || '')).filter(Boolean))];
    const UserModel = (await import('../models/User.js')).default;
    const customerUsers = customerIds.length ? await UserModel.find({ _id: { $in: customerIds } }, 'name email profileImage phone').lean() : [];
    const customerMap = {}; for (const u of customerUsers) customerMap[String(u._id)] = u;

    const result = bookings.map(b => ({ booking: b, customerUser: customerMap[String(b.customerId)] || null }));

    return reply.send({ success: true, data: result });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to fetch artisan bookings' });
  }
}

export async function createBooking(request, reply) {
  try {
    const payload = request.body || {};
    // Normalize schedule to Date and avoid timezone-less offset issues
    if (payload.schedule) payload.schedule = parseSchedule(payload.schedule);
    const requestedPaymentMode = normalizePaymentMode(payload.paymentMode);
    if (payload.paymentMode && !requestedPaymentMode) return reply.code(400).send({ success: false, message: 'Invalid paymentMode' });
    // Direct bookings with deferred payment should wait for artisan acceptance.
    applyDirectBookingState(payload, requestedPaymentMode);
    // If multiple services provided, compute server-side total using ArtisanService pricing
    if (Array.isArray(payload.services) && payload.services.length > 0) {
      // normalize incoming artisan id to User._id
      const artisanUserId = await resolveToUserId(payload.artisanId);
      if (!artisanUserId) return reply.code(404).send({ success: false, message: 'Artisan not found' });
      payload.artisanId = artisanUserId;
      // fetch all ArtisanService docs for this artisan (support legacy artisan._id records too)
      const svcDocsAll = await ArtisanService.find({ artisanId: { $in: [payload.artisanId, payload.artisanId] } }).lean();
      if (!svcDocsAll || svcDocsAll.length === 0) return reply.code(400).send({ success: false, message: 'No services configured for this artisan' });
      const allServiceEntries = [];
      for (const d of svcDocsAll) if (Array.isArray(d.services)) allServiceEntries.push(...d.services);

      const subIds = payload.services.map(s => String(s.subCategoryId));
      const subs = await JobSubCategory.find({ _id: { $in: subIds } }).select('name').lean();
      const subMap = {}; subs.forEach(s => { subMap[String(s._id)] = s; });

      const normalized = [];
      let total = 0;
      for (const s of payload.services) {
        const subId = String(s.subCategoryId);
        const qty = Math.max(1, Number(s.quantity || 1));
        const entry = allServiceEntries.find(x => String(x.subCategoryId) === subId);
        if (!entry) return reply.code(400).send({ success: false, message: `Sub service ${subId} not offered by artisan` });
        const unit = Number(entry.price || 0);
        const t = unit * qty;
        normalized.push({ subCategoryId: subId, name: subMap[subId]?.name || '', unitPrice: unit, quantity: qty, totalPrice: t });
        total += t;
      }
      payload.price = total;
      payload.service = normalized.map(n => n.name).filter(Boolean).join(', ');
      payload.services = normalized;
    } else {
      // Attempt to resolve price from artisan services when subCategoryId provided
      if ((!payload.price || Number(payload.price) === 0) && payload.subCategoryId && payload.artisanId) {
        // normalize incoming artisan id to User._id
        const artisanUserId2 = await resolveToUserId(payload.artisanId);
        if (!artisanUserId2) return reply.code(404).send({ success: false, message: 'Artisan not found' });
        payload.artisanId = artisanUserId2;
        const svcDoc = await ArtisanService.findOne({ artisanId: payload.artisanId, categoryId: payload.categoryId }).lean();
        if (svcDoc) {
          const entry = svcDoc.services.find(s => String(s.subCategoryId) === String(payload.subCategoryId));
          if (entry) {
            payload.price = entry.price;
            const sub = await JobSubCategory.findById(payload.subCategoryId).select('name').lean();
            if (sub) payload.service = sub.name;
          }
        }
      }
    }
    const duplicateCutoff = new Date(Date.now() - BOOKING_DUPLICATE_WINDOW_MS);

    // Guard: avoid duplicate booking creation for direct bookings
    const existingBooking = await Booking.findOne({
      customerId: payload.customerId,
      artisanId: payload.artisanId,
      schedule: payload.schedule ? payload.schedule : undefined,
      price: payload.price ? Number(payload.price) : undefined,
      status: { $in: ['awaiting-acceptance', 'pending', 'accepted'] }, // only check active bookings
      createdAt: { $gte: duplicateCutoff }
    });
    if (existingBooking) {
      await repairExistingDirectBooking(existingBooking, requestedPaymentMode, request);
      return reply.code(200).send({ success: true, data: { booking: existingBooking, message: 'Booking already exists for this request' } });
    }

    const booking = await Booking.create(payload);

    // create a chat thread for the booking so messaging works even before payment is completed
    await ensureBookingChat(booking, request);

    // notify artisan asynchronously (non-blocking)
    (async () => {
      try {
        const User = (await import('../models/User.js')).default;
        const artisanUser = await User.findById(booking.artisanId).select('name email phone').lean();
        const artisanPhone = artisanUser?.phone;
        if (artisanPhone) {
          // attempt to include customer info
          let customerName = request.user?.name || null;
          let customerPhone = normalizePhone(request.user?.phone || null);
          if (!customerName && booking.customerId) {
            try { const cu = await User.findById(booking.customerId).select('name phone').lean(); if (cu) { customerName = cu.name; customerPhone = normalizePhone(cu.phone); } } catch (e) { /* ignore */ }
          }
          const msg = `New booking: ${booking.service || 'N/A'}\nAmount: ${booking.price || 'N/A'}\nSchedule: ${booking.schedule || 'N/A'}\nCustomer: ${customerName || 'N/A'} ${customerPhone ? '(' + customerPhone + ')' : ''}\nNotes: ${booking.notes || ''}`;
          await sendChampSms(artisanPhone, msg);
        }
        // Build notification message with booking details
        let notificationTitle = 'New booking';
        let notificationBody = `A new booking created.`;
        if (booking.paymentMode === 'afterCompletion') {
          notificationTitle = 'New booking awaiting your acceptance';
          const scheduleDate = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
          let customerName = request.user?.name || null;
          if (!customerName && booking.customerId) {
            try { const cu = await User.findById(booking.customerId).select('name').lean(); if (cu) customerName = cu.name; } catch (e) { /* ignore */ }
          }
          notificationBody = `${booking.service || 'Service'} for ${formatNotificationMoney(booking.price)} on ${scheduleDate}. Customer: ${customerName || 'N/A'}.`;
        }
        await createNotification(request.server, booking.artisanId, { type: 'booking', title: notificationTitle, body: notificationBody, data: { bookingId: booking._id } });
      } catch (e) {
        request.log?.warn?.('async notify artisan on createBooking failed', e?.message || e);
      }
    })();

    return reply.code(201).send({ success: true, data: booking });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(400).send({ success: false, message: err.message });
  }
}

export async function initiateDeferredPayment(request, reply) {
  try {
    const booking = await Booking.findById(request.params.id).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });
    if (booking.paymentMode !== 'afterCompletion') return reply.code(400).send({ success: false, message: 'Booking is not configured for deferred payment' });
    if (booking.paymentStatus === 'paid') return reply.code(400).send({ success: false, message: 'Booking is already paid' });
    if (!['accepted', 'in-progress', 'completed'].includes(booking.status)) {
      return reply.code(400).send({ success: false, message: `Payment after service is not available from status: ${booking.status}` });
    }

    const existingTx = await Transaction.findOne({ bookingId: booking._id, status: { $in: ['pending', 'holding'] } });
    if (existingTx) {
      const message = existingTx.status === 'holding'
        ? 'Deferred payment already initialized and waiting for completion release.'
        : 'Deferred payment already initialized; use the existing transaction reference to complete payment.';
      return reply.code(200).send({ success: true, message, data: { booking, transaction: existingTx } });
    }

    const email = request.body?.email || booking.customerId?.email;
    if (!email) return reply.code(400).send({ success: false, message: 'Email required to initialize payment' });

    if (!process.env.PAYSTACK_SECRET_KEY) {
      const tx = await Transaction.create({ bookingId: booking._id, payerId: request.user?.id || booking.customerId?._id || null, amount: Number(booking.price) || 0, status: 'pending', paymentGatewayRef: null });
      return reply.code(201).send({ success: true, message: 'Deferred payment recorded; Paystack is not configured.', data: { booking, transaction: tx } });
    }

    const amountInKobo = Math.round(Number(booking.price || 0) * 100);
    const callbackUrl = getPaystackCallbackUrl();
    const split = await buildPaystackSplitParams({ artisanUserId: booking.artisanId?._id || booking.artisanId, amount: Number(booking.price || 0), request });
    const res = await axios.post('https://api.paystack.co/transaction/initialize', {
      email,
      amount: amountInKobo,
      metadata: { bookingId: booking._id, customerCoords: request.body?.customerCoords },
      callback_url: callbackUrl,
      ...split.params,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const init = res?.data?.data;
    if (init) {
      await Transaction.create({
        bookingId: booking._id,
        payerId: request.user?.id || booking.customerId?._id || null,
        amount: Number(booking.price) || 0,
        status: 'pending',
        paymentGatewayRef: init.reference,
        paystackSplit: split.enabled,
        paystackSubaccountCode: split.meta?.subaccountCode,
        paystackSplitBearer: split.meta?.bearer,
        paystackTransactionCharge: split.meta?.transactionCharge,
        paystackSplitMeta: split.meta,
        companyFee: split.meta?.companyFee,
        transferAmount: split.meta?.transferAmount,
      });
    }

    return reply.code(201).send({ success: true, data: { booking, payment: res.data.data } });
  } catch (err) {
    request.log?.error?.(err?.response?.data || err?.message || err);
    return reply.code(500).send({ success: false, message: 'Failed to initiate deferred payment' });
  }
}

export async function getBooking(request, reply) {
  try {
    const booking = await Booking.findById(request.params.id);
    if (!booking) return reply.code(404).send({ success: false, message: 'Not found' });
    return reply.send({ success: true, data: booking });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to get booking' });
  }
}

export async function cancelBooking(request, reply) {
  try {
    const booking = await Booking.findById(request.params.id).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Not found' });

    // Only allow customer or admin to cancel (basic check). You may expand role checks.
    if (request.user && String(request.user.id) !== String(booking.customerId._id)) {
      // allow cancellation by the customer only for now
      return reply.code(403).send({ success: false, message: 'Forbidden' });
    }

    // If payment exists in holding or pending state, attempt to mark refunded and optionally call gateway refund
    const tx = await Transaction.findOne({ bookingId: booking._id, status: { $in: ['holding', 'pending'] } });
    if (tx) {
      // Prevent duplicate refunds: if transaction already refunded or a refund id exists, stop.
      if (tx.status === 'refunded' || tx.refundId || tx.refundStatus === 'refunded') {
        return reply.send({ success: true, message: 'Refund already initiated or transaction already refunded', data: booking });
      }
      // mark refund requested first
      booking.refundStatus = 'requested';
      booking.status = 'cancelled';
      booking.paymentStatus = 'unpaid';
      await booking.save();

      // Try gateway refund if Paystack secret key available
      if (process.env.PAYSTACK_SECRET_KEY && tx.paymentGatewayRef) {
        try {
          // Paystack refund endpoint: POST https://api.paystack.co/refund
          // Body: { transaction: <reference> }  (optionally amount)
          const res = await axios.post('https://api.paystack.co/refund', { transaction: tx.paymentGatewayRef }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });
          // Paystack returns { status: true, message: '', data: { status: 'success', ... } }
          const ok = res?.data?.status === true && (res.data.data?.status === 'success' || res.data.data?.status === 'refunded');
          if (ok) {
            // persist refund id for idempotency and future checks
            tx.refundId = res.data.data?.id || res.data.data?.reference || res.data.data?.refund_id || tx.refundId;
            tx.refundStatus = 'refunded';
            tx.status = 'refunded';
            await tx.save();
            booking.refundStatus = 'refunded';
            // keep paymentStatus aligned with Booking schema ("unpaid" or "paid").
            booking.paymentStatus = 'unpaid';
            await booking.save();
            const scheduleStr = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
            await createNotification(request.server, booking.customerId._id, { type: 'refund', title: 'Refund processed', body: `${formatNotificationMoney(booking.price)} refund for ${booking.service || 'Service'} on ${scheduleStr} has been processed.`, data: { bookingId: booking._id } });
            return reply.send({ success: true, message: 'Cancelled and refund processed', data: booking, gateway: res.data });
          }
          // if gateway returned non-success, mark requested and notify
          request.log?.warn?.('refund not confirmed by gateway', res?.data);
          // store any refund id returned and mark requested for reconciliation
          tx.refundId = res.data.data?.id || res.data.data?.reference || res.data.data?.refund_id || tx.refundId;
          tx.refundStatus = tx.refundStatus || 'requested';
          await tx.save();
          const scheduleStr = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
          await createNotification(request.server, booking.customerId._id, { type: 'refund', title: 'Refund requested', body: `${formatNotificationMoney(booking.price)} refund for ${booking.service || 'Service'} on ${scheduleStr} has been requested. Processing may take 3 to 5 business days.`, data: { bookingId: booking._id } });
          return reply.send({ success: true, message: 'Cancelled; refund requested (gateway did not confirm)', data: booking, gateway: res.data });
        } catch (err) {
          request.log?.error?.('refund failed', err?.response?.data || err?.message);
          // store that a refund was requested for manual reconciliation
          tx.refundStatus = 'requested';
          await tx.save();
          const scheduleStr = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
          await createNotification(request.server, booking.customerId._id, { type: 'refund', title: 'Refund requested', body: `${formatNotificationMoney(booking.price)} refund for ${booking.service || 'Service'} on ${scheduleStr} is under review. We will update you within 48 hours.`, data: { bookingId: booking._id } });
          return reply.send({ success: true, message: 'Cancelled; refund requested (gateway attempt failed)', data: booking });
        }
      }

      // If no gateway configured, mark tx refunded locally and notify for reconciliation
      tx.status = 'refunded';
      tx.refundStatus = 'refunded';
      await tx.save();
      booking.refundStatus = 'refunded';
      booking.status = 'cancelled';
      booking.paymentStatus = 'unpaid';
      await booking.save();
      const scheduleStr = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
      await createNotification(request.server, booking.customerId._id, { type: 'refund', title: 'Refund processed', body: `${formatNotificationMoney(booking.price)} refund for ${booking.service || 'Service'} on ${scheduleStr} has been credited.`, data: { bookingId: booking._id } });
      return reply.send({ success: true, message: 'Cancelled and refund processed (internal)', data: booking });
    }

    // No holding transaction — just cancel
    booking.status = 'cancelled';
    await booking.save();
    return reply.send({ success: true, message: 'Cancelled', data: booking });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(400).send({ success: false, message: err.message });
  }
}

export async function artisanCancelBooking(request, reply) {
  try {
    const reason = request.body?.reason;
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return reply.code(400).send({ success: false, message: 'Cancellation reason is required' });
    }

    const booking = await Booking.findById(request.params.id).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });
    if (String(booking.artisanId._id) !== String(request.user?.id)) return reply.code(403).send({ success: false, message: 'Forbidden' });
    if (booking.paymentMode !== 'afterCompletion') return reply.code(400).send({ success: false, message: 'Artisan cancellation is only allowed for after-completion bookings' });
    if (booking.status === 'completed' || booking.paymentStatus === 'paid') return reply.code(400).send({ success: false, message: 'Cannot cancel a completed or already-paid booking' });
    if (booking.status === 'cancelled') return reply.code(400).send({ success: false, message: 'Booking is already cancelled' });

    const tx = await Transaction.findOne({ bookingId: booking._id, status: { $in: ['pending', 'holding'] } });
    if (tx) {
      tx.status = 'refunded';
      tx.refundStatus = 'refunded';
      await tx.save();
    }

    booking.status = 'cancelled';
    booking.paymentStatus = 'unpaid';
    booking.cancellationReason = reason.trim();
    booking.cancelledBy = 'artisan';
    await booking.save();

    try {
      const scheduleStr = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
      await createNotification(request.server, booking.customerId._id, {
        type: 'booking',
        title: 'Booking cancelled by artisan',
        body: `Your ${booking.service || 'service'} booking for ${formatNotificationMoney(booking.price)} on ${scheduleStr} was cancelled. Reason: ${booking.cancellationReason}. A full refund will be issued.`,
        data: { bookingId: booking._id }
      });
    } catch (e) {
      request.log?.warn?.('artisanCancelBooking: failed to notify customer', e?.message || e);
    }

    return reply.send({ success: true, message: 'Booking cancelled by artisan', data: booking });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(400).send({ success: false, message: err.message });
  }
}

export async function getRefundStatus(request, reply) {
  try {
    const booking = await Booking.findById(request.params.id);
    if (!booking) return reply.code(404).send({ success: false, message: 'Not found' });

    const tx = await Transaction.findOne({ bookingId: booking._id });
    if (!tx) return reply.code(404).send({ success: false, message: 'No transaction found for booking' });

    // if we have a refund id and Paystack configured, query gateway
    if (tx.refundId && process.env.PAYSTACK_SECRET_KEY) {
      try {
        const res = await axios.get(`https://api.paystack.co/refund/${tx.refundId}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
        // Optionally persist any status change
        const gatewayStatus = res?.data?.data?.status;
        if (gatewayStatus === 'success' || gatewayStatus === 'refunded') {
          tx.refundStatus = 'refunded';
          tx.status = 'refunded';
          await tx.save();
          booking.refundStatus = 'refunded';
          await booking.save();
        }
        return reply.send({ success: true, data: res.data });
      } catch (err) {
        request.log?.error?.('refund status query failed', err?.response?.data || err?.message);
        return reply.code(500).send({ success: false, message: 'Failed to query refund status' });
      }
    }

    // Fallback: return stored refund status
    return reply.send({ success: true, data: { refundId: tx.refundId || null, refundStatus: tx.refundStatus || 'none' } });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to fetch refund status' });
  }
}

export async function completeBooking(request, reply) {
  try {
    const booking = await Booking.findById(request.params.id).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Not found' });
    if (String(booking.customerId._id) !== String(request.user?.id)) return reply.code(403).send({ success: false, message: 'Forbidden' });
    if (booking.status === 'completed' || booking.status === 'closed') {
      if (booking.status === 'completed' && booking.paymentStatus === 'paid') {
        try {
          await ensureCompletedPaidBookingStats({ booking, request });
        } catch (e) {
          request.log?.warn?.('failed to ensure already-completed booking wallet stats', e?.message || e);
        }
      }
      return reply.send({ success: true, message: 'Booking already completed', data: booking });
    }
    if (!['in-progress', 'accepted'].includes(booking.status)) {
      return reply.code(400).send({
        success: false,
        message: `Booking cannot be completed from status: ${booking.status}`
      });
    }

    if (booking.paymentMode === 'afterCompletion') {
      const paidTx = await Transaction.findOne({
        bookingId: booking._id,
        status: { $in: ['holding', 'released', 'paid'] },
      });
      if (!paidTx) {
        return reply.code(400).send({
          success: false,
          message: 'Payment must be completed before marking this booking complete. Use POST /bookings/:id/pay-after-completion, then verify the Paystack payment.'
        });
      }
    }

    // mark booking completed when customer marks it complete
    booking.status = 'completed';
    booking.awaitingReview = true;
    await booking.save();

    // If payment has already been initialized but webhook/verification has not updated the transaction,
    // attempt to verify any pending Paystack transaction before release.
    let tx = await Transaction.findOne({
      bookingId: booking._id,
      status: { $in: ['holding', 'released', 'paid'] },
    }).sort({ createdAt: -1 });
    if (!tx && booking.paymentMode === 'afterCompletion' && process.env.PAYSTACK_SECRET_KEY) {
      const pendingTx = await Transaction.findOne({ bookingId: booking._id, status: 'pending', paymentGatewayRef: { $exists: true, $ne: null } });
      if (pendingTx) {
        try {
          const res = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(pendingTx.paymentGatewayRef)}`, {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
          });
          const success = res?.data?.status === true && ['success', 'paid'].includes((res.data.data?.status || '').toLowerCase());
          if (success) {
            pendingTx.status = 'holding';
            await pendingTx.save();
            tx = pendingTx;
          }
        } catch (e) {
          request.log?.warn?.('Failed to verify pending deferred payment on booking completion', e?.response?.data || e?.message || e);
        }
      }
    }

    // release payment if transaction in holding. For pay-after-service bookings,
    // the transaction may not exist yet; it will be released by payment verification/webhook.
    if (tx && (tx.status === 'holding' || tx.status === 'released') && !hasFinalizedPayout(tx) && !tx.transferRef) {
      let feePct = 0;
      try {
        const cfgVal = await getConfig('COMPANY_FEE_PCT');
        if (cfgVal !== null && !isNaN(Number(cfgVal))) feePct = Number(cfgVal);
        else request.log?.warn?.('COMPANY_FEE_PCT not set in DB; defaulting to 0');
      } catch (e) {
        request.log?.error?.('Failed to read COMPANY_FEE_PCT from config', e?.message || e);
      }
      const amount = Number(tx.amount || booking.price || 0);
      const fee = Math.round((amount * feePct) / 100 * 100) / 100;
      const payAmount = Math.round((amount - fee) * 100) / 100;
      tx.payerId = booking.customerId._id;
      tx.payeeId = booking.artisanId._id;
      tx.amount = amount;
      tx.companyFee = fee;
      tx.transferAmount = payAmount;
      tx.status = 'released';
      tx.releasedAt = tx.releasedAt || new Date();
      await tx.save();

      // Determine whether to auto-payout via Paystack or credit internal wallet
      const autoPayout = String(process.env.PAYSTACK_AUTO_PAYOUT || '').toLowerCase() === 'true';

      // If auto-payout is enabled and Paystack configured and artisan has recipient code, attempt transfer
      const artisanDoc = await Artisan.findOne({ userId: booking.artisanId._id });
      // Prefer recipient code stored on the artisan's wallet; fall back to artisan doc
      let wallet = await Wallet.findOne({ userId: booking.artisanId._id });
      if (!wallet) wallet = await Wallet.create({ userId: booking.artisanId._id });

      let recipientCode = wallet?.paystackRecipientCode || artisanDoc?.paystackRecipientCode || null;

      // If we have payoutDetails but no recipientCode, try to create a Paystack recipient (server-side)
      if (!recipientCode) recipientCode = await ensurePaystackRecipient({ wallet, artisanDoc, request });

      let transferResult = { attempted: false, finalized: false, succeeded: false };
      if (tx.paystackSplit) {
        transferResult = { attempted: false, finalized: true, succeeded: true, reason: 'paystack_split' };
        request.log?.info?.({
          bookingId: String(booking._id),
          transactionId: String(tx._id),
          subaccountCode: tx.paystackSubaccountCode,
          companyFee: tx.companyFee,
          transferAmount: tx.transferAmount,
        }, 'booking completion payout handled by paystack split');
      } else if (autoPayout && process.env.PAYSTACK_SECRET_KEY && recipientCode) {
        transferResult = await attemptPaystackTransfer({ tx, booking, payAmount, recipientCode, request });
      }

      // If not using auto-payout or auto-payout failed, credit internal artisan wallet
      if (transferResult.finalized && transferResult.succeeded) {
        await recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount });
        tx.status = 'paid';
        await tx.save();
      } else if (transferResult.inFlight) {
        await recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount });
      } else if (!autoPayout || !transferResult.attempted) {
        await creditArtisanWalletIfNeeded({ tx, wallet, payAmount });
      } else {
        request.log?.error?.({
          bookingId: String(booking._id),
          transactionId: String(tx._id),
          payAmount,
          transferResult,
          transferStatus: tx.transferStatus,
          transferFailureReason: tx.transferFailureReason || null,
        }, 'booking completion payout failed: bank transfer requires retry');
      }

      // Record company/platform commission and optionally credit company wallet
      try {
        const CompanyEarning = (await import('../models/CompanyEarning.js')).default;
        if (fee > 0) {
          try {
            await CompanyEarning.create({ transactionId: tx._id, bookingId: booking._id, amount: fee, note: 'Platform commission' });
          } catch (e) { request.log?.warn?.('failed to record company earning', e?.message || e); }

          if (process.env.COMPANY_USER_ID) {
            try {
              const companyUserId = process.env.COMPANY_USER_ID;
              let companyWallet = await Wallet.findOne({ userId: companyUserId });
              if (!companyWallet) companyWallet = await Wallet.create({ userId: companyUserId });
              companyWallet.balance = (companyWallet.balance || 0) + fee;
              companyWallet.totalEarned = (companyWallet.totalEarned || 0) + fee;
              companyWallet.lastUpdated = new Date();
              await companyWallet.save();
              // notify company/admin account if possible
              try { await createNotification(request.server, companyUserId, { type: 'commission', title: 'Commission received', body: `${formatNotificationMoney(fee)} commission received from ${booking.service || 'service'}.`, data: { bookingId: booking._id, amount: fee } }); } catch (e) { request.log?.warn?.('company notify failed', e?.message); }
            } catch (e) { request.log?.error?.('credit company wallet failed', e?.message || e); }
          }
        }
      } catch (e) {
        request.log?.error?.('company commission handling failed', e?.message || e);
      }
    }

    // increment artisan stats
    const artisan = await Artisan.findOne({ userId: booking.artisanId._id });
    if (artisan) {
      artisan.analytics.leads = (artisan.analytics.leads || 0) + 1;
      await artisan.save();
    }

    // notify parties and send email summaries
    try {
      const artisanEmail = booking.artisanId?.email;
      const customerEmail = booking.customerId?.email;
      const paidAmount = (tx && (tx.amount - tx.companyFee)) || null;
      const scheduleStr = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
      const payoutNotice = getPayoutNotificationState(tx);
      await createNotification(request.server, booking.artisanId._id, {
        type: 'job_complete',
        title: payoutNotice.artisanTitle,
        body: `${booking.service || 'Service'} completed. ${paidAmount !== null ? `Amount: ${formatNotificationMoney(paidAmount)}.` : ''} ${payoutNotice.artisanBodySuffix}`,
        data: { bookingId: booking._id, amount: paidAmount, sendEmail: true, email: artisanEmail, transferStatus: tx?.transferStatus, payoutStatus: tx?.status }
      });
      await createNotification(request.server, booking.customerId._id, {
        type: 'job_complete',
        title: payoutNotice.customerTitle,
        body: `${booking.service || 'Service'} for ${formatNotificationMoney(booking.price)} on ${scheduleStr} is complete. ${payoutNotice.customerBodySuffix} Please leave a review.`,
        data: { bookingId: booking._id, sendEmail: true, email: customerEmail, transferStatus: tx?.transferStatus, payoutStatus: tx?.status }
      });
    } catch (e) {
      request.log?.warn?.('notify parties failed', e?.message || e);
    }

    // close chat if present
    try {
      if (booking.chatId) {
        const chat = await Chat.findById(booking.chatId);
        if (chat) {
          chat.isClosed = true;
          await chat.save();
        }
      }
    } catch (e) {
      request.log?.warn?.('failed to close chat', e?.message || e);
    }

    // update customer wallet stats (totalSpent) for bookkeeping
    try {
      if (tx) {
        let customerWallet = await Wallet.findOne({ userId: booking.customerId._id });
        if (!customerWallet) customerWallet = await Wallet.create({ userId: booking.customerId._id });
        await recordCustomerSpendStatsIfNeeded({ tx, wallet: customerWallet, amount: Number(tx.amount || 0) });
      }
    } catch (e) {
      request.log?.warn?.('failed to update customer wallet', e?.message || e);
    }

    // ensure booking reflects payment/closure state and prompt for review
    try {
      if (tx) {
        booking.paymentStatus = 'paid';
      }
      booking.awaitingReview = true;
      await booking.save();
    } catch (e) {
      request.log?.warn?.('failed to finalize booking state', e?.message || e);
    }

    return reply.send({ success: true, data: booking });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to complete booking' });
  }
}

// Endpoint to confirm payment for a booking (used by webhook or admin)
export async function confirmPayment(request, reply) {
  try {
    const bookingId = request.params.id;
    const booking = await Booking.findById(bookingId).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Not found' });

    // find most recent pending transaction for this booking
    const tx = await Transaction.findOne({ bookingId: booking._id, status: { $in: ['pending'] } }).sort({ createdAt: -1 });
    if (!tx) return reply.code(404).send({ success: false, message: 'No pending transaction found' });

    // mark as holding (app holds the payment)
    tx.status = 'holding';
    await tx.save();

    booking.paymentStatus = 'paid';
    // Set status to awaiting-acceptance (artisan must accept)
    booking.status = 'awaiting-acceptance';
    await booking.save();

    // notify artisan that payment was received and needs their acceptance
    try {
      const customerName = booking.customerId?.name || 'Customer';
      const scheduleStr = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
      await createNotification(request.server, booking.artisanId._id, { 
        type: 'booking', 
        title: 'New booking awaiting acceptance', 
        body: `${booking.service || 'Service'} for ${formatNotificationMoney(booking.price)} on ${scheduleStr} from ${customerName}. Payment received. Please accept or reject within 24 hours.`, 
        data: { bookingId: booking._id } 
      }); 
    } catch (e) { 
      request.log?.warn?.('notify failed', e?.message); 
    }

    return reply.send({ success: true, data: { booking, transaction: tx } });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to confirm payment' });
  }
}

// Artisan accepts a booking
export async function acceptBooking(request, reply) {
  try {
    const booking = await Booking.findById(request.params.id).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });

    // Only the artisan can accept their own booking
    if (String(booking.artisanId._id) !== String(request.user?.id)) {
      return reply.code(403).send({ success: false, message: 'Only the assigned artisan can accept this booking' });
    }

    // Check if booking is in correct state
    if (booking.status !== 'awaiting-acceptance') {
      return reply.code(400).send({ success: false, message: `Cannot accept booking with status: ${booking.status}` });
    }

    // Check if payment is confirmed for upfront bookings
    if (booking.paymentMode !== 'afterCompletion' && booking.paymentStatus !== 'paid') {
      return reply.code(400).send({ success: false, message: 'Payment not confirmed yet' });
    }

    // Update booking
    booking.status = 'accepted';
    booking.artisanApprovalStatus = 'accepted';
    booking.artisanApprovalDate = new Date();
    await booking.save();

    // Notify customer
    try {
      const artisanName = booking.artisanId?.name || 'The artisan';
      const scheduleStr = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
      await createNotification(request.server, booking.customerId._id, {
        type: 'booking',
        title: 'Booking accepted',
        body: `${artisanName} accepted your ${booking.service || 'service'} booking for ${formatNotificationMoney(booking.price)}. Work starts on ${scheduleStr}.`,
        data: { bookingId: booking._id }
      });
    } catch (e) {
      request.log?.warn?.('notify customer failed', e?.message);
    }

    return reply.send({ success: true, message: 'Booking accepted', data: booking });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to accept booking' });
  }
}

// Artisan rejects a booking
export async function rejectBooking(request, reply) {
  try {
    const { reason } = request.body || {};
    const booking = await Booking.findById(request.params.id).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });

    // Only the artisan can reject their own booking
    if (String(booking.artisanId._id) !== String(request.user?.id)) {
      return reply.code(403).send({ success: false, message: 'Only the assigned artisan can reject this booking' });
    }

    // Check if booking is in correct state
    if (booking.status !== 'awaiting-acceptance') {
      return reply.code(400).send({ success: false, message: `Cannot reject booking with status: ${booking.status}` });
    }

    // Update booking
    booking.status = 'cancelled';
    booking.artisanApprovalStatus = 'rejected';
    booking.artisanApprovalDate = new Date();
    booking.rejectionReason = reason || 'Artisan declined the booking';
    booking.refundStatus = 'requested';
    await booking.save();

    // Process refund if payment was made
    if (booking.paymentStatus === 'paid') {
      const tx = await Transaction.findOne({ bookingId: booking._id, status: 'holding' });
      if (tx) {
        // Try to refund via Paystack
        if (process.env.PAYSTACK_SECRET_KEY && tx.paymentGatewayRef) {
          try {
            const res = await axios.post('https://api.paystack.co/refund', 
              { transaction: tx.paymentGatewayRef }, 
              { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
            );
            
            const ok = res?.data?.status === true;
            if (ok) {
              tx.refundId = res.data.data?.id || res.data.data?.reference;
              tx.refundStatus = 'refunded';
              tx.status = 'refunded';
              await tx.save();
              booking.refundStatus = 'refunded';
              await booking.save();
            }
          } catch (refundErr) {
            request.log?.warn?.('refund failed', refundErr?.response?.data || refundErr?.message);
          }
        }
      }
    }

    // Notify customer
    try {
      const artisanName = booking.artisanId?.name || 'The artisan';
      const scheduleStr = booking.schedule ? formatNotificationDate(booking.schedule) : 'TBD';
      await createNotification(request.server, booking.customerId._id, {
        type: 'booking',
        title: 'Booking declined',
        body: `${artisanName} declined your ${booking.service || 'service'} booking for ${formatNotificationMoney(booking.price)} on ${scheduleStr}. Reason: ${booking.rejectionReason}. ${booking.refundStatus === 'refunded' ? 'Your refund has been processed.' : 'Your refund will be processed within 3 to 5 business days.'}`,
        data: { bookingId: booking._id, reason: booking.rejectionReason }
      });
    } catch (e) {
      request.log?.warn?.('notify customer failed', e?.message);
    }

    return reply.send({ 
      success: true, 
      message: 'Booking rejected', 
      data: booking 
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to reject booking' });
  }
}
