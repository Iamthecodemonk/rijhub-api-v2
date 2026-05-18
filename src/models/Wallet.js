// src/models/Wallet.js
import mongoose from 'mongoose';

const walletSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  balance: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  totalJobs: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now },
  // payout details for the user (artisan) used to create Paystack recipients / transfers
  payoutDetails: {
    name: String,
    account_number: String,
    bank_code: String,
    bank_name: String,
    currency: { type: String, default: 'NGN' },
  },
  // stored Paystack recipient code and metadata (if created)
  paystackRecipientCode: { type: String },
  paystackRecipientMeta: { type: Object },
  // stored Paystack subaccount code and metadata for split payments
  paystackSubaccountCode: { type: String },
  paystackSubaccountMeta: { type: Object },
});

export default mongoose.model('Wallet', walletSchema);
