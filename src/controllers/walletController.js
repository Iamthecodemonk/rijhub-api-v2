import Wallet from '../models/Wallet.js';
import Booking from '../models/Booking.js';
import Transaction from '../models/Transaction.js';
import { getConfig } from '../utils/config.js';

async function getCompanyFee(amount, tx) {
  if (tx?.companyFee !== undefined && tx?.companyFee !== null) return Number(tx.companyFee || 0);
  let feePct = 0;
  try {
    const cfgVal = await getConfig('COMPANY_FEE_PCT');
    if (cfgVal !== null && !isNaN(Number(cfgVal))) feePct = Number(cfgVal);
  } catch {
    feePct = 0;
  }
  return Math.round((amount * feePct) / 100 * 100) / 100;
}

async function ensureCompletedBookingWalletStats(userId, request) {
  if (!userId) return;

  const bookings = await Booking.find({
    paymentStatus: 'paid',
    status: 'completed',
    $or: [{ artisanId: userId }, { customerId: userId }],
  }).select('_id customerId artisanId price').lean();

  for (const booking of bookings) {
    const amount = Number(booking.price || 0);
    if (amount <= 0 || !booking.customerId || !booking.artisanId) continue;

    let tx = await Transaction.findOne({ bookingId: booking._id }).sort({ createdAt: -1 });
    const fee = await getCompanyFee(amount, tx);
    const payAmount = Math.round(Number(tx?.transferAmount || (amount - fee)) * 100) / 100;

    if (!tx) {
      tx = await Transaction.create({
        bookingId: booking._id,
        payerId: booking.customerId,
        payeeId: booking.artisanId,
        amount,
        companyFee: fee,
        transferAmount: payAmount,
        status: 'paid',
        releasedAt: new Date(),
      });
      request.log?.warn?.({ bookingId: String(booking._id), transactionId: String(tx._id) }, 'wallet reconciliation created missing transaction');
    } else {
      tx.payerId = tx.payerId || booking.customerId;
      tx.payeeId = tx.payeeId || booking.artisanId;
      tx.amount = Number(tx.amount || amount);
      tx.companyFee = Number(tx.companyFee || fee);
      tx.transferAmount = Number(tx.transferAmount || payAmount);
      if (tx.status === 'pending') tx.status = 'paid';
      await tx.save();
    }

    if (String(booking.artisanId) === String(userId)) {
      const marker = await Transaction.updateOne(
        { _id: tx._id, $or: [{ artisanStatsCreditedAt: { $exists: false } }, { artisanStatsCreditedAt: null }] },
        { $set: { artisanStatsCreditedAt: new Date() } }
      );
      if (marker.modifiedCount > 0) {
        await Wallet.updateOne(
          { userId: booking.artisanId },
          { $setOnInsert: { userId: booking.artisanId }, $inc: { totalEarned: payAmount, totalJobs: 1 }, $set: { lastUpdated: new Date() } },
          { upsert: true }
        );
      }
    }

    if (String(booking.customerId) === String(userId)) {
      const marker = await Transaction.updateOne(
        { _id: tx._id, $or: [{ customerStatsCreditedAt: { $exists: false } }, { customerStatsCreditedAt: null }] },
        { $set: { customerStatsCreditedAt: new Date() } }
      );
      if (marker.modifiedCount > 0) {
        await Wallet.updateOne(
          { userId: booking.customerId },
          { $setOnInsert: { userId: booking.customerId }, $inc: { totalSpent: amount, totalJobs: 1 }, $set: { lastUpdated: new Date() } },
          { upsert: true }
        );
      }
    }
  }
}

export async function getWallet(request, reply) {
  try {
    const userId = request.user?.id || request.query.userId;
    if (!userId) return reply.code(400).send({ success: false, message: 'userId required' });
    try {
      await ensureCompletedBookingWalletStats(userId, request);
    } catch (e) {
      request.log?.warn?.('wallet stat reconciliation failed', e?.message || e);
    }
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      wallet = await Wallet.create({ userId });
    }
    return reply.send({ success: true, data: wallet });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to get wallet' });
  }
}

export async function creditWallet(request, reply) {
  try {
    const { userId, amount } = request.body || {};
    if (!userId || typeof amount !== 'number') return reply.code(400).send({ success: false, message: 'userId and numeric amount required' });
    const wallet = await Wallet.findOneAndUpdate({ userId }, { $inc: { balance: amount, totalEarned: amount } }, { new: true, upsert: true });
    return reply.send({ success: true, data: wallet });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to credit wallet' });
  }
}

export async function debitWallet(request, reply) {
  try {
    const { userId, amount } = request.body || {};
    if (!userId || typeof amount !== 'number') return reply.code(400).send({ success: false, message: 'userId and numeric amount required' });
    const wallet = await Wallet.findOne({ userId });
    if (!wallet || wallet.balance < amount) return reply.code(400).send({ success: false, message: 'Insufficient balance' });
    wallet.balance -= amount;
    wallet.totalSpent = (wallet.totalSpent || 0) + amount;
    wallet.totalJobs = (wallet.totalJobs || 0) + 1;
    wallet.lastUpdated = new Date();
    await wallet.save();
    return reply.send({ success: true, data: wallet });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to debit wallet' });
  }
}

export async function setPayoutDetails(request, reply) {
  try {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Unauthorized' });
    const { name, account_number, bank_code, bank_name, currency } = request.body || {};
    if (!account_number || !bank_code || !name) return reply.code(400).send({ success: false, message: 'name, account_number and bank_code are required' });

    const updates = { payoutDetails: { name, account_number, bank_code, bank_name: bank_name || null, currency: currency || 'NGN' } };
    // ensure wallet exists and save payout details
    const wallet = await Wallet.findOneAndUpdate({ userId }, updates, { new: true, upsert: true });
    return reply.send({ success: true, data: wallet });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to set payout details' });
  }
}

  export async function getPayoutDetails(request, reply) {
    const userId = request.user?._id;
    if (!userId) return reply.code(401).send({ message: 'unauthenticated' });
    const w = await Wallet.findOne({ userId });
    if (!w || !w.payoutDetails) return reply.code(404).send({ message: 'no-payout-details' });
    const pd = w.payoutDetails;
    const masked = Object.assign({}, pd, { account_number: pd.account_number ? pd.account_number.slice(-4).padStart(pd.account_number.length, '*') : undefined });
    return reply.send({ payoutDetails: masked, hasRecipient: !!w.paystackRecipientCode });
  };
