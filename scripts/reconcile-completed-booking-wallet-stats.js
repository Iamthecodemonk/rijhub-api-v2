import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectDB from '../src/config/db.js';
import Booking from '../src/models/Booking.js';
import Transaction from '../src/models/Transaction.js';
import Wallet from '../src/models/Wallet.js';
import { getConfig } from '../src/utils/config.js';

dotenv.config();

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

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

async function reconcileBooking(booking) {
  const customerId = booking.customerId?._id || booking.customerId;
  const artisanId = booking.artisanId?._id || booking.artisanId;
  const amount = Number(booking.price || 0);
  if (!customerId || !artisanId || amount <= 0) {
    return { bookingId: String(booking._id), skipped: true, reason: 'missing_party_or_amount' };
  }

  let tx = await Transaction.findOne({ bookingId: booking._id }).sort({ createdAt: -1 });
  const fee = await getCompanyFee(amount, tx);
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
      transferStatus: 'success',
      releasedAt: new Date(),
    });
  } else {
    tx.payerId = tx.payerId || customerId;
    tx.payeeId = tx.payeeId || artisanId;
    tx.amount = Number(tx.amount || amount);
    tx.companyFee = Number(tx.companyFee || fee);
    tx.transferAmount = Number(tx.transferAmount || payAmount);
    if (tx.status === 'pending') tx.status = 'paid';
    await tx.save();
  }

  await Wallet.updateOne({ userId: artisanId }, { $setOnInsert: { userId: artisanId } }, { upsert: true });
  await Wallet.updateOne({ userId: customerId }, { $setOnInsert: { userId: customerId } }, { upsert: true });

  const artisanMarker = await Transaction.updateOne(
    { _id: tx._id, $or: [{ artisanStatsCreditedAt: { $exists: false } }, { artisanStatsCreditedAt: null }] },
    { $set: { artisanStatsCreditedAt: new Date() } }
  );
  const artisanUpdated = artisanMarker.modifiedCount > 0;
  if (artisanUpdated) {
    await Wallet.updateOne(
      { userId: artisanId },
      { $inc: { totalEarned: payAmount, totalJobs: 1 }, $set: { lastUpdated: new Date() } }
    );
  }

  const customerMarker = await Transaction.updateOne(
    { _id: tx._id, $or: [{ customerStatsCreditedAt: { $exists: false } }, { customerStatsCreditedAt: null }] },
    { $set: { customerStatsCreditedAt: new Date() } }
  );
  const customerUpdated = customerMarker.modifiedCount > 0;
  if (customerUpdated) {
    await Wallet.updateOne(
      { userId: customerId },
      { $inc: { totalSpent: amount, totalJobs: 1 }, $set: { lastUpdated: new Date() } }
    );
  }

  return {
    bookingId: String(booking._id),
    transactionId: String(tx._id),
    artisanId: String(artisanId),
    customerId: String(customerId),
    amount,
    payAmount,
    artisanUpdated,
    customerUpdated,
  };
}

async function main() {
  const bookingId = argValue('bookingId');
  await connectDB();

  const query = { status: 'completed', paymentStatus: 'paid' };
  if (bookingId) query._id = new mongoose.Types.ObjectId(bookingId);

  const bookings = await Booking.find(query).sort({ createdAt: 1 });
  const results = [];
  for (const booking of bookings) {
    results.push(await reconcileBooking(booking));
  }

  console.log(JSON.stringify({ count: results.length, results }, null, 2));
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
