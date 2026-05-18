// src/models/Artisan.js
import mongoose from 'mongoose';

const artisanSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  trade: [String], // Legacy field - kept for backward compatibility
  categories: [{ type: mongoose.Schema.Types.ObjectId, ref: "JobCategory" }], // New: hierarchical categories
  experience: Number,
  certifications: [String],
  bio: String,
  portfolio: [
    {
      title: String,
      description: String,
      images: [String],
      beforeAfter: Boolean,
    },
  ],
  serviceArea: {
    address: String,
    coordinates: { type: [Number], index: "2dsphere" },
    radius: Number,
  },
  pricing: {
    perHour: Number,
    perJob: Number,
  },
  availability: [String],
  verified: { type: Boolean, default: false },
  rating: { type: Number, default: 0 },
  reviewsCount: { type: Number, default: 0 },
  responseRate: { type: Number, default: 0 },
  completionRate: { type: Number, default: 0 },
  rankingScore: { type: Number, default: 0 },
  rankLevel: {
    type: String,
    enum: ["Bronze", "Silver", "Gold", "Platinum"],
    default: "Bronze",
  },
  analytics: {
    views: { type: Number, default: 0 },
    leads: { type: Number, default: 0 },
  },
  // Paystack recipient code and metadata for payouts
  paystackRecipientCode: { type: String },
  paystackRecipientMeta: { type: Object },
  // Paystack subaccount code and metadata for split payments
  paystackSubaccountCode: { type: String },
  paystackSubaccountMeta: { type: Object },
  createdAt: { type: Date, default: Date.now },
});

artisanSchema.methods.calculateRanking = function () {
  const score =
    (this.rating || 0) * 0.4 +
    (this.completionRate || 0) * 0.3 +
    (this.responseRate || 0) * 0.2 +
    (this.verified ? 10 : 0) * 0.1;

  this.rankingScore = score;

  if (score >= 90) this.rankLevel = "Platinum";
  else if (score >= 70) this.rankLevel = "Gold";
  else if (score >= 50) this.rankLevel = "Silver";
  else this.rankLevel = "Bronze";
};

// Expose virtuals when converting documents to objects/JSON
artisanSchema.set('toObject', { virtuals: true });
artisanSchema.set('toJSON', { virtuals: true });

// profileBaseProgress: returns 40 if the artisan has profile content, else 0
artisanSchema.virtual('profileBaseProgress').get(function () {
  try {
    const a = this;
    const hasProfile = !!(
      (a.bio && String(a.bio).trim().length) ||
      (Array.isArray(a.portfolio) && a.portfolio.length > 0) ||
      (a.serviceArea && (a.serviceArea.address || (Array.isArray(a.serviceArea.coordinates) && a.serviceArea.coordinates.length > 0))) ||
      (a.pricing && (a.pricing.perHour || a.pricing.perJob)) ||
      (Array.isArray(a.categories) && a.categories.length > 0) ||
      (a.experience && a.experience > 0) ||
      (Array.isArray(a.certifications) && a.certifications.length > 0)
    );
    return hasProfile ? 40 : 0;
  } catch (e) {
    return 0;
  }
});

export default mongoose.model('Artisan', artisanSchema);
