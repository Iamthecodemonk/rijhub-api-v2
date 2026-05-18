import dotenv from 'dotenv';
import mongoose from 'mongoose';
import axios from 'axios';
import connectDB from '../src/config/db.js';
import Transaction from '../src/models/Transaction.js';
import Wallet from '../src/models/Wallet.js';
import { recordArtisanPayoutStatsIfNeeded } from '../src/utils/payout.js';

dotenv.config();

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function fetchPaystackTransfer(transferRef) {
  const res = await axios.get(`https://api.paystack.co/transfer/${encodeURIComponent(transferRef)}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  });
  return res.data;
}

async function main() {
  const bookingId = argValue('bookingId');
  const transactionId = argValue('transactionId');
  const transferRef = argValue('transferRef');

  if (!process.env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  if (!bookingId && !transactionId && !transferRef) {
    throw new Error('Provide --bookingId=... or --transactionId=... or --transferRef=...');
  }

  await connectDB();

  let tx = null;
  if (transactionId) tx = await Transaction.findById(transactionId);
  else if (bookingId) tx = await Transaction.findOne({ bookingId }).sort({ createdAt: -1 });
  else if (transferRef) tx = await Transaction.findOne({ transferRef });

  if (!tx && !transferRef) throw new Error('Transaction not found');
  const ref = transferRef || tx.transferRef;
  if (!ref) throw new Error('Transaction has no transferRef; Paystack bank payout was not initiated');

  const paystack = await fetchPaystackTransfer(ref);
  const data = paystack?.data || {};
  const status = String(data.status || '').toLowerCase();

  if (tx) {
    tx.transferStatus = status || tx.transferStatus;
    tx.transferRef = tx.transferRef || data.transfer_code || data.reference || data.id || ref;
    if (['success', 'completed', 'processed'].includes(status)) {
      tx.status = 'paid';
      if (tx.payeeId) {
        const payAmount = Number(tx.transferAmount || (Number(tx.amount || 0) - Number(tx.companyFee || 0)) || 0);
        const wallet = await Wallet.findOne({ userId: tx.payeeId }) || await Wallet.create({ userId: tx.payeeId });
        await recordArtisanPayoutStatsIfNeeded({ tx, wallet, payAmount });
      }
    }
    await tx.save();
  }

  console.log(JSON.stringify({
    localTransaction: tx ? {
      id: String(tx._id),
      bookingId: tx.bookingId ? String(tx.bookingId) : null,
      amount: tx.amount,
      companyFee: tx.companyFee,
      transferAmount: tx.transferAmount,
      status: tx.status,
      transferStatus: tx.transferStatus,
      transferRef: tx.transferRef,
      payeeId: tx.payeeId ? String(tx.payeeId) : null,
    } : null,
    paystack,
  }, null, 2));

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(err?.response?.data || err);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
