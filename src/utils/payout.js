import axios from 'axios';

const FINAL_TRANSFER_STATUSES = new Set(['success', 'processed', 'completed']);
const IN_FLIGHT_TRANSFER_STATUSES = new Set(['pending', 'processing', 'queued', 'otp']);

function maskCode(value) {
  if (!value) return null;
  const raw = String(value);
  if (raw.length <= 10) return raw;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

export function getPaystackMaxAmountKobo() {
  const raw = process.env.PAYSTACK_MAX_AMOUNT_KOBO;
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function hasFinalizedPayout(tx) {
  return !!(tx && (tx.status === 'paid' || tx.transferStatus === 'success' || tx.internalWalletCreditedAt));
}

export function getPayoutNotificationState(tx) {
  const transferStatus = String(tx?.transferStatus || '').toLowerCase();

  if (tx?.internalWalletCreditedAt) {
    return {
      artisanTitle: 'Job completed - wallet credited',
      artisanBodySuffix: 'Your earnings were credited to your wallet.',
      customerTitle: 'Job completed - payment received',
      customerBodySuffix: 'The artisan has been credited successfully.',
    };
  }

  if (FINAL_TRANSFER_STATUSES.has(transferStatus)) {
    return {
      artisanTitle: 'Job completed - payout completed',
      artisanBodySuffix: 'Your payout has been completed successfully.',
      customerTitle: 'Job completed - payment received',
      customerBodySuffix: 'The artisan has been paid successfully.',
    };
  }

  if (IN_FLIGHT_TRANSFER_STATUSES.has(transferStatus)) {
    const artisanBodySuffix = transferStatus === 'otp'
      ? 'Your payout is waiting for Paystack transfer authorization.'
      : 'Your payout is processing and will be confirmed shortly.';
    const customerBodySuffix = transferStatus === 'otp'
      ? 'The artisan payout is waiting for transfer authorization.'
      : 'The artisan payout is processing.';
    return {
      artisanTitle: 'Job completed - payout processing',
      artisanBodySuffix,
      customerTitle: 'Job completed - payout processing',
      customerBodySuffix,
    };
  }

  return {
    artisanTitle: 'Job completed - payment released',
    artisanBodySuffix: 'Payment has been released for processing.',
    customerTitle: 'Job completed - payment received',
    customerBodySuffix: 'Payment has been received and is being processed for the artisan.',
  };
}

export async function ensurePaystackRecipient({ wallet, artisanDoc, request }) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    request.log?.warn?.({
      userId: wallet?.userId ? String(wallet.userId) : null,
    }, 'paystack recipient skipped: missing secret key');
    return null;
  }
  if (!wallet?.payoutDetails?.account_number || !wallet?.payoutDetails?.bank_code || !wallet?.payoutDetails?.name) {
    request.log?.warn?.({
      userId: wallet?.userId ? String(wallet.userId) : null,
      hasAccountNumber: !!wallet?.payoutDetails?.account_number,
      hasBankCode: !!wallet?.payoutDetails?.bank_code,
      hasName: !!wallet?.payoutDetails?.name,
    }, 'paystack recipient skipped: incomplete payout details');
    return null;
  }

  try {
    request.log?.info?.({
      userId: wallet?.userId ? String(wallet.userId) : null,
      bankCode: wallet.payoutDetails.bank_code,
      accountLast4: String(wallet.payoutDetails.account_number).slice(-4),
    }, 'paystack recipient creating');

    const pr = await axios.post('https://api.paystack.co/transferrecipient', {
      type: 'nuban',
      name: wallet.payoutDetails.name,
      account_number: wallet.payoutDetails.account_number,
      bank_code: wallet.payoutDetails.bank_code,
      currency: wallet.payoutDetails.currency || 'NGN'
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });

    const responseOk = pr?.data?.status === true;
    const pData = pr?.data?.data;
    if (!responseOk || !pData?.recipient_code) {
      request.log?.warn?.('paystack recipient creation returned no recipient code', pr?.data || null);
      return null;
    }

    wallet.paystackRecipientCode = pData.recipient_code;
    wallet.paystackRecipientMeta = pData;
    await wallet.save();

    if (artisanDoc) {
      try {
        artisanDoc.paystackRecipientCode = pData.recipient_code;
        artisanDoc.paystackRecipientMeta = pData;
        await artisanDoc.save();
      } catch (e) {
        request.log?.warn?.('failed to update artisan with recipient code', e?.message || e);
      }
    }

    request.log?.info?.({
      userId: wallet?.userId ? String(wallet.userId) : null,
      recipientCode: maskCode(pData.recipient_code),
      paystackRecipientId: pData.id,
    }, 'paystack recipient created');

    return pData.recipient_code;
  } catch (e) {
    request.log?.error?.({
      userId: wallet?.userId ? String(wallet.userId) : null,
      failure: e?.response?.data || { message: e?.message || String(e) },
    }, 'create paystack recipient failed');
    return null;
  }
}

export async function attemptPaystackTransfer({ tx, booking, payAmount, recipientCode, request }) {
  if (!process.env.PAYSTACK_SECRET_KEY || !recipientCode) {
    request.log?.warn?.({
      bookingId: booking?._id ? String(booking._id) : null,
      transactionId: tx?._id ? String(tx._id) : null,
      hasPaystackKey: !!process.env.PAYSTACK_SECRET_KEY,
      hasRecipientCode: !!recipientCode,
    }, 'paystack payout skipped: not configured');
    return { attempted: false, finalized: false, succeeded: false, reason: 'not_configured' };
  }

  if (tx.transferRef || tx.transferStatus === 'success') {
    request.log?.info?.({
      bookingId: booking?._id ? String(booking._id) : null,
      transactionId: tx?._id ? String(tx._id) : null,
      transferRef: tx.transferRef,
      transferStatus: tx.transferStatus,
    }, 'paystack payout skipped: already started');
    return { attempted: true, finalized: tx.transferStatus === 'success', succeeded: tx.transferStatus === 'success', reason: 'already_started' };
  }

  const amountKobo = Math.round(Number(payAmount || 0) * 100);
  const maxAmountKobo = getPaystackMaxAmountKobo();

  if (maxAmountKobo && amountKobo > maxAmountKobo) {
    request.log?.warn?.('auto payout skipped because amount exceeds PAYSTACK_MAX_AMOUNT_KOBO', {
      bookingId: booking?._id,
      transactionId: tx?._id,
      amountKobo,
      maxAmountKobo
    });
    tx.transferStatus = 'failed';
    await tx.save();
    return { attempted: false, finalized: false, succeeded: false, reason: 'amount_limit_exceeded' };
  }

  try {
    request.log?.info?.({
      bookingId: booking?._id ? String(booking._id) : null,
      transactionId: tx?._id ? String(tx._id) : null,
      amountKobo,
      recipientCode: maskCode(recipientCode),
    }, 'paystack payout initiating');

    const tRes = await axios.post('https://api.paystack.co/transfer', {
      source: 'balance',
      amount: amountKobo,
      recipient: recipientCode,
      reason: `Payout for booking ${booking._id}`
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });

    if (tRes?.data?.status !== true) {
      tx.transferStatus = 'failed';
      tx.transferFailureReason = tRes?.data?.message || tRes?.data?.error || 'transfer_rejected';
      tx.transferFailureMeta = tRes?.data || null;
      await tx.save();
      request.log?.warn?.({
        bookingId: booking?._id ? String(booking._id) : null,
        transactionId: tx?._id ? String(tx._id) : null,
        response: tRes?.data,
      }, 'paystack payout rejected');
      return { attempted: true, finalized: false, succeeded: false, reason: 'transfer_rejected' };
    }

    const transferData = tRes.data.data || {};
    const rawStatus = String(transferData.status || 'pending').toLowerCase();
    tx.transferRef = transferData.transfer_code || transferData.reference || transferData.id;
    tx.transferAmount = payAmount;
    tx.transferStatus = rawStatus;
    if (rawStatus === 'otp') {
      tx.transferFailureReason = 'paystack_transfer_requires_otp';
      tx.transferFailureMeta = tRes.data;
    } else {
      tx.transferFailureReason = undefined;
      tx.transferFailureMeta = undefined;
    }
    await tx.save();
    request.log?.info?.({
      bookingId: booking?._id ? String(booking._id) : null,
      transactionId: tx?._id ? String(tx._id) : null,
      transferRef: tx.transferRef,
      transferStatus: tx.transferStatus,
      transferAmount: tx.transferAmount,
      paystackTransferId: transferData.id,
      paystackResponse: transferData,
    }, 'paystack payout initiated');

    return {
      attempted: true,
      finalized: FINAL_TRANSFER_STATUSES.has(rawStatus),
      succeeded: FINAL_TRANSFER_STATUSES.has(rawStatus),
      inFlight: IN_FLIGHT_TRANSFER_STATUSES.has(rawStatus),
      reason: rawStatus
    };
  } catch (e) {
    const failure = e?.response?.data || { message: e?.message || String(e) };
    request.log?.error?.({ failure }, 'auto payout failed');
    tx.transferStatus = tx.transferStatus === 'success' ? 'success' : 'failed';
    if (tx.transferStatus !== 'success') {
      tx.transferFailureReason = failure?.message || failure?.error || e?.message || String(e);
      tx.transferFailureMeta = failure;
    }
    await tx.save();
    return { attempted: true, finalized: false, succeeded: false, reason: 'transfer_error' };
  }
}

export async function creditArtisanWalletIfNeeded({ tx, wallet, payAmount }) {
  if (tx.internalWalletCreditedAt) return false;
  const now = new Date();
  const marker = await tx.constructor.findOneAndUpdate(
    { _id: tx._id, $or: [{ internalWalletCreditedAt: { $exists: false } }, { internalWalletCreditedAt: null }] },
    { $set: { internalWalletCreditedAt: now, status: 'paid' } },
    { new: true }
  );
  if (!marker) return false;

  const statsMarker = await tx.constructor.updateOne(
    { _id: tx._id, $or: [{ artisanStatsCreditedAt: { $exists: false } }, { artisanStatsCreditedAt: null }] },
    { $set: { artisanStatsCreditedAt: now } }
  );
  const inc = { balance: payAmount };
  if (statsMarker.modifiedCount > 0) {
    inc.totalEarned = payAmount;
    inc.totalJobs = 1;
  }

  const updatedWallet = await wallet.constructor.findOneAndUpdate(
    { _id: wallet._id },
    { $inc: inc, $set: { lastUpdated: now } },
    { new: true }
  );

  tx.internalWalletCreditedAt = marker.internalWalletCreditedAt;
  tx.artisanStatsCreditedAt = marker.artisanStatsCreditedAt || (statsMarker.modifiedCount > 0 ? now : tx.artisanStatsCreditedAt);
  tx.status = marker.status;
  if (updatedWallet) {
    wallet.balance = updatedWallet.balance;
    wallet.totalEarned = updatedWallet.totalEarned;
    wallet.totalJobs = updatedWallet.totalJobs;
    wallet.lastUpdated = updatedWallet.lastUpdated;
  }
  return true;
}

export async function recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount }) {
  if (!tx || tx.artisanStatsCreditedAt) return false;
  const now = new Date();
  const marker = await tx.constructor.updateOne(
    { _id: tx._id, $or: [{ artisanStatsCreditedAt: { $exists: false } }, { artisanStatsCreditedAt: null }] },
    { $set: { artisanStatsCreditedAt: now } }
  );
  if (marker.modifiedCount <= 0) return false;

  const updatedWallet = await wallet.constructor.findOneAndUpdate(
    { _id: wallet._id },
    { $inc: { totalEarned: payAmount, totalJobs: 1 }, $set: { lastUpdated: now } },
    { new: true }
  );

  tx.artisanStatsCreditedAt = now;
  if (updatedWallet) {
    wallet.totalEarned = updatedWallet.totalEarned;
    wallet.totalJobs = updatedWallet.totalJobs;
    wallet.lastUpdated = updatedWallet.lastUpdated;
  }
  return true;
}

export async function recordCustomerSpendStatsIfNeeded({ tx, wallet, amount }) {
  if (!tx || tx.customerStatsCreditedAt) return false;
  const now = new Date();
  const marker = await tx.constructor.updateOne(
    { _id: tx._id, $or: [{ customerStatsCreditedAt: { $exists: false } }, { customerStatsCreditedAt: null }] },
    { $set: { customerStatsCreditedAt: now } }
  );
  if (marker.modifiedCount <= 0) return false;

  const updatedWallet = await wallet.constructor.findOneAndUpdate(
    { _id: wallet._id },
    { $inc: { totalSpent: amount, totalJobs: 1 }, $set: { lastUpdated: now } },
    { new: true }
  );

  tx.customerStatsCreditedAt = now;
  if (updatedWallet) {
    wallet.totalSpent = updatedWallet.totalSpent;
    wallet.totalJobs = updatedWallet.totalJobs;
    wallet.lastUpdated = updatedWallet.lastUpdated;
  }
  return true;
}
