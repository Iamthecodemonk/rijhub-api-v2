// src/models/Kyc.js
import mongoose from 'mongoose';

const kycSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  businessName: { type: String },
  country: { type: String, default: 'Nigeria' },
  state: { type: String },
  lga: { type: String },

  profileImage: { url: String, public_id: String },
  IdType: { type: String },
  idNumber: { type: String },
  IdUploadFront: { url: String, public_id: String },
  IdUploadBack: { url: String, public_id: String },

  provider: { type: String, enum: ['manual', 'dojah', 'dojah_sdk'], default: 'manual' },
  verificationType: { type: String },
  referenceId: { type: String, index: true },
  providerStatus: { type: String },
  providerResponse: { type: Object },
  failureReason: { type: String },
  verifiedAt: { type: Date },
  firstName: { type: String },
  lastName: { type: String },
  selfieVerification: {
    match: { type: Boolean },
    confidenceValue: { type: Number },
    threshold: { type: Number },
  },

  serviceCategory: { type: String },
  yearsExperience: { type: Number, default: 0 },

  status: { type: String, enum: ['pending', 'approved', 'rejected', 'pending_review'], default: 'pending' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Kyc', kycSchema);
