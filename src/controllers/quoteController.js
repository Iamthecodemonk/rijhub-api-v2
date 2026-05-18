import Booking from '../models/Booking.js';
import Chat from '../models/Chat.js';
import Quote from '../models/Quote.js';
import { createNotification } from '../utils/notifier.js';
import axios from 'axios';
import Job from '../models/Job.js';
import { normalizePaymentMode } from '../utils/paymentMode.js';
import { getPaystackCallbackUrl } from '../utils/paystack.js';
import { buildPaystackSplitParams } from '../utils/paystackSplit.js';
const Artisan = (await import('../models/Artisan.js')).default;
const Transaction = (await import('../models/Transaction.js')).default;

// Customer posts requirements -> store as a chat message (create chat if missing)
export async function postRequirement(request, reply) {
  try {
    const bookingId = request.params.id;
    const { message } = request.body || {};
    if (!message) return reply.code(400).send({ success: false, message: 'message required' });

    const booking = await Booking.findById(bookingId).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });

    // ensure only customer can post requirement
    if (String(request.user?.id) !== String(booking.customerId?._id)) return reply.code(403).send({ success: false, message: 'Forbidden' });

    // ensure chat exists
    let chat = booking.chatId ? await Chat.findById(booking.chatId) : null;
    if (!chat) {
      chat = await Chat.create({ bookingId: booking._id, participants: [booking.customerId._id, booking.artisanId._id], messages: [] });
      booking.chatId = chat._id;
      await booking.save();
    }

    chat.messages.push({ senderId: request.user.id, message });
    await chat.save();

    // notify artisan
    await createNotification(request.server, booking.artisanId._id, { type: 'requirement', title: 'New requirement', body: 'Customer has added requirements for the job', data: { bookingId: booking._id } });

    return reply.code(201).send({ success: true, data: chat });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to post requirement' });
  }
}

// Artisan posts a quote for a booking
export async function createQuote(request, reply) {
  try {
    const bookingId = request.params.id;
    const { items = [], serviceCharge = 0, notes = '' } = request.body || {};
    const booking = await Booking.findById(bookingId).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });

    // only artisan assigned to booking can post quote
    if (String(request.user?.id) !== String(booking.artisanId?._id)) return reply.code(403).send({ success: false, message: 'Forbidden' });

    // compute total
    const itemsTotal = Array.isArray(items) ? items.reduce((s, it) => s + (Number(it.cost || 0) * Number(it.qty || 1)), 0) : 0;
    const total = Math.round((itemsTotal + Number(serviceCharge || 0)) * 100) / 100;

    const quote = await Quote.create({ bookingId, artisanId: booking.artisanId._id, customerId: booking.customerId._id, items, serviceCharge, notes, total, status: 'proposed' });

    // create chat if missing and inform customer
    let chat = booking.chatId ? await Chat.findById(booking.chatId) : null;
    if (!chat) {
      chat = await Chat.create({ bookingId: booking._id, participants: [booking.customerId._id, booking.artisanId._id], messages: [] });
      booking.chatId = chat._id;
      await booking.save();
    }

    const summary = `Quote proposed — total: ${quote.total}.`; 
    chat.messages.push({ senderId: request.user.id, message: summary });
    await chat.save();

    const bookingName = booking?.service || 'the booking';
    await createNotification(request.server, booking.customerId._id, { type: 'quote', title: 'New quote', body: `Artisan proposed a quote for ${bookingName}`, data: { bookingId: booking._id, quoteId: quote._id } });

    return reply.code(201).send({ success: true, data: quote });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to create quote' });
  }
}

// List quotes for a booking
export async function listQuotes(request, reply) {
  try {
    const bookingId = request.params.id;
    const quotes = await Quote.find({ bookingId }).sort({ createdAt: -1 });
    return reply.send({ success: true, data: quotes });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list quotes' });
  }
}

// List quotes with related artisan (user + artisan profile) and booking details
export async function listQuotesDetailed(request, reply) {
  try {
    const bookingId = request.params.id;
    const booking = await Booking.findById(bookingId).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });

    // fetch quotes and populate artisan user and customer user
    const quotes = await Quote.find({ bookingId }).sort({ createdAt: -1 }).populate('artisanId', 'name email profileImage').populate('customerId', 'name email profileImage').lean();

    // fetch artisan profile for each unique artisan user id
    const artisanUserIds = [...new Set(quotes.map(q => String(q.artisanId?._id || q.artisanId)))];
    const artisanProfiles = await Artisan.find({ userId: { $in: artisanUserIds } }).lean();
    const artisanMap = {};
    for (const a of artisanProfiles) artisanMap[String(a.userId)] = a;

    // attach artisanProfile and booking info to each quote
    const result = quotes.map(q => ({
      ...q,
      artisanUser: q.artisanId || null,
      artisanProfile: artisanMap[String(q.artisanId?._id || q.artisanId)] || null,
      booking: booking,
    }));

    return reply.send({ success: true, data: result });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list detailed quotes' });
  }
}

// Create a quote for a Job (not a Booking)
export async function createJobQuote(request, reply) {
  try {
    const jobId = request.params.id;
    const { items = [], serviceCharge = 0, notes = '' } = request.body || {};
    const jobQuery = Job.findByIdOrPublic(jobId);
    const job = (jobQuery && typeof jobQuery.populate === 'function') ? await jobQuery.populate('clientId') : await jobQuery;
    if (!job) return reply.code(404).send({ success: false, message: 'Job not found' });

    // only artisans can create job quotes (route preHandler should enforce role)
    const artisanUserId = request.user?.id;
    if (!artisanUserId) return reply.code(401).send({ success: false, message: 'Authentication required' });
    if (String(artisanUserId) === String(job.clientId?._id)) return reply.code(400).send({ success: false, message: 'Owner cannot quote own job' });

    // basic validation
    if (items && !Array.isArray(items)) return reply.code(400).send({ success: false, message: 'items must be an array' });

    // prevent duplicate active quotes by same artisan for the same job
    const existing = await Quote.findOne({ jobId, artisanId: artisanUserId, status: { $in: ['proposed', 'pending'] } });
    if (existing) return reply.code(409).send({ success: false, message: 'You already have an active quote for this job' });

    const itemsTotal = Array.isArray(items) ? items.reduce((s, it) => s + (Number(it.cost || 0) * Number(it.qty || 1)), 0) : 0;
    const total = Math.round((itemsTotal + Number(serviceCharge || 0)) * 100) / 100;

    const quote = await Quote.create({ jobId, artisanId: artisanUserId, customerId: job.clientId?._id, items, serviceCharge, notes, total, status: 'proposed' });

    // notify job owner (client)
    try {
      const jobName = job.title || 'the job';
      await createNotification(request.server, job.clientId?._id, { type: 'quote', title: 'New job quote', body: `An artisan proposed a quote for ${jobName}`, data: { jobId: job._id, quoteId: quote._id, jobName } });
    } catch (e) {
      request.log?.warn?.('notify job owner failed', e?.message || e);
    }

    return reply.code(201).send({ success: true, data: quote });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to create job quote' });
  }
}

// List quotes for a Job and include artisan user/profile
export async function listJobQuotes(request, reply) {
  try {
    const jobId = request.params.id;
    const jobQuery = Job.findByIdOrPublic(jobId);
    const job = (jobQuery && typeof jobQuery.populate === 'function') ? await jobQuery.populate('clientId') : await jobQuery;
    if (!job) return reply.code(404).send({ success: false, message: 'Job not found' });

    const quotes = await Quote.find({ jobId }).sort({ createdAt: -1 }).populate('artisanId', 'name email profileImage').lean();

    // fetch artisan profiles for the unique artisan user ids
    const artisanUserIds = [...new Set(quotes.map(q => String(q.artisanId?._id || q.artisanId)))].filter(Boolean);
    // const Artisan = (await import('../models/Artisan.js')).default;
    const artisanProfiles = await Artisan.find({ userId: { $in: artisanUserIds } }).lean();
    const artisanMap = {};
    for (const a of artisanProfiles) artisanMap[String(a.userId)] = a;

    // attach artisan user and artisan profile and job details to each quote
    const result = quotes.map(q => ({
      _id: q._id,
      job: job,
      quote: {
        items: q.items || [],
        serviceCharge: q.serviceCharge || 0,
        notes: q.notes || '',
        total: q.total || 0,
        status: q.status || 'proposed',
        createdAt: q.createdAt,
      },
      artisanUser: q.artisanId || null,
      artisanProfile: artisanMap[String(q.artisanId?._id || q.artisanId)] || null,
    }));

    return reply.send({ success: true, data: result });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list job quotes' });
  }
}

// Customer accepts a quote — updates quote status and booking.acceptedQuote
export async function acceptQuote(request, reply) {
  try {
    const { id: bookingId, quoteId } = request.params;
    const booking = await Booking.findById(bookingId).populate('customerId artisanId');
    if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });
    if (String(request.user?.id) !== String(booking.customerId?._id)) return reply.code(403).send({ success: false, message: 'Forbidden' });

    const quote = await Quote.findById(quoteId);
    if (!quote || String(quote.bookingId) !== String(bookingId)) return reply.code(404).send({ success: false, message: 'Quote not found' });

    const requestedPaymentMode = normalizePaymentMode(request.body?.paymentMode);
    if (typeof request.body?.paymentMode !== 'undefined' && requestedPaymentMode === null) {
      return reply.code(400).send({ success: false, message: 'Invalid paymentMode' });
    }

    // mark quote accepted and attach to booking
    quote.status = 'accepted';
    await quote.save();

    booking.acceptedQuote = quote._id;
    if (requestedPaymentMode) booking.paymentMode = requestedPaymentMode;
    booking.status = requestedPaymentMode === 'afterCompletion' ? 'awaiting-acceptance' : 'accepted';
    await booking.save();

    // notify artisan (include email notification when possible)
    const bookingName = booking?.service || 'the booking';
    await createNotification(request.server, booking.artisanId._id, { type: 'quote', title: 'Quote accepted', body: `Customer accepted your quote for ${bookingName}`, data: { bookingId: booking._id, quoteId: quote._id, sendEmail: true, email: booking.artisanId?.email } });

    // ensure chat exists and push message
    let chat = booking.chatId ? await Chat.findById(booking.chatId) : null;
    if (!chat) {
      chat = await Chat.create({ bookingId: booking._id, participants: [booking.customerId._id, booking.artisanId._id], messages: [] });
      booking.chatId = chat._id;
      await booking.save();
    }
    chat.messages.push({ senderId: request.user.id, message: `Customer accepted the quote. Proceed to payment.` });
    await chat.save();

    if (booking.paymentMode === 'afterCompletion') {
      return reply.code(200).send({ success: true, data: { quote, booking, payment: null, message: 'Booking accepted for pay-after-service payment. Pay before completion with /booking/:id/pay-after-completion.' } });
    }

    // Initialize payment for the accepted quote's serviceCharge (frontend should complete the payment)
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return reply.send({ success: true, data: { quote, booking, payment: null, message: 'Paystack not configured; please handle payment externally' } });
    }

    // use booking customer email if available
    const email = booking.customerId?.email || request.body?.email;
    if (!email) return reply.code(400).send({ success: false, message: 'Customer email required to initialize payment' });

    const amountInKobo = Math.round(Number(quote.serviceCharge || 0) * 100);
    try {
      const split = await buildPaystackSplitParams({ artisanUserId: booking.artisanId?._id || booking.artisanId, amount: Number(quote.serviceCharge || 0), request });
      const res = await axios.post('https://api.paystack.co/transaction/initialize', { email, amount: amountInKobo, metadata: { bookingId: booking._id, quoteId: quote._id }, callback_url: getPaystackCallbackUrl(), ...split.params }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });
      const init = res?.data?.data;
      if (init) {
        // persist a pending transaction for reconciliation
        // const Transaction = (await import('../models/Transaction.js')).default;
        await Transaction.create({ bookingId: booking._id, payerId: booking.customerId?._id || null, payeeId: booking.artisanId?._id || null, amount: quote.serviceCharge || 0, status: 'pending', paymentGatewayRef: init.reference, paystackSplit: split.enabled, paystackSubaccountCode: split.meta?.subaccountCode, paystackSplitBearer: split.meta?.bearer, paystackTransactionCharge: split.meta?.transactionCharge, paystackSplitMeta: split.meta, companyFee: split.meta?.companyFee, transferAmount: split.meta?.transferAmount });
      }
      return reply.code(201).send({ success: true, data: { quote, booking, payment: res.data.data } });
    } catch (e) {
      request.log?.error?.('initialize payment failed', e?.response?.data || e?.message || e);
      return reply.code(500).send({ success: false, message: 'Failed to initialize payment' });
    }
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to accept quote' });
  }
}

// Initialize payment for an accepted quote (convenience endpoint)
export async function payWithQuote(request, reply) {
  try {
    const bookingId = request.params.id;
    const booking = await Booking.findById(bookingId).populate('customerId artisanId acceptedQuote');
    if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });
    if (!booking.acceptedQuote) return reply.code(400).send({ success: false, message: 'No accepted quote to pay' });

    const quote = await Quote.findById(booking.acceptedQuote);
    if (!quote) return reply.code(404).send({ success: false, message: 'Quote not found' });

    if (booking.paymentMode === 'afterCompletion') {
      return reply.code(400).send({ success: false, message: 'Booking uses pay-after-service; payment should be made before marking the booking completed.' });
    }

    // use existing booking email or customer's email
    const email = booking.customerId?.email || request.body?.email;
    if (!email) return reply.code(400).send({ success: false, message: 'Email required to initialize payment' });

    if (!process.env.PAYSTACK_SECRET_KEY) return reply.code(500).send({ success: false, message: 'Paystack not configured' });

    // Only initialize payment for the serviceCharge — other costs are paid outside the platform
    const amountInKobo = Math.round(Number(quote.serviceCharge || 0) * 100);
    const split = await buildPaystackSplitParams({ artisanUserId: booking.artisanId?._id || booking.artisanId, amount: Number(quote.serviceCharge || 0), request });
    const res = await axios.post('https://api.paystack.co/transaction/initialize', { email, amount: amountInKobo, metadata: { bookingId, quoteId: quote._id }, callback_url: getPaystackCallbackUrl(), ...split.params }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });

    const init = res?.data?.data;
    if (init) {
      // persist a pending transaction for reconciliation
      // const Transaction = (await import('../models/Transaction.js')).default;
      await Transaction.create({ bookingId: booking._id, payerId: request.user?.id || null, amount: quote.serviceCharge || 0, status: 'pending', paymentGatewayRef: init.reference, paystackSplit: split.enabled, paystackSubaccountCode: split.meta?.subaccountCode, paystackSplitBearer: split.meta?.bearer, paystackTransactionCharge: split.meta?.transactionCharge, paystackSplitMeta: split.meta, companyFee: split.meta?.companyFee, transferAmount: split.meta?.transferAmount });
    }

    return reply.code(201).send({ success: true, data: { booking, payment: res.data.data } });
  } catch (err) {
    request.log?.error?.(err?.response?.data || err?.message || err);
    return reply.code(500).send({ success: false, message: 'Failed to initialize payment for quote' });
  }
}

// Accept a job-level quote: create a Booking from a Job quote and initialize payment
export async function acceptJobQuote(request, reply) {
  try {
    const jobId = request.params.id;
    const quoteId = request.params.quoteId;
    const quote = await Quote.findById(quoteId);
    if (!quote || String(quote.jobId) !== String(jobId)) return reply.code(404).send({ success: false, message: 'Quote not found' });

    const jobQuery = Job.findByIdOrPublic(jobId);
    const job = (jobQuery && typeof jobQuery.populate === 'function') ? await jobQuery.populate('clientId') : await jobQuery;
    if (!job) return reply.code(404).send({ success: false, message: 'Job not found' });

    // only job owner can accept
    if (String(request.user?.id) !== String(job.clientId?._id)) return reply.code(403).send({ success: false, message: 'Forbidden' });

    const requestedPaymentMode = normalizePaymentMode(request.body?.paymentMode) || 'upfront';
    if (typeof request.body?.paymentMode !== 'undefined' && requestedPaymentMode === null) {
      return reply.code(400).send({ success: false, message: 'Invalid paymentMode' });
    }

    // Guard: avoid duplicate booking creation if this quote already has one
    const existingBooking = await Booking.findOne({ acceptedQuote: quote._id });
    if (existingBooking) {
      if (!quote.bookingId) {
        quote.bookingId = existingBooking._id;
        await quote.save();
      }
      return reply.code(200).send({ success: true, data: { quote, booking: existingBooking, message: 'Booking already exists for this quote' } });
    }

    // mark quote accepted
    quote.status = 'accepted';
    await quote.save();

    if (requestedPaymentMode === 'afterCompletion') {
      const bookingPayload = {
        customerId: job.clientId?._id || job.clientId,
        artisanId: quote.artisanId,
        service: job.title || (Array.isArray(quote.items) && quote.items[0]?.name) || 'Job quote service',
        schedule: job.schedule || new Date(),
        price: quote.total || 0,
        status: 'awaiting-acceptance',
        paymentStatus: 'unpaid',
        paymentMode: 'afterCompletion',
        acceptedQuote: quote._id,
      };

      const booking = await Booking.create(bookingPayload);
      quote.bookingId = booking._id;
      await quote.save();

      job.status = 'closed';
      await job.save();

      let chat = null;
      try {
        chat = await Chat.create({ bookingId: booking._id, participants: [booking.customerId, booking.artisanId], messages: [] });
        booking.chatId = chat._id;
        await booking.save();
      } catch (e) {
        request.log?.warn?.('failed to create chat for deferred job quote booking', e?.message || e);
      }

      try {
        await createNotification(request.server, quote.artisanId, { type: 'quote', title: 'Quote accepted', body: `Customer accepted your quote for job "${job.title}". Booking created with deferred payment.`, data: { quoteId: quote._id, jobId: job._id, bookingId: booking._id, sendEmail: true, email: job.clientId?.email } });
      } catch (e) {
        request.log?.warn?.('notify hired artisan failed', e?.message || e);
      }

      return reply.code(200).send({ success: true, data: { quote, booking, payment: null, message: 'Booking created with pay-after-service payment; pay before completion using /booking/:id/pay-after-completion.' } });
    }

    // Do not close the job here; it will be closed after successful payment and booking creation.

    // Do NOT create a Booking here. Instead mark the quote accepted and initialize payment.
    // The Booking will be created after payment is confirmed (webhook), using metadata (quoteId, jobId).
    // notify artisan that their quote was accepted and payment is required
    try {
      const clientEmail = job.clientId?.email || null;
      await createNotification(request.server, quote.artisanId, { type: 'quote', title: 'Quote accepted — awaiting payment', body: `Customer accepted your quote for job "${job.title}". Please await payment confirmation.`, data: { quoteId: quote._id, jobId: job._id, sendEmail: true, email: clientEmail } });
    } catch (e) {
      request.log?.warn?.('notify hired artisan failed', e?.message || e);
    }

    // Initialize payment for the quote total (hold full amount)
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return reply.send({ success: true, data: { quote, payment: null, message: 'Paystack not configured; please handle payment externally' } });
    }

    const email = job.clientId?.email || request.body?.email;
    if (!email) return reply.code(400).send({ success: false, message: 'Customer email required to initialize payment' });

    const amountInKobo = Math.round(Number(quote.total || 0) * 100);
    try {
      const split = await buildPaystackSplitParams({ artisanUserId: quote.artisanId, amount: Number(quote.total || 0), request });
      const res = await axios.post('https://api.paystack.co/transaction/initialize', { email, amount: amountInKobo, metadata: { jobId: job._id, quoteId: quote._id }, callback_url: getPaystackCallbackUrl(), ...split.params }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });
      const init = res?.data?.data;
      if (init) {
        // create a transaction record referencing the quote (booking will be attached upon payment confirmation)
        await Transaction.create({ quoteId: quote._id, payerId: job.clientId?._id || null, payeeId: quote.artisanId || null, amount: quote.total || 0, status: 'pending', paymentGatewayRef: init.reference, paystackSplit: split.enabled, paystackSubaccountCode: split.meta?.subaccountCode, paystackSplitBearer: split.meta?.bearer, paystackTransactionCharge: split.meta?.transactionCharge, paystackSplitMeta: split.meta, companyFee: split.meta?.companyFee, transferAmount: split.meta?.transferAmount });
      }
      return reply.code(201).send({ success: true, data: { quote, payment: res.data.data } });
    } catch (e) {
      request.log?.error?.('initialize payment failed', e?.response?.data || e?.message || e);
      return reply.code(500).send({ success: false, message: 'Failed to initialize payment' });
    }
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to accept job quote' });
  }
}
