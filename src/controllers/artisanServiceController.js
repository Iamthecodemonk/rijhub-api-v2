import Artisan from '../models/Artisan.js';
import ArtisanService from '../models/ArtisanService.js';
import JobCategory from '../models/JobCategory.js';
import JobSubCategory from '../models/JobSubCategory.js';
import mongoose from 'mongoose';

const MIN_HIGH_CONFIDENCE_COUNT = 20;
const MIN_MEDIUM_CONFIDENCE_COUNT = 5;

function toObjectId(value) {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) return null;
  return new mongoose.Types.ObjectId(value);
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function roundPrice(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const numeric = Number(value);
  if (numeric >= 1000) return Math.round(numeric / 500) * 500;
  if (numeric >= 100) return Math.round(numeric / 50) * 50;
  return Math.round(numeric);
}

function summarizePrices({ prices, basis, categoryId, subCategoryId = null, currency = 'NGN' }) {
  const sorted = prices.map(Number).filter((price) => Number.isFinite(price) && price > 0).sort((a, b) => a - b);
  const count = sorted.length;
  if (!count) {
    return {
      basis,
      categoryId,
      subCategoryId,
      currency,
      artisanCount: 0,
      totalPrice: 0,
      averagePrice: null,
      minimumPrice: null,
      maximumPrice: null,
      suggestedMin: null,
      suggestedMax: null,
      recommendedPrice: null,
      confidence: 'none',
      message: 'No pricing data available yet.',
    };
  }

  const total = sorted.reduce((sum, price) => sum + price, 0);
  const average = total / count;
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const median = percentile(sorted, 0.5);
  const confidence = count >= MIN_HIGH_CONFIDENCE_COUNT ? 'high' : count >= MIN_MEDIUM_CONFIDENCE_COUNT ? 'medium' : 'low';

  return {
    basis,
    categoryId,
    subCategoryId,
    currency,
    artisanCount: count,
    totalPrice: roundPrice(total),
    averagePrice: roundPrice(average),
    minimumPrice: roundPrice(sorted[0]),
    maximumPrice: roundPrice(sorted[count - 1]),
    suggestedMin: count >= MIN_MEDIUM_CONFIDENCE_COUNT ? roundPrice(q1) : null,
    suggestedMax: count >= MIN_MEDIUM_CONFIDENCE_COUNT ? roundPrice(q3) : null,
    recommendedPrice: roundPrice(median || average),
    confidence,
    message: confidence === 'low'
      ? 'Limited pricing data. Use this as a rough guide only.'
      : 'Suggestion is based on prices from existing artisans.',
  };
}

async function collectPrices({ categoryId, subCategoryId = null }) {
  const docs = await ArtisanService.find({ categoryId, isActive: true })
    .select('artisanId categoryId services')
    .lean();

  const prices = [];
  const artisanIds = new Set();
  for (const doc of docs) {
    for (const service of doc.services || []) {
      if (service?.isActive === false) continue;
      if (subCategoryId && String(service.subCategoryId) !== String(subCategoryId)) continue;
      const price = Number(service.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      prices.push(price);
      artisanIds.add(String(doc.artisanId));
    }
  }

  return { prices, artisanCount: artisanIds.size };
}

export const createOrUpdateServices = async (req, reply) => {
  try {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });

    const artisan = await Artisan.findOne({ userId });
    if (!artisan) return reply.code(404).send({ success: false, message: 'Artisan profile not found' });

    const { categoryId, services } = req.body || {};
    if (!categoryId || !Array.isArray(services) || services.length === 0) return reply.code(400).send({ success: false, message: 'categoryId and services required' });

    // Basic validation of subCategory existence
    const subIds = services.map(s => s.subCategoryId).filter(Boolean);
    const existingSubs = await JobSubCategory.find({ _id: { $in: subIds }, categoryId }).select('_id').lean();
    if (existingSubs.length !== subIds.length) return reply.code(400).send({ success: false, message: 'One or more subCategoryId values are invalid for the given categoryId' });

    // Store the artisanId as the underlying user id (artisan.userId)
    const userArtisanId = String(artisan.userId);
    const doc = await ArtisanService.findOneAndUpdate(
      { artisanId: userArtisanId, categoryId },
      { $set: { artisanId: userArtisanId, services, isActive: true, updatedAt: new Date() } },
      { upsert: true, new: true }
    );

    return reply.code(200).send({ success: true, data: doc });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to save services' });
  }
};

export const listMyServices = async (req, reply) => {
  try {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
    const artisan = await Artisan.findOne({ userId });
    if (!artisan) return reply.code(404).send({ success: false, message: 'Artisan profile not found' });

    const docs = await ArtisanService.find({ artisanId: artisan.userId, isActive: true }).populate('categoryId', 'name').populate('services.subCategoryId', 'name').lean();
    return reply.send({ success: true, data: docs });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list services' });
  }
};

export const getService = async (req, reply) => {
  try {
    const id = req.params.id;
    const doc = await ArtisanService.findById(id).populate('categoryId', 'name').populate('services.subCategoryId', 'name');
    if (!doc) return reply.code(404).send({ success: false, message: 'Not found' });
    // ensure ownership
    const userId = req.user?.id;
    const artisan = await Artisan.findOne({ userId });
    if (!artisan || String(doc.artisanId) !== String(artisan.userId)) return reply.code(403).send({ success: false, message: 'Forbidden' });
    return reply.send({ success: true, data: doc });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to get service' });
  }
};

export const updateService = async (req, reply) => {
  try {
    const id = req.params.id;
    const updates = req.body || {};
    const userId = req.user?.id;
    const artisan = await Artisan.findOne({ userId });
    if (!artisan) return reply.code(404).send({ success: false, message: 'Artisan profile not found' });

    const doc = await ArtisanService.findById(id);
    if (!doc) return reply.code(404).send({ success: false, message: 'Not found' });
    if (String(doc.artisanId) !== String(artisan.userId)) return reply.code(403).send({ success: false, message: 'Forbidden' });

    if (updates.services) doc.services = updates.services;
    if (typeof updates.isActive !== 'undefined') doc.isActive = Boolean(updates.isActive);
    doc.updatedAt = new Date();
    await doc.save();
    return reply.send({ success: true, data: doc });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to update service' });
  }
};

export const deleteService = async (req, reply) => {
  try {
    const id = req.params.id;
    const userId = req.user?.id;
    const artisan = await Artisan.findOne({ userId });
    if (!artisan) return reply.code(404).send({ success: false, message: 'Artisan profile not found' });

    const doc = await ArtisanService.findById(id);
    if (!doc) return reply.code(404).send({ success: false, message: 'Not found' });
    if (String(doc.artisanId) !== String(artisan.userId)) return reply.code(403).send({ success: false, message: 'Forbidden' });

    // soft delete
    doc.isActive = false;
    doc.updatedAt = new Date();
    await doc.save();
    return reply.send({ success: true, message: 'Service removed' });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to remove service' });
  }
};

// Public: list services for a given artisan (accepts artisanId which may be Artisan._id or User._id)
export const listByArtisan = async (req, reply) => {
  try {
    const artisanIdParam = req.params.artisanId || req.query.artisanId;
    if (!artisanIdParam) return reply.code(400).send({ success: false, message: 'artisanId required' });

    // Resolve artisan doc: accept either Artisan._id or User._id
    const artisan = await (async () => {
      const a = await (await import('../models/Artisan.js')).default.findById(artisanIdParam).lean();
      if (a) return a;
      // try as user id
      return (await import('../models/Artisan.js')).default.findOne({ userId: artisanIdParam }).lean();
    })();

    if (!artisan) return reply.code(404).send({ success: false, message: 'Artisan not found' });

    const docs = await ArtisanService.find({ artisanId: artisan.userId, isActive: true }).populate('categoryId', 'name').populate('services.subCategoryId', 'name').lean();
    return reply.send({ success: true, data: docs });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list artisan services' });
  }
};

export const getPriceSuggestion = async (req, reply) => {
  try {
    const categoryObjectId = toObjectId(req.query?.categoryId);
    const subCategoryObjectId = toObjectId(req.query?.subCategoryId);

    if (!categoryObjectId && !subCategoryObjectId) {
      return reply.code(400).send({
        success: false,
        message: 'categoryId or subCategoryId is required',
      });
    }

    let category = null;
    let subCategory = null;
    let categoryId = categoryObjectId;

    if (subCategoryObjectId) {
      subCategory = await JobSubCategory.findById(subCategoryObjectId).select('_id name categoryId').lean();
      if (!subCategory) return reply.code(404).send({ success: false, message: 'Subcategory not found' });
      if (categoryId && String(subCategory.categoryId) !== String(categoryId)) {
        return reply.code(400).send({ success: false, message: 'subCategoryId does not belong to categoryId' });
      }
      categoryId = subCategory.categoryId;
    }

    category = await JobCategory.findById(categoryId).select('_id name').lean();
    if (!category) return reply.code(404).send({ success: false, message: 'Category not found' });

    const [categoryPriceData, subCategoryPriceData] = await Promise.all([
      collectPrices({ categoryId }),
      subCategoryObjectId ? collectPrices({ categoryId, subCategoryId: subCategoryObjectId }) : Promise.resolve(null),
    ]);

    const categorySuggestion = summarizePrices({
      prices: categoryPriceData.prices,
      basis: 'category',
      categoryId: String(categoryId),
    });
    categorySuggestion.artisanCount = categoryPriceData.artisanCount;

    let subCategorySuggestion = null;
    if (subCategoryPriceData) {
      subCategorySuggestion = summarizePrices({
        prices: subCategoryPriceData.prices,
        basis: 'subcategory',
        categoryId: String(categoryId),
        subCategoryId: String(subCategoryObjectId),
      });
      subCategorySuggestion.artisanCount = subCategoryPriceData.artisanCount;
    }

    const primarySuggestion = subCategorySuggestion?.confidence && subCategorySuggestion.confidence !== 'none' && subCategorySuggestion.artisanCount >= MIN_MEDIUM_CONFIDENCE_COUNT
      ? subCategorySuggestion
      : categorySuggestion;

    return reply.send({
      success: true,
      message: 'Price suggestion fetched',
      data: {
        category: {
          _id: category._id,
          name: category.name,
        },
        subCategory: subCategory ? {
          _id: subCategory._id,
          name: subCategory.name,
        } : null,
        primaryBasis: primarySuggestion.basis,
        primarySuggestion,
        categorySuggestion,
        subCategorySuggestion,
      },
    });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to fetch price suggestion' });
  }
};
