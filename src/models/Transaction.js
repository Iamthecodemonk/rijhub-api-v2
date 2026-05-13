// src/models/Transaction.js
import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
  quoteId: { type: mongoose.Schema.Types.ObjectId, ref: "Quote" },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  payeeId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  amount: Number,
  companyFee: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ["pending", "holding", "released", "paid", "refunded", "failed"],
    default: "pending",
  },
  paymentGatewayRef: String,
  // Paystack refund id (to prevent duplicate refunds and to query status)
  refundId: { type: String },
  refundStatus: { type: String, enum: ['none','requested','refunded'], default: 'none' },
  // transfer fields for payouts to artisan
  transferRef: { type: String },
  transferAmount: { type: Number },
  transferStatus: { type: String, enum: ['none','pending','processing','processed','queued','completed','success','failed'], default: 'none' },
  internalWalletCreditedAt: { type: Date },
  artisanStatsCreditedAt: { type: Date },
  customerStatsCreditedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  releasedAt: Date,
});

export default mongoose.model('Transaction', transactionSchema);
