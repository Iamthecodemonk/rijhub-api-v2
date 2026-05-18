import 'dotenv/config';
import mongoose from 'mongoose';
import Transaction from '../src/models/Transaction.js';
import Booking from '../src/models/Booking.js';
import Wallet from '../src/models/Wallet.js';
import Artisan from '../src/models/Artisan.js';
import { attemptPaystackTransfer, ensurePaystackRecipient, recordArtisanPayoutStatsIfNeeded } from '../src/utils/payout.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function logger() {
  const write = (level) => (payload, message) => {
    if (typeof payload === 'string') {
      console[level === 'error' ? 'error' : 'log'](`[${level}] ${payload}`, message || '');
      return;
    }
    console[level === 'error' ? 'error' : 'log'](`[${level}] ${message || ''}`, JSON.stringify(payload || {}, null, 2));
  };
  return {
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

async function main() {
  const bookingId = argValue('bookingId');
  const transactionId = argValue('transactionId');
  if (!bookingId && !transactionId) {
    throw new Error('Provide --bookingId=... or --transactionId=...');
  }
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');
  if (!process.env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not configured');

  await mongoose.connect(process.env.MONGO_URI);

  const tx = transactionId
    ? await Transaction.findById(transactionId)
    : await Transaction.findOne({ bookingId }).sort({ createdAt: -1 });
  if (!tx) throw new Error('Transaction not found');
  if (tx.transferRef) throw new Error(`Transaction already has transferRef ${tx.transferRef}`);
  if (tx.internalWalletCreditedAt) throw new Error('Transaction was already credited to internal wallet; do not retry automatically.');

  const booking = await Booking.findById(tx.bookingId || bookingId).populate('customerId artisanId');
  if (!booking) throw new Error('Booking not found');

  const artisanUserId = booking.artisanId?._id || booking.artisanId;
  const artisanDoc = await Artisan.findOne({ userId: artisanUserId });
  const wallet = await Wallet.findOne({ userId: artisanUserId }) || await Wallet.create({ userId: artisanUserId });
  let recipientCode = wallet.paystackRecipientCode || artisanDoc?.paystackRecipientCode || null;
  const request = { log: logger() };

  if (!recipientCode) recipientCode = await ensurePaystackRecipient({ wallet, artisanDoc, request });
  if (!recipientCode) throw new Error('No Paystack recipient code available for artisan');

  const payAmount = Number(tx.transferAmount || (Number(tx.amount || booking.price || 0) - Number(tx.companyFee || 0)));
  tx.status = 'released';
  tx.transferStatus = 'none';
  tx.transferFailureReason = undefined;
  tx.transferFailureMeta = undefined;
  await tx.save();

  const result = await attemptPaystackTransfer({ tx, booking, payAmount, recipientCode, request });
  if (result.finalized && result.succeeded) {
    await recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount });
    tx.status = 'paid';
    await tx.save();
  } else if (result.inFlight) {
    await recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount });
  }

  console.log(JSON.stringify({
    transactionId: String(tx._id),
    bookingId: String(booking._id),
    payAmount,
    result,
    transferStatus: tx.transferStatus,
    transferRef: tx.transferRef || null,
    transferFailureReason: tx.transferFailureReason || null,
  }, null, 2));
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
