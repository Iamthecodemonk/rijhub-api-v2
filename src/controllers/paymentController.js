import Transaction from '../models/Transaction.js';
import Booking from '../models/Booking.js';
import Chat from '../models/Chat.js';
import Artisan from '../models/Artisan.js';
import Wallet from '../models/Wallet.js';
import Quote from '../models/Quote.js';
import Job from '../models/Job.js';
import SpecialServiceRequest from '../models/SpecialServiceRequest.js';
import { createNotification } from '../utils/notifier.js';
import { getConfig } from '../utils/config.js';
import { normalizePaymentMode } from '../utils/paymentMode.js';
import { attemptPaystackTransfer, creditArtisanWalletIfNeeded, ensurePaystackRecipient, getPayoutNotificationState, hasFinalizedPayout, recordArtisanPayoutStatsIfNeeded, recordCustomerSpendStatsIfNeeded } from '../utils/payout.js';
import { getPaystackCallbackUrl } from '../utils/paystack.js';
import { formatNotificationMoney } from '../utils/notificationText.js';
import crypto from 'crypto';
import axios from 'axios';

function markTransactionHoldingIfUnreleased(tx) {
  if (!tx || hasFinalizedPayout(tx) || tx.transferRef || tx.status === 'released') return;
  tx.status = 'holding';
}

async function releaseCompletedDeferredBookingPayment(booking, tx, request) {
  if (!booking || !tx) return;
  if (hasFinalizedPayout(tx) || tx.transferRef) return;
  if (tx.status !== 'holding' && tx.status !== 'released') return;
  const amount = Number(tx.amount || booking.price || 0);
  let feePct = 0;
  try {
    const cfgVal = await getConfig('COMPANY_FEE_PCT');
    if (cfgVal !== null && !isNaN(Number(cfgVal))) feePct = Number(cfgVal);
  } catch (e) {
    request.log?.warn?.('Failed to read COMPANY_FEE_PCT for payout', e?.message || e);
  }
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

  const artisanDoc = await Artisan.findOne({ userId: booking.artisanId._id });
  let wallet = await Wallet.findOne({ userId: booking.artisanId._id });
  if (!wallet) wallet = await Wallet.create({ userId: booking.artisanId._id });
  let recipientCode = wallet?.paystackRecipientCode || artisanDoc?.paystackRecipientCode || null;

  if (!recipientCode) recipientCode = await ensurePaystackRecipient({ wallet, artisanDoc, request });

  const autoPayout = String(process.env.PAYSTACK_AUTO_PAYOUT || '').toLowerCase() === 'true';
  let transferResult = { attempted: false, finalized: false, succeeded: false };
  if (String(process.env.PAYSTACK_AUTO_PAYOUT || '').toLowerCase() === 'true' && process.env.PAYSTACK_SECRET_KEY && recipientCode) {
    transferResult = await attemptPaystackTransfer({ tx, booking, payAmount, recipientCode, request });
  }

  if (transferResult.finalized && transferResult.succeeded) {
    await recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount });
    tx.status = 'paid';
    await tx.save();
  } else if (transferResult.inFlight) {
    await recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount });
  } else if (!autoPayout || !transferResult.attempted || (transferResult.attempted && !transferResult.succeeded && !transferResult.inFlight)) {
    await creditArtisanWalletIfNeeded({ tx, wallet, payAmount });
  }

  try {
    const CompanyEarning = (await import('../models/CompanyEarning.js')).default;
    if (fee > 0) {
      try {
        await CompanyEarning.create({ transactionId: tx._id, bookingId: booking._id, amount: fee, note: 'Platform commission' });
      } catch (e) { request.log?.warn?.('failed to record company earning for deferred completed booking', e?.message || e); }

      if (process.env.COMPANY_USER_ID) {
        try {
          const companyWallet = await Wallet.findOne({ userId: process.env.COMPANY_USER_ID }) || await Wallet.create({ userId: process.env.COMPANY_USER_ID });
          companyWallet.balance = (companyWallet.balance || 0) + fee;
          companyWallet.totalEarned = (companyWallet.totalEarned || 0) + fee;
          companyWallet.lastUpdated = new Date();
          await companyWallet.save();
          const bookingNameForCompany = booking?.service || `booking`;
          await createNotification(request.server, process.env.COMPANY_USER_ID, { type: 'commission', title: 'Commission received', body: `${formatNotificationMoney(fee)} commission received for ${bookingNameForCompany}.`, data: { bookingId: booking._id, bookingName: bookingNameForCompany, amount: fee } });
        } catch (e) { request.log?.warn?.('credit company wallet failed for deferred completed booking', e?.message || e); }
      }
    }
  } catch (e) {
    request.log?.warn?.('company earning handling failed for deferred completed booking', e?.message || e);
  }

  try {
    if (booking.customerId?._id) {
      const customerWallet = await Wallet.findOne({ userId: booking.customerId._id }) || await Wallet.create({ userId: booking.customerId._id });
      await recordCustomerSpendStatsIfNeeded({ tx, wallet: customerWallet, amount });
    }
  } catch (e) {
    request.log?.warn?.('failed to update customer wallet for deferred completed booking', e?.message || e);
  }

  try {
    const bookingNameForJobComplete = booking?.service || 'your booking';
    const payoutNotice = getPayoutNotificationState(tx);
    await createNotification(request.server, booking.artisanId._id, { type: 'job_complete', title: payoutNotice.artisanTitle, body: `${bookingNameForJobComplete}: ${payoutNotice.artisanBodySuffix}`, data: { bookingId: booking._id, bookingName: bookingNameForJobComplete, amount: payAmount, transferStatus: tx.transferStatus, payoutStatus: tx.status } });
    await createNotification(request.server, booking.customerId._id, { type: 'job_complete', title: payoutNotice.customerTitle, body: `Payment for ${bookingNameForJobComplete} has been received. ${payoutNotice.customerBodySuffix}`, data: { bookingId: booking._id, bookingName: bookingNameForJobComplete, transferStatus: tx.transferStatus, payoutStatus: tx.status } });
  } catch (e) {
    request.log?.warn?.('notify parties failed for deferred completed booking', e?.message || e);
  }
}

// Get list of banks from Paystack (returns bank name and code)
export async function getPaystackBanks(request, reply) {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) return reply.code(500).send({ success: false, message: 'Paystack not configured' });
    const res = await axios.get('https://api.paystack.co/bank?currency=NGN', { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    return reply.send({ success: true, data: res.data.data });
  } catch (err) {
    request.log?.error?.('getPaystackBanks failed', err?.response?.data || err?.message || err);
    return reply.code(500).send({ success: false, message: 'Failed to fetch banks' });
  }
}

// Resolve account number and bank code to account name via Paystack
export async function resolvePaystackAccount(request, reply) {
  try {
    const { account_number, bank_code } = request.query || {};
    if (!account_number || !bank_code) return reply.code(400).send({ success: false, message: 'account_number and bank_code query params required' });
    if (!process.env.PAYSTACK_SECRET_KEY) return reply.code(500).send({ success: false, message: 'Paystack not configured' });
    const res = await axios.get(`https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    return reply.send({ success: true, data: res.data.data });
  } catch (err) {
    request.log?.error?.('resolvePaystackAccount failed', err?.response?.data || err?.message || err);
    const status = err?.response?.status || 500;
    return reply.code(status).send({ success: false, message: 'Failed to resolve account', error: err?.response?.data || err?.message });
  }
}

// Create a transaction record (payment intent or completed depending on your flow)
export async function createPayment(request, reply) {
  try {
    const payload = request.body || {};
    const tx = await Transaction.create(payload);
    return reply.code(201).send({ success: true, data: tx });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(400).send({ success: false, message: err.message });
  }
}

// initialize a Paystack transaction (server-side)
export async function initializePaystackTransaction(request, reply) {
  try {
    const { email, amount, bookingId, customerCoords } = request.body || {};
    if (!email || !amount) return reply.code(400).send({ success: false, message: 'email and amount required' });

    const amountInKobo = Math.round(Number(amount) * 100);
    const callbackUrl = getPaystackCallbackUrl();

    const res = await axios.post('https://api.paystack.co/transaction/initialize', {
      email,
      amount: amountInKobo,
      metadata: { bookingId, customerCoords },
      callback_url: callbackUrl
    }, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    // Persist an initial Transaction record so we can reconcile if webhook is missed
    const init = res?.data?.data;
    if (init) {
      // if authenticated, attach payerId
      const payerId = request.user?.id;
      await Transaction.create({ bookingId, payerId, amount: Number(amount) || 0, status: 'pending', paymentGatewayRef: init.reference });
    }

    return reply.send({ success: true, data: res.data.data });
  } catch (err) {
    request.log?.error?.(err?.response?.data || err?.message);
    return reply.code(500).send({ success: false, message: 'Failed to initialize Paystack transaction' });
  }
}

export async function paystackCallback(request, reply) {
  const reference = request.query?.reference || request.query?.trxref || '';
  const escapedReference = String(reference)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  return reply
    .type('text/html; charset=utf-8')
    .send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Payment received</title>
  </head>
  <body style="font-family: Arial, sans-serif; text-align: center; padding: 40px;">
    <h2>Payment received</h2>
    <p>You can return to the Rijhub app.</p>
    ${escapedReference ? `<p style="color:#666;font-size:14px;">Reference: ${escapedReference}</p>` : ''}
  </body>
</html>`);
}

export async function verifyPayment(request, reply) {
  try {
    const { reference } = request.body || {};
    if (!reference) return reply.code(400).send({ success: false, message: 'reference required' });

    // If Paystack configured, verify with gateway for authoritative result
    if (process.env.PAYSTACK_SECRET_KEY) {
      try {
        const res = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
        // Debug: log full gateway response for investigation
        request.log?.info?.({ reqId: request.id, reference, gatewayVerifyData: res?.data?.data }, 'paystack verify response');
        const success = res?.data?.status === true && (res.data.data?.status === 'success' || res.data.data?.status === 'paid');
        // Ensure we have a transaction record
        let tx = await Transaction.findOne({ paymentGatewayRef: reference });
        if (!tx) {
          // Attempt to locate bookingId from metadata via gateway data
          const bookingId = res.data.data?.metadata?.bookingId;
          tx = await Transaction.create({ bookingId, payerId: null, payeeId: null, amount: (res.data.data?.amount || 0) / 100, status: success ? 'holding' : 'pending', paymentGatewayRef: reference });
        }

        if (success) {
          // mark tx holding and perform booking/quote actions (idempotent)
          markTransactionHoldingIfUnreleased(tx);
          await tx.save();

          // Prefer explicit bookingId in metadata (direct-hire / booking-first flows)
          let bookingId = res.data.data?.metadata?.bookingId;
          let booking = null;

          if (bookingId) {
            booking = await Booking.findById(bookingId).populate('customerId artisanId');
          }

          // If no bookingId but we have quote metadata, create or reuse booking from quote
          const qId = res.data.data?.metadata?.quoteId || res.data.data?.metadata?.quote_id;
          // If no bookingId but we have specialRequestId metadata, create booking from special request
          const sReqId = res.data.data?.metadata?.specialRequestId || res.data.data?.metadata?.special_request_id;
          request.log?.info?.({ reqId: request.id, reference, bookingId: bookingId || null, quoteMeta: qId || null, specialRequestMeta: sReqId || null }, 'verifyPayment: parsed metadata');
          if (!booking && qId) {
            try {
              const quote = await Quote.findById(qId);
              if (quote) {
                // idempotent: reuse existing booking linked to this quote
                const existingBooking = await Booking.findOne({ acceptedQuote: quote._id });
                if (existingBooking) {
                  booking = existingBooking;
                  bookingId = String(existingBooking._id);
                } else {
                  const jobIdFromMeta = res.data.data?.metadata?.jobId || res.data.data?.metadata?.job_id;
                  const job = jobIdFromMeta ? await Job.findByIdOrPublic(jobIdFromMeta) : await Job.findByIdOrPublic(quote.jobId);
                  const customerId = quote.customerId || (job ? job.clientId : null);
                  const paymentMode = normalizePaymentMode(res.data.data?.metadata?.paymentMode || res.data.data?.metadata?.payment_mode);
                  const payload = {
                    customerId,
                    artisanId: quote.artisanId,
                    service: (job && job.title) || (Array.isArray(quote.items) && quote.items[0]?.name) || 'Service',
                    schedule: (job && job.schedule) || new Date(),
                    price: quote.total || 0,
                    status: 'accepted',
                    paymentStatus: 'paid',
                    paymentMode,
                    acceptedQuote: quote._id,
                  };
                  const created = await Booking.create(payload);
                  booking = created;
                  bookingId = String(created._id);
                  try { quote.bookingId = created._id; await quote.save(); } catch (e) { /* non-fatal */ }
                  // If this booking originated from a Job, mark that Job closed to prevent further applications
                  try {
                    const job = jobIdFromMeta ? await Job.findByIdOrPublic(jobIdFromMeta) : await Job.findByIdOrPublic(quote.jobId);
                    if (job) { job.status = 'closed'; await job.save(); }
                  } catch (e) {
                    request.log?.warn?.('verifyPayment: failed to update job status after creating booking', e?.message || e);
                  }
                }
                // attach tx to booking if possible
                const ref = res.data.data?.reference;
                if (ref) {
                  const tx2 = await Transaction.findOne({ paymentGatewayRef: ref });
                  if (tx2) { tx2.bookingId = booking._id; markTransactionHoldingIfUnreleased(tx2); await tx2.save(); }
                }
              }
            } catch (e) {
              request.log?.error?.('verifyPayment: failed to create booking from quote metadata', e?.message || e);
            }
          }
          // specialRequest flow: create booking from SpecialServiceRequest if provided (run regardless of quote metadata)
          if (!booking && sReqId) {
            try {
              const sreq = await SpecialServiceRequest.findById(sReqId).lean();
              request.log?.info?.({ reqId: request.id, sReqId, sreqExists: !!sreq }, 'verifyPayment: handling specialRequestId');
              if (sreq) {
                if (sreq.bookingId) {
                  booking = await Booking.findById(sreq.bookingId).populate('customerId artisanId');
                  bookingId = sreq.bookingId;
                  try {
                    await SpecialServiceRequest.findByIdAndUpdate(sReqId, { status: 'confirmed', updatedAt: new Date() });
                  } catch (e) { request.log?.warn?.({ reqId: request.id, sReqId }, 'verifyPayment: failed to mark special request confirmed for existing booking'); }
                } else {
                  const selectedPrice = res.data.data?.metadata?.selectedPrice || res.data.data?.metadata?.selected_price;
                  const price = selectedPrice || sreq.artisanReply?.quote || (Array.isArray(sreq.artisanReply?.options) && sreq.artisanReply.options[0]) || sreq.budget || 0;
                  const payload = {
                    customerId: sreq.clientId,
                    artisanId: sreq.artisanId,
                    service: sreq.title || 'Service',
                    schedule: sreq.date || new Date(),
                    price: Number(price) || 0,
                    status: 'accepted',
                    paymentStatus: 'paid',
                  };
                  request.log?.info?.({ reqId: request.id, sReqId, bookingPayload: payload }, 'verifyPayment: creating booking from specialRequest');
                  const created = await Booking.create(payload);
                  request.log?.info?.({ reqId: request.id, sReqId, createdBookingId: created._id }, 'verifyPayment: created booking from specialRequest');
                  booking = created;
                  bookingId = String(created._id);
                  try {
                    await SpecialServiceRequest.findByIdAndUpdate(sReqId, { bookingId: created._id, status: 'confirmed', updatedAt: new Date() });
                  } catch (e) {
                    request.log?.warn?.({ reqId: request.id, sReqId }, 'verifyPayment: failed to attach bookingId to special request', e?.message || e);
                  }
                  const ref = res.data.data?.reference;
                  if (ref) {
                    const tx2 = await Transaction.findOne({ paymentGatewayRef: ref });
                    if (tx2) { tx2.bookingId = created._id; markTransactionHoldingIfUnreleased(tx2); await tx2.save(); }
                  }
                }
              }
            } catch (e) {
              request.log?.error?.({ reqId: request.id, sReqId, err: e?.stack || e?.message || e }, 'verifyPayment: failed to create booking from specialRequest metadata');
            }
          }
          // }

          // If we have a booking (either direct-hire or created from quote), update it and notify
          if (booking) {
            try {
              // ensure booking is marked paid and chat exists
              booking.paymentStatus = 'paid';
              booking.status = booking.status === 'pending' ? 'awaiting-acceptance' : booking.status;
              await booking.save();

              tx.bookingId = booking._id;
              tx.payerId = booking.customerId?._id || booking.customerId || tx.payerId || null;
              tx.payeeId = booking.artisanId?._id || booking.artisanId || tx.payeeId || null;
              tx.amount = Number(booking.price || tx.amount || 0);
              markTransactionHoldingIfUnreleased(tx);
              await tx.save();

              if (!booking.chatId) {
                const chat = await Chat.create({ bookingId: booking._id, participants: [booking.customerId._id, booking.artisanId._id], messages: [] });
                booking.chatId = chat._id;
                await booking.save();
              }

              await releaseCompletedDeferredBookingPayment(booking, tx, request);

              const bookingName = booking?.service || 'your booking';
              await createNotification(request.server, booking.artisanId._id, { type: 'booking', title: 'New booking confirmed', body: `${bookingName} has been paid.`, data: { bookingId: booking._id, bookingName, chatId: booking.chatId, email: booking.artisanId?.email, sendEmail: true } });
            } catch (e) {
              request.log?.warn?.('verifyPayment: post-booking actions failed', e?.message || e);
            }
          }
        }

        return reply.send({ success: true, data: res.data });
      } catch (err) {
        request.log?.error?.('paystack verify failed', err?.response?.data || err?.message);
        // fallback: update local tx if present
        const tx = await Transaction.findOne({ paymentGatewayRef: reference });
        if (tx) {
          tx.status = 'pending';
          await tx.save();
          return reply.send({ success: true, data: tx });
        }
        return reply.code(500).send({ success: false, message: 'Failed to verify payment with gateway' });
      }
    }

    // If no gateway configured, just update local tx
    const { status = 'released' } = request.body || {};
    const tx = await Transaction.findOneAndUpdate({ paymentGatewayRef: reference }, { status }, { new: true });
    if (!tx) return reply.code(404).send({ success: false, message: 'Transaction not found' });
    return reply.send({ success: true, data: tx });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to verify payment' });
  }
}

export async function listPayments(request, reply) {
  try {
    const { page = 1, limit = 20 } = request.query || {};
    const payments = await Transaction.find()
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ createdAt: -1 });
    return reply.send({ success: true, data: payments });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list payments' });
  }
}

// webhook handler for payment gateway
export async function paymentWebhook(request, reply) {
  try {
    const payload = request.body || {};
    const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
    const paystackSig = request.headers['x-paystack-signature'] || request.headers['x-paystack-signature'.toLowerCase()];
    if (payload.event && webhookSecret) {
      if (!paystackSig) {
        request.log?.warn?.('Missing Paystack signature header');
        return reply.code(401).send({ success: false, message: 'Missing signature' });
      }
      const bodyString = request.rawBody || JSON.stringify(payload);
      const expected = crypto.createHmac('sha512', webhookSecret).update(bodyString).digest('hex');
      if (expected !== paystackSig) {
        request.log?.warn?.('Invalid Paystack signature');
        return reply.code(401).send({ success: false, message: 'Invalid signature' });
      }
    }

    // Support two payload shapes: direct webhook (bookingId present) or Paystack webhook (event/data)
    let bookingId = payload.bookingId;
    let status = payload.status;
    const gatewayRef = payload.gatewayRef || payload.data?.reference;
    const customerCoords = payload.customerCoords || payload.data?.metadata?.customerCoords;

    // If this is a Paystack webhook, payload.event indicates the event type
    if (payload.event) {
      // handle Paystack events
      if (payload.event === 'charge.success') {
        status = 'success';
        // Paystack places custom metadata under data.metadata
        bookingId = payload.data?.metadata?.bookingId || bookingId;
        // job/quote based payments may include quoteId/jobId instead of bookingId
        const qId = payload.data?.metadata?.quoteId || payload.data?.metadata?.quote_id;
        const jId = payload.data?.metadata?.jobId || payload.data?.metadata?.job_id;
        const sReqId = payload.data?.metadata?.specialRequestId || payload.data?.metadata?.special_request_id;
        if (!bookingId && qId) {
          // create a Booking now from the quote/job and attach bookingId
          try {
            const quote = await Quote.findById(qId);
            if (quote) {
              let booking = null;
              const job = jId ? await Job.findByIdOrPublic(jId) : await Job.findByIdOrPublic(quote.jobId);
              // idempotency: if a booking already exists for this quote, reuse it
              const existingBooking = await Booking.findOne({ acceptedQuote: quote._id });
              if (existingBooking) {
                bookingId = String(existingBooking._id);
                booking = existingBooking;
              } else {
                const customerId = quote.customerId || (job ? job.clientId : null);
                const paymentMode = normalizePaymentMode(payload.data?.metadata?.paymentMode || payload.data?.metadata?.payment_mode);
                const bookingPayload = {
                  customerId,
                  artisanId: quote.artisanId,
                  service: (job && job.title) || quote.items?.[0]?.name || 'Service',
                  schedule: (job && job.schedule) || new Date(),
                  price: quote.total || 0,
                  status: 'accepted',
                  paymentStatus: 'paid',
                  paymentMode,
                  acceptedQuote: quote._id,
                };
                booking = await Booking.create(bookingPayload);
                bookingId = String(booking._id);
                // If this booking originated from a Job, mark that Job closed to prevent further applications
                try {
                  if (job) {
                    job.status = 'closed';
                    await job.save();
                  }
                } catch (e) {
                  request.log?.warn?.('failed to update job status after creating booking', e?.message || e);
                }
              }
              // update quote to reference booking if desired
              try { if (booking?._id) { quote.bookingId = booking._id; await quote.save(); } } catch (e) { /* non-fatal */ }
              // update existing transaction (if any) to reference booking
              const ref = payload.data?.reference;
              if (ref) {
                const tx = await Transaction.findOne({ paymentGatewayRef: ref });
                if (tx) {
                  tx.bookingId = booking?._id || existingBooking?._id;
                  markTransactionHoldingIfUnreleased(tx);
                  await tx.save();
                }
              }
            }
          } catch (e) {
            request.log?.error?.('failed to create booking from quote metadata', e?.message || e);
          }
        }
        // specialRequest flow: create booking from special request metadata
        if (!bookingId && sReqId) {
          try {
            const sreq = await SpecialServiceRequest.findById(sReqId).lean();
            if (sreq) {
              if (sreq.bookingId) {
                bookingId = String(sreq.bookingId);
                try {
                  // mark special request as confirmed when an existing booking is found
                  await SpecialServiceRequest.findByIdAndUpdate(sReqId, { status: 'confirmed', updatedAt: new Date() });
                } catch (e) { /* non-fatal */ }
              } else {
                const selectedPrice = payload.data?.metadata?.selectedPrice || payload.data?.metadata?.selected_price;
                const price = selectedPrice || sreq.artisanReply?.quote || (Array.isArray(sreq.artisanReply?.options) && sreq.artisanReply.options[0]) || sreq.budget || 0;
                const paymentMode = normalizePaymentMode(payload.data?.metadata?.paymentMode || payload.data?.metadata?.payment_mode);
                const bookingPayload = {
                  customerId: sreq.clientId,
                  artisanId: sreq.artisanId,
                  service: sreq.title || 'Service',
                  schedule: sreq.date || new Date(),
                  price: Number(price) || 0,
                  status: 'accepted',
                  paymentStatus: 'paid',
                  paymentMode,
                };
                const created = await Booking.create(bookingPayload);
                bookingId = String(created._id);
                try { await SpecialServiceRequest.findByIdAndUpdate(sReqId, { bookingId: created._id, status: 'confirmed', updatedAt: new Date() }); } catch (e) { /* non-fatal */ }
                // attach tx if reference present
                const ref = payload.data?.reference;
                if (ref) {
                  const tx = await Transaction.findOne({ paymentGatewayRef: ref });
                  if (tx) { tx.bookingId = created._id; markTransactionHoldingIfUnreleased(tx); await tx.save(); }
                }
              }
            }
          } catch (e) {
            request.log?.error?.('failed to create booking from specialRequest metadata', e?.message || e);
          }
        }
      } else if (payload.event === 'transfer.success' || payload.event === 'transfer.processed' || payload.event === 'transfer.completed') {
        // Transfer webhook: update transaction transfer status
        const transferCode = payload.data?.transfer_code || payload.data?.reference || payload.data?.id;
        if (transferCode) {
          const tx = await Transaction.findOne({ transferRef: transferCode });
          if (tx) {
            if (!tx.payeeId && tx.bookingId) {
              const booking = await Booking.findById(tx.bookingId).select('artisanId');
              if (booking?.artisanId) tx.payeeId = booking.artisanId;
            }
            if (tx.payeeId) {
              const payAmount = Number(tx.transferAmount || (Number(tx.amount || 0) - Number(tx.companyFee || 0)) || 0);
              const wallet = await Wallet.findOne({ userId: tx.payeeId }) || await Wallet.create({ userId: tx.payeeId });
              await recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount });
            }
            tx.transferStatus = 'success';
            tx.status = 'paid';
            await tx.save();
            // notify artisan and company
            await createNotification(request.server, tx.payeeId, { type: 'payout', title: 'Payout completed', body: `Payout for booking ${tx.bookingId} completed.`, data: { bookingId: tx.bookingId } });
            if (process.env.COMPANY_USER_ID) await createNotification(request.server, process.env.COMPANY_USER_ID, { type: 'payout', title: 'Payout completed', body: `Payout for booking ${tx.bookingId} completed.`, data: { bookingId: tx.bookingId } });
          }
        }
        return reply.code(200).send({ success: true, message: 'Transfer handled' });
      } else if (payload.event === 'transfer.failed') {
        const transferCode = payload.data?.transfer_code || payload.data?.reference || payload.data?.id;
        if (transferCode) {
          const tx = await Transaction.findOne({ transferRef: transferCode });
          if (tx) {
            tx.transferStatus = 'failed';
            await tx.save();
            // notify artisan and admin for manual action
            await createNotification(request.server, tx.payeeId, { type: 'payout', title: 'Payout failed', body: `Payout for booking ${tx.bookingId} failed. Admin will follow up.`, data: { bookingId: tx.bookingId } });
            if (process.env.COMPANY_USER_ID) await createNotification(request.server, process.env.COMPANY_USER_ID, { type: 'payout', title: 'Payout failed', body: `Payout for booking ${tx.bookingId} failed.`, data: { bookingId: tx.bookingId } });
          }
        }
        return reply.code(200).send({ success: true, message: 'Transfer failure handled' });
      } else if (payload.event === 'charge.failed') {
        // payment failed — mark booking/tx appropriately and notify
        bookingId = payload.data?.metadata?.bookingId || bookingId;
        if (!bookingId) return reply.code(200).send({ success: true, message: 'No booking metadata' });
        const booking = await Booking.findById(bookingId).populate('customerId artisanId');
        if (booking) {
          booking.paymentStatus = 'failed';
          await booking.save();
          const tx = await Transaction.findOne({ paymentGatewayRef: payload.data?.reference });
          if (tx) {
            tx.status = 'failed';
            await tx.save();
          }
          // If this booking was created from a SpecialServiceRequest, clean it up
          try {
            const sreq = await SpecialServiceRequest.findOne({ bookingId: booking._id });
            if (sreq) {
              try {
                await Booking.findByIdAndDelete(booking._id);
              } catch (e) { request.log?.warn?.('failed to delete booking after failed payment', e?.message || e); }
              try { await SpecialServiceRequest.findByIdAndUpdate(sreq._id, { bookingId: undefined, status: 'accepted', updatedAt: new Date() }); } catch (e) { request.log?.warn?.('failed to clear bookingId on special request after failed payment', e?.message || e); }
              const sreqName = sreq.title || sreq.categoryName || 'special request';
              await createNotification(request.server, sreq.clientId, { type: 'payment', title: 'Payment failed', body: `Payment for your special request failed. Booking was removed. Please retry.`, data: { requestId: sreq._id, requestName: sreqName } });
              return reply.code(200).send({ success: true, message: 'Handled charge.failed and cleaned up special request booking' });
            }
          } catch (e) {
            request.log?.warn?.('failed to cleanup booking after charge.failed', e?.message || e);
          }

          const bookingName = booking?.service || 'your booking';
          await createNotification(request.server, booking.customerId._id, { type: 'payment', title: 'Payment failed', body: `Payment for ${bookingName} failed. Please retry.`, data: { bookingId: booking._id, bookingName } });
        }
        return reply.code(200).send({ success: true, message: 'Handled charge.failed' });
      } else {
        // unhandled paystack event
        return reply.code(200).send({ success: true, message: 'Event ignored' });
      }
    }

    const { bookingId: _b, status: _s, gatewayRef: _g, customerCoords: _c } = { bookingId, status, gatewayRef, customerCoords };
    if (!bookingId) return reply.code(400).send({ success: false, message: 'bookingId required' });

    // For now treat any 'success' or 'paid' status as succeeded
    if (['success', 'paid'].includes(((_s || _s) || '').toLowerCase())) {
      const booking = await Booking.findById(_b).populate('customerId artisanId');
      if (!booking) return reply.code(404).send({ success: false, message: 'Booking not found' });

      booking.paymentStatus = 'paid';
      // Do not auto-accept on payment; move to awaiting-acceptance so artisan can accept/reject.
      booking.status = booking.status === 'pending' ? 'awaiting-acceptance' : booking.status;
      await booking.save();

      // create chat if missing
      if (!booking.chatId) {
        const chat = await Chat.create({ bookingId: booking._id, participants: [booking.customerId._id, booking.artisanId._id], messages: [] });
        booking.chatId = chat._id;
        await booking.save();
      }

      // compute distance if coordinates provided and artisan has serviceArea.coordinates
      try {
        if (_c && booking.artisanId) {
          const aCoords = booking.artisanId.serviceArea?.coordinates;
          if (Array.isArray(aCoords) && aCoords.length >= 2) {
            const dist = haversineDistance({ lat: _c.lat, lon: _c.lon }, { lat: aCoords[1], lon: aCoords[0] });
            booking.distanceKm = dist;
            await booking.save();
          }
        }
      } catch (e) {
        request.log?.error?.('distance calc error', e?.message);
      }

      // create or reuse holding transaction to keep webhook redeliveries idempotent
      let tx = await Transaction.findOne({ paymentGatewayRef: _g });
      if (tx) {
        tx.bookingId = booking._id;
        tx.payerId = booking.customerId._id;
        tx.payeeId = booking.artisanId._id;
        tx.amount = booking.price || tx.amount || 0;
        markTransactionHoldingIfUnreleased(tx);
        await tx.save();
      } else {
        tx = await Transaction.create({ bookingId: booking._id, payerId: booking.customerId._id, payeeId: booking.artisanId._id, amount: booking.price || 0, status: 'holding', paymentGatewayRef: _g });
      }
      await releaseCompletedDeferredBookingPayment(booking, tx, request);

      // notify artisan
      const bookingName = booking?.service || 'your booking';
      await createNotification(request.server, booking.artisanId._id, { type: 'booking', title: 'New booking confirmed', body: `${bookingName} has been paid.`, data: { bookingId: booking._id, bookingName, chatId: booking.chatId, email: booking.artisanId.email, sendEmail: true } });

      return reply.send({ success: true, data: booking });
    }

    return reply.code(400).send({ success: false, message: 'Unhandled status' });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: err.message });
  }
}

// Admin: reconcile pending transactions (created for quotes) by verifying with Paystack
const reconcilePendingQuoteTransactions = async (request, reply) => {
  const { olderThanMinutes = 5 } = request.body || {};
  const cutoff = new Date(Date.now() - (Number(olderThanMinutes) || 5) * 60 * 1000);
  const pending = await Transaction.find({ status: 'pending', quoteId: { $exists: true }, createdAt: { $lt: cutoff } }).limit(200);
  const results = [];
  for (const tx of pending) {
    try {
      // verify with paystack using paymentGatewayRef OR reference
      const ref = tx.paymentGatewayRef || tx.reference;
      if (!ref) { results.push({ tx: tx._id, ok: false, reason: 'no-ref' }); continue; }
      const res = await axios.get(`https://api.paystack.co/transaction/verify/${ref}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
      const status = res?.data?.data?.status;
      if (status === 'success') {
        // simulate webhook flow: create booking if needed
        const metadata = res.data.data.metadata || {};
        const qId = metadata.quoteId || tx.quoteId;
        const jId = metadata.jobId || metadata.job || null;
        if (qId) {
          const quote = await Quote.findById(qId);
          if (!quote) { results.push({ tx: tx._id, ok: false, reason: 'quote-not-found' }); continue; }
          const existingBooking = await Booking.findOne({ acceptedQuote: quote._id });
          if (existingBooking) {
            tx.bookingId = existingBooking._id; markTransactionHoldingIfUnreleased(tx); await tx.save();
            results.push({ tx: tx._id, ok: true, booking: existingBooking._id, reused: true });
            continue;
          }
          const job = jId ? await Job.findByIdOrPublic(jId) : await Job.findByIdOrPublic(quote.jobId);
          const customerId = quote.customerId || (job ? job.clientId : null);
          const bookingPayload = { customerId, artisanId: quote.artisanId, service: (job && job.title) || quote.items?.[0]?.name || 'Service', schedule: (job && job.schedule) || new Date(), price: quote.total || 0, status: 'accepted', paymentStatus: 'paid', acceptedQuote: quote._id };
          const booking = await Booking.create(bookingPayload);
          // If this booking came from a Job, mark that Job closed to prevent further applications
          try {
            if (job) {
              job.status = 'closed';
              await job.save();
            }
          } catch (e) {
            // non-fatal
            request.log?.warn?.('reconcile: failed to update job status after creating booking', e?.message || e);
          }
          tx.bookingId = booking._id; markTransactionHoldingIfUnreleased(tx); tx.save().catch(() => { });
          results.push({ tx: tx._id, ok: true, booking: booking._id, created: true });
        } else {
          results.push({ tx: tx._id, ok: false, reason: 'no-quote-in-metadata' });
        }
      } else {
        results.push({ tx: tx._id, ok: false, reason: `paystack-${status}` });
      }
    } catch (err) {
      results.push({ tx: tx._id, ok: false, reason: err.message });
    }
  }
  reply.send({ processed: results.length, results });
};
export { reconcilePendingQuoteTransactions };
function haversineDistance(a, b) {
  const toRad = x => (x * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(sinDLat), Math.sqrt(1 - sinDLat));
  return Math.round(R * c * 100) / 100;
}
