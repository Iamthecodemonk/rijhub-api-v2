import mongoose from 'mongoose';
import axios from 'axios';

const FINAL_TRANSFER_STATUSES = new Set(['success', 'processed', 'completed']);
const IN_FLIGHT_TRANSFER_STATUSES = new Set(['pending', 'processing', 'queued']);

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
    return {
      artisanTitle: 'Job completed - payout processing',
      artisanBodySuffix: 'Your payout is processing and will be confirmed shortly.',
      customerTitle: 'Job completed - payout processing',
      customerBodySuffix: 'The artisan payout is processing.',
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
  if (!process.env.PAYSTACK_SECRET_KEY) return null;
  if (!wallet?.payoutDetails?.account_number || !wallet?.payoutDetails?.bank_code || !wallet?.payoutDetails?.name) return null;

  try {
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

    return pData.recipient_code;
  } catch (e) {
    request.log?.error?.('create paystack recipient failed', e?.response?.data || e?.message || e);
    return null;
  }
}

export async function attemptPaystackTransfer({ tx, booking, payAmount, recipientCode, request }) {
  if (!process.env.PAYSTACK_SECRET_KEY || !recipientCode) {
    return { attempted: false, finalized: false, succeeded: false, reason: 'not_configured' };
  }

  if (tx.transferRef || tx.transferStatus === 'success') {
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
    const tRes = await axios.post('https://api.paystack.co/transfer', {
      source: 'balance',
      amount: amountKobo,
      recipient: recipientCode,
      reason: `Payout for booking ${booking._id}`
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });

    if (tRes?.data?.status !== true) {
      tx.transferStatus = 'failed';
      await tx.save();
      return { attempted: true, finalized: false, succeeded: false, reason: 'transfer_rejected' };
    }

    const transferData = tRes.data.data || {};
    const rawStatus = String(transferData.status || 'pending').toLowerCase();
    tx.transferRef = transferData.transfer_code || transferData.reference || transferData.id;
    tx.transferAmount = payAmount;
    tx.transferStatus = rawStatus;
    await tx.save();

    return {
      attempted: true,
      finalized: FINAL_TRANSFER_STATUSES.has(rawStatus),
      succeeded: FINAL_TRANSFER_STATUSES.has(rawStatus),
      inFlight: IN_FLIGHT_TRANSFER_STATUSES.has(rawStatus),
      reason: rawStatus
    };
  } catch (e) {
    request.log?.error?.('auto payout failed', e?.response?.data || e?.message || e);
    tx.transferStatus = tx.transferStatus === 'success' ? 'success' : 'failed';
    await tx.save();
    return { attempted: true, finalized: false, succeeded: false, reason: 'transfer_error' };
  }
}

export async function creditArtisanWalletIfNeeded({ tx, wallet, payAmount }) {
  if (tx.internalWalletCreditedAt) return false;
  const session = await mongoose.startSession();

  try {
    let credited = false;

    await session.withTransaction(async () => {
      const freshTx = await tx.constructor.findById(tx._id).session(session);
      if (!freshTx || freshTx.internalWalletCreditedAt) return;

      const freshWallet = await wallet.constructor.findById(wallet._id).session(session);
      if (!freshWallet) throw new Error('Wallet not found during payout credit');

      freshWallet.balance = (freshWallet.balance || 0) + payAmount;
      if (!freshTx.artisanStatsCreditedAt) {
        freshWallet.totalEarned = (freshWallet.totalEarned || 0) + payAmount;
        freshWallet.totalJobs = (freshWallet.totalJobs || 0) + 1;
        freshTx.artisanStatsCreditedAt = new Date();
      }
      freshWallet.lastUpdated = new Date();
      await freshWallet.save({ session });

      freshTx.internalWalletCreditedAt = new Date();
      freshTx.status = 'paid';
      await freshTx.save({ session });

      tx.internalWalletCreditedAt = freshTx.internalWalletCreditedAt;
      tx.artisanStatsCreditedAt = freshTx.artisanStatsCreditedAt;
      tx.status = freshTx.status;
      wallet.balance = freshWallet.balance;
      wallet.totalEarned = freshWallet.totalEarned;
      wallet.totalJobs = freshWallet.totalJobs;
      wallet.lastUpdated = freshWallet.lastUpdated;
      credited = true;
    });

    return credited;
  } finally {
    await session.endSession();
  }
}

export async function recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount }) {
  if (!tx || tx.artisanStatsCreditedAt) return false;
  const session = await mongoose.startSession();

  try {
    let credited = false;

    await session.withTransaction(async () => {
      const freshTx = await tx.constructor.findById(tx._id).session(session);
      if (!freshTx || freshTx.artisanStatsCreditedAt) return;

      const freshWallet = await wallet.constructor.findById(wallet._id).session(session);
      if (!freshWallet) throw new Error('Wallet not found during payout stats update');

      freshWallet.totalEarned = (freshWallet.totalEarned || 0) + payAmount;
      freshWallet.totalJobs = (freshWallet.totalJobs || 0) + 1;
      freshWallet.lastUpdated = new Date();
      await freshWallet.save({ session });

      freshTx.artisanStatsCreditedAt = new Date();
      await freshTx.save({ session });

      tx.artisanStatsCreditedAt = freshTx.artisanStatsCreditedAt;
      wallet.totalEarned = freshWallet.totalEarned;
      wallet.totalJobs = freshWallet.totalJobs;
      wallet.lastUpdated = freshWallet.lastUpdated;
      credited = true;
    });

    return credited;
  } finally {
    await session.endSession();
  }
}

export async function recordCustomerSpendStatsIfNeeded({ tx, wallet, amount }) {
  if (!tx || tx.customerStatsCreditedAt) return false;
  const session = await mongoose.startSession();

  try {
    let credited = false;

    await session.withTransaction(async () => {
      const freshTx = await tx.constructor.findById(tx._id).session(session);
      if (!freshTx || freshTx.customerStatsCreditedAt) return;

      const freshWallet = await wallet.constructor.findById(wallet._id).session(session);
      if (!freshWallet) throw new Error('Wallet not found during customer spend stats update');

      freshWallet.totalSpent = (freshWallet.totalSpent || 0) + amount;
      freshWallet.totalJobs = (freshWallet.totalJobs || 0) + 1;
      freshWallet.lastUpdated = new Date();
      await freshWallet.save({ session });

      freshTx.customerStatsCreditedAt = new Date();
      await freshTx.save({ session });

      tx.customerStatsCreditedAt = freshTx.customerStatsCreditedAt;
      wallet.totalSpent = freshWallet.totalSpent;
      wallet.totalJobs = freshWallet.totalJobs;
      wallet.lastUpdated = freshWallet.lastUpdated;
      credited = true;
    });

    return credited;
  } finally {
    await session.endSession();
  }
}
