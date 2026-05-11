import Artisan from '../models/Artisan.js';
import axios from 'axios';
import cloudinary from '../utils/cloudinary.js';
import User from '../models/User.js';
import { createNotification } from '../utils/notifier.js';
import ArtisanService from '../models/ArtisanService.js';
const JobCategory = (await import('../models/JobCategory.js')).default;
const JobSubCategory = (await import('../models/JobSubCategory.js')).default;
// const JobCategory = (await import('../models/JobCategory.js')).default;

// Compute a simple profile completion progress for an artisan
function computeProfileProgress(artisanObj = {}, kycInfo = null) {
  try {
    if (artisanObj.verified) return 100;
    let progress = 0;
    // consider KYC present if we have a KYC record or user-level kyc flags
    const kycPresent = Boolean(kycInfo) || !!artisanObj.kycVerified || !!(artisanObj.artisanAuthDetails && artisanObj.artisanAuthDetails.kycVerified) || !!(artisanObj.user && artisanObj.user.kycVerified);
    if (kycPresent) progress += 40;

    // Prefer model virtual if available (profileBaseProgress), otherwise fallback to computing
    if (typeof artisanObj.profileBaseProgress === 'number') {
      progress += artisanObj.profileBaseProgress;
    } else {
      const hasProfile = !!(
        (artisanObj.bio && String(artisanObj.bio).trim().length) ||
        (Array.isArray(artisanObj.portfolio) && artisanObj.portfolio.length > 0) ||
        (artisanObj.serviceArea && (artisanObj.serviceArea.address || (Array.isArray(artisanObj.serviceArea.coordinates) && artisanObj.serviceArea.coordinates.length > 0))) ||
        (artisanObj.pricing && (artisanObj.pricing.perHour || artisanObj.pricing.perJob)) ||
        (Array.isArray(artisanObj.categories) && artisanObj.categories.length > 0) ||
        (artisanObj.experience && artisanObj.experience > 0) ||
        (Array.isArray(artisanObj.certifications) && artisanObj.certifications.length > 0)
      );
      if (hasProfile) progress += 40;
    }
    return Math.min(100, progress);
  } catch (e) {
    return 0;
  }
}

function buildPublicKycDetails(kycInfo = null) {
  if (!kycInfo) return null;
  return {
    status: kycInfo.status,
    providerStatus: kycInfo.providerStatus || null,
    failureReason: kycInfo.failureReason || null,
    idType: kycInfo.IdType || kycInfo.idType || null,
    verified: kycInfo.status === 'approved',
    submittedAt: kycInfo.createdAt,
  };
}

function chooseVisibleKycRecord({ latestKyc = null, approvedKyc = null, user = null, artisan = null } = {}) {
  const verified = !!(artisan?.verified || user?.kycVerified || user?.isVerified);
  return verified && approvedKyc ? approvedKyc : latestKyc;
}

function dedupeArtisansByUser(results = []) {
  const seen = new Set();
  const deduped = [];

  for (const result of results) {
    const obj = result && result.toObject ? result.toObject() : result;
    const rawUserId = obj?.userId && (typeof obj.userId === 'string'
      ? obj.userId
      : obj.userId?._id
        ? String(obj.userId._id)
        : String(obj.userId));
    const key = rawUserId || String(obj?._id || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(obj);
  }

  return deduped;
}

function clonePortfolioItems(items = []) {
  return Array.isArray(items)
    ? items.map((item) => ({
        ...(item && typeof item === 'object' ? item : {}),
        images: Array.isArray(item?.images) ? [...item.images] : [],
      }))
    : [];
}

function getPortfolioIndexFromField(fieldName) {
  const field = String(fieldName || '');
  if (!field) return null;
  if (field === 'portfolioImage' || field === 'portfolioImages') return 0;
  if (!field.startsWith('portfolio')) return null;

  const match = field.match(/^portfolio(?:Image|Images)?(\d+)(?:_(\d+))?$/);
  if (!match) return 0;

  const rawIndex = Number(match[1]);
  if (!Number.isInteger(rawIndex) || rawIndex < 1) return 0;
  return rawIndex - 1;
}

function mergePortfolioUploads(portfolio, files, fallback = {}) {
  const merged = clonePortfolioItems(portfolio);

  for (const file of Array.isArray(files) ? files : []) {
    const index = getPortfolioIndexFromField(file?.fieldName || file?.field);
    if (index === null || !file?.url) continue;

    while (merged.length <= index) {
      merged.push({
        title: index === 0 ? (fallback.title || 'Portfolio images') : `Portfolio ${merged.length + 1}`,
        description: index === 0 ? (fallback.description || '') : '',
        images: [],
        beforeAfter: false,
      });
    }

    if (!Array.isArray(merged[index].images)) merged[index].images = [];
    merged[index].images.push(file.url);
  }

  return merged;
}

async function buildPublicArtisanVisibilityFilter() {
  const verifiedUsers = await User.find(
    { $or: [{ isVerified: true }, { kycVerified: true }] },
    '_id'
  ).lean();

  const verifiedUserIds = verifiedUsers.map((user) => user._id);

  if (!verifiedUserIds.length) {
    return { verified: true };
  }

  return {
    $or: [
      { verified: true },
      { userId: { $in: verifiedUserIds } },
    ],
  };
}

async function resolveArtisanUserIdsForDiscovery({ categoryId, subCategoryId, terms = [] } = {}) {
  const normalizedTerms = terms.map((term) => String(term).trim()).filter(Boolean);
  const categoryIds = new Set(categoryId ? [String(categoryId)] : []);
  const subCategoryIds = new Set(subCategoryId ? [String(subCategoryId)] : []);
  const userIds = new Set();

  for (const term of normalizedTerms) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(esc, 'i');

    const [catMatches, subMatches, artisanMatches] = await Promise.all([
      JobCategory.find({ name: { $regex: regex } }).select('_id').lean(),
      JobSubCategory.find({ name: { $regex: regex } }).select('_id').lean(),
      Artisan.find({
        $or: [
          { trade: { $in: [regex] } },
          { bio: { $regex: regex } },
          { 'serviceArea.address': { $regex: regex } },
        ],
      }).select('userId').lean(),
    ]);

    for (const cat of catMatches) categoryIds.add(String(cat._id));
    for (const sub of subMatches) subCategoryIds.add(String(sub._id));
    for (const artisan of artisanMatches) if (artisan.userId) userIds.add(String(artisan.userId));
  }

  const serviceQuery = { isActive: true };
  if (categoryIds.size) serviceQuery.categoryId = { $in: Array.from(categoryIds) };
  if (subCategoryIds.size) serviceQuery['services.subCategoryId'] = { $in: Array.from(subCategoryIds) };

  if (categoryIds.size || subCategoryIds.size) {
    const serviceDocs = await ArtisanService.find(serviceQuery).select('artisanId').lean();
    for (const doc of serviceDocs) if (doc.artisanId) userIds.add(String(doc.artisanId));
  }

  if (categoryIds.size) {
    const profileMatches = await Artisan.find({ categories: { $in: Array.from(categoryIds) } }).select('userId').lean();
    for (const artisan of profileMatches) if (artisan.userId) userIds.add(String(artisan.userId));
  }

  return Array.from(userIds);
}

export async function listArtisans(request, reply) {
  try {
    const { page = 1, limit = 20, trade, categoryId, sortBy = 'rating', q: searchTerm, location } = request.query || {};
    const filters = {};

    // Trade/profession filter (supports search term from 'q' parameter or specific 'trade' parameter)
    if (trade || searchTerm) {
      const term = (trade || searchTerm).toString().trim();
      if (term) {
        const terms = term.split(',').map(t => t.trim()).filter(Boolean);
        if (terms.length > 0) {
          const matchedUserIds = await resolveArtisanUserIdsForDiscovery({ terms, categoryId });
          if (!matchedUserIds.length) return reply.send({ success: true, data: [] });
          filters.userId = { $in: matchedUserIds };
        }
      }
    }
    else if (categoryId) {
      const matchedUserIds = await resolveArtisanUserIdsForDiscovery({ categoryId });
      if (!matchedUserIds.length) return reply.send({ success: true, data: [] });
      filters.userId = { $in: matchedUserIds };
    }

    // Location filter (basic address match)
    if (location) {
      filters['serviceArea.address'] = { $regex: location.trim(), $options: 'i' };
    }

    // Only show verified artisans to regular users; admins can see all
    const isAdmin = request.user && request.user.role === 'admin';
    if (!isAdmin) {
      const visibilityFilter = await buildPublicArtisanVisibilityFilter();
      Object.assign(filters, filters.$or ? { $and: [{ ...filters }, visibilityFilter] } : visibilityFilter);
    }

    console.log('listArtisans query:', filters);
    console.log('isAdmin:', isAdmin);
    console.log('request.user:', request.user);

    const results = await Artisan.find(filters)
      .sort({ [sortBy]: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .exec();
    const objs = dedupeArtisansByUser(results);
    // console.log(objs);
    // Resolve linked users (if any)
    const idsToResolve = [];
    for (const obj of objs) {
      if (obj.userId && !(obj.userId && obj.userId.name)) idsToResolve.push(String(obj.userId));
    }

    let resolvedUsersMap = {};
    if (idsToResolve.length) {
      const User = (await import('../models/User.js')).default;
      // fetch a fuller set of user fields for listing (avoid exposing password)
      const users = await User.find({ _id: { $in: idsToResolve } }, 'name profileImage email phone kycVerified isVerified role').lean();
      for (const u of users) resolvedUsersMap[String(u._id)] = u;
    }

    // Collect all user ids to fetch reviews
    const allUserIdsSet = new Set();
    for (const obj of objs) {
      if (!obj.userId) continue;
      let idStr = null;
      if (typeof obj.userId === 'string') idStr = obj.userId;
      else if (obj.userId._id) idStr = String(obj.userId._id);
      else idStr = String(obj.userId);
      if (idStr) allUserIdsSet.add(idStr);
    }

    const reviewsSummaryMap = {};
    if (allUserIdsSet.size) {
      const Review = (await import('../models/Review.js')).default;
      const idsArray = Array.from(allUserIdsSet);
      const reviews = await Review.find({ artisanId: { $in: idsArray } }, 'rating artisanId').lean();
      for (const r of reviews) {
        const key = String(r.artisanId);
        if (!reviewsSummaryMap[key]) reviewsSummaryMap[key] = { sum: 0, count: 0 };
        reviewsSummaryMap[key].sum += (r.rating || 0);
        reviewsSummaryMap[key].count += 1;
      }
      for (const k of Object.keys(reviewsSummaryMap)) {
        const rec = reviewsSummaryMap[k];
        rec.avg = rec.count ? rec.sum / rec.count : 0;
      }
    }

    // Fetch KYC information for artisans
    const kycMap = {};
    if (allUserIdsSet.size) {
      const Kyc = (await import('../models/Kyc.js')).default;
      const idsArray = Array.from(allUserIdsSet);
      const kycRecords = await Kyc.find({ userId: { $in: idsArray } }).sort({ createdAt: -1 }).lean();
      for (const kyc of kycRecords) {
        const key = String(kyc.userId);
        if (!kycMap[key]) kycMap[key] = kyc; // Get most recent KYC
      }
    }

    // Fetch completed bookings count for artisans
    const bookingsCountMap = {};
    if (allUserIdsSet.size) {
      const Booking = (await import('../models/Booking.js')).default;
      const mongoose = (await import('mongoose')).default;
      const idsArray = Array.from(allUserIdsSet);
      const bookings = await Booking.aggregate([
        { $match: { artisanId: { $in: idsArray.map(id => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: '$artisanId', total: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } }
      ]);
      for (const b of bookings) {
        bookingsCountMap[String(b._id)] = { total: b.total, completed: b.completed };
      }
    }

    // Fetch artisan services for returned artisans. ArtisanService.artisanId should store User._id,
    // but for backwards-compatibility also attempt to resolve records stored with Artisan._id.
    const artisanUserIds = Array.from(allUserIdsSet);
    let servicesMap = {};
    if (artisanUserIds.length) {
      const artisanIdToUserId = {};
      for (const obj of objs) {
        const artisanIdStr = obj._id ? String(obj._id) : null;
        const userIdStr = obj.userId && (typeof obj.userId === 'string' ? obj.userId : (obj.userId._id || obj.userId));
        if (artisanIdStr && userIdStr) artisanIdToUserId[artisanIdStr] = String(userIdStr);
      }
      const searchIds = Array.from(new Set(artisanUserIds.concat(Object.keys(artisanIdToUserId))));
      const svcDocs = await ArtisanService.find({ artisanId: { $in: searchIds }, isActive: true }).populate('categoryId', 'name').populate('services.subCategoryId', 'name').lean();
      for (const s of svcDocs) {
        const aid = String(s.artisanId);
        let key = null;
        if (artisanUserIds.includes(aid)) key = aid;
        else if (artisanIdToUserId[aid]) key = artisanIdToUserId[aid];
        else key = aid;
        if (!servicesMap[key]) servicesMap[key] = [];
        servicesMap[key].push(s);
      }
    }

    // Resolve artisan categories (JobCategory names) for returned artisans so `trade` can reflect categories
    const allCategoryIds = new Set();
    for (const obj of objs) {
      if (Array.isArray(obj.categories) && obj.categories.length) {
        for (const c of obj.categories) allCategoryIds.add(String(c));
      }
      // also include categories present in services
      const rawUserId = obj.userId && (typeof obj.userId === 'string' ? obj.userId : (obj.userId._id || obj.userId));
      const svcForUser = servicesMap[String(rawUserId)] || [];
      for (const sv of svcForUser) if (sv.categoryId && sv.categoryId._id) allCategoryIds.add(String(sv.categoryId._id));
    }
    let categoriesMap = {};
    if (allCategoryIds.size) {
      const cats = await JobCategory.find({ _id: { $in: Array.from(allCategoryIds) } }).select('name').lean();
      for (const c of cats) categoriesMap[String(c._id)] = c.name;
    }

    const out = objs.map(obj => {
      let rawUserId = null;
      if (obj.userId) {
        if (typeof obj.userId === 'string') rawUserId = obj.userId;
        else if (obj.userId._id) rawUserId = String(obj.userId._id);
        else rawUserId = String(obj.userId);
      }

      let authUser = null;
      if (obj.userId && obj.userId.name) authUser = obj.userId;
      else if (rawUserId) authUser = resolvedUsersMap[rawUserId] || null;

      const reviewSummary = rawUserId ? reviewsSummaryMap[rawUserId] || null : null;
      const kycInfo = rawUserId ? kycMap[rawUserId] || null : null;
      const bookingsStats = rawUserId ? bookingsCountMap[rawUserId] || { total: 0, completed: 0 } : { total: 0, completed: 0 };

      return {
        ...obj,
        // `trade` should list category names (job categories) rather than legacy profile trade items
        trade: (servicesMap[String(rawUserId)] || []).map(s => s.categoryId && s.categoryId.name).filter(Boolean),
        services: servicesMap[String(rawUserId)] || [],
        verified: !!obj.verified,
        userId: rawUserId,
        artisanAuthDetails: authUser ? {
          name: authUser.name || null,
          profileImage: authUser.profileImage || null,
          email: authUser.email || null,
          phone: authUser.phone || null,
          kycVerified: authUser.kycVerified || false,
          isVerified: authUser.isVerified || false,
        } : null,
        // provide fuller user object for client convenience
        user: authUser ? {
          _id: authUser._id,
          name: authUser.name || null,
          profileImageUrl: authUser.profileImage?.url || null,
          email: authUser.email || null,
          phone: authUser.phone || null,
          role: authUser.role || null,
          kycVerified: authUser.kycVerified || false,
          isVerified: authUser.isVerified || false,
        } : null,
        reviewsSummary: reviewSummary ? { avgRating: reviewSummary.avg, count: reviewSummary.count } : { avgRating: obj.rating || 0, count: 0 },
        kycDetails: kycInfo ? (isAdmin ? {
          // full KYC payload for admins (includes uploaded images and other fields)
          businessName: kycInfo.businessName || null,
          country: kycInfo.country || null,
          state: kycInfo.state || null,
          lga: kycInfo.lga || null,
          profileImage: kycInfo.profileImage || null,
          idType: kycInfo.IdType || kycInfo.idType || null,
          idUploadFront: kycInfo.IdUploadFront || kycInfo.idUploadFront || null,
          idUploadBack: kycInfo.IdUploadBack || kycInfo.idUploadBack || null,
          serviceCategory: kycInfo.serviceCategory || null,
          yearsExperience: kycInfo.yearsExperience || null,
          status: kycInfo.status || null,
          providerStatus: kycInfo.providerStatus || null,
          failureReason: kycInfo.failureReason || null,
          reviewedBy: kycInfo.reviewedBy || null,
          submittedAt: kycInfo.createdAt || null,
          raw: kycInfo
        } : buildPublicKycDetails(kycInfo)) : null,
        bookingsStats: bookingsStats,
        // Profile completion progress (kyc 40%, profile details 40%, verified => 100%)
        profileProgress: computeProfileProgress(obj, kycInfo),
      };
    });

    return reply.send({ success: true, data: out });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list artisans' });
  }
}

export async function searchArtisans(request, reply) {
  try {
    const { page = 1, limit = 20, lat, lon, radiusKm = 10, location, q, trade, categoryId, subCategoryId, sortBy = 'rating' } = request.query || {};

    const filters = {};

    // Only return verified artisans in search results for non-admins
    const isAdmin = request.user && request.user.role === 'admin';
    if (!isAdmin) {
      const visibilityFilter = await buildPublicArtisanVisibilityFilter();
      Object.assign(filters, visibilityFilter);
    }

    // Service-based filtering: prefer JobCategory / JobSubCategory matching via ArtisanService
    // If caller provided categoryId, subCategoryId or a free-text `q` that matches category/subcategory names,
    // resolve artisans that offer those services and restrict results to those artisans.
    if (categoryId || subCategoryId || q || trade) {
      const terms = [q, trade]
        .filter(Boolean)
        .flatMap((value) => String(value).split(',').map((term) => term.trim()).filter(Boolean));
      const matchedUserIds = await resolveArtisanUserIdsForDiscovery({ categoryId, subCategoryId, terms });
      if (!matchedUserIds.length) return reply.send({ success: true, data: [] });
      filters.userId = { $in: matchedUserIds };
    }

    // If lat & lon provided, do geospatial $near query against serviceArea.coordinates
    const hasCoords = lat !== undefined && lon !== undefined && !isNaN(Number(lat)) && !isNaN(Number(lon));
    if (hasCoords) {
      const latN = Number(lat);
      const lonN = Number(lon);
      const maxMeters = Number(radiusKm || 10) * 1000;
      filters['serviceArea.coordinates'] = {
        $near: {
          $geometry: { type: 'Point', coordinates: [lonN, latN] },
          $maxDistance: maxMeters,
        },
      };
    } else if (location) {
      // If a free-text location is provided but not coordinates, try geocoding (Mapbox) if token present,
      // otherwise fallback to case-insensitive address regex match.
      let usedCoords = null;
      if (process.env.MAPBOX_TOKEN) {
        try {
          const mapboxUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json?access_token=${process.env.MAPBOX_TOKEN}&limit=1`;
          const r = await axios.get(mapboxUrl);
          const feat = r?.data?.features?.[0];
          if (feat && feat.center && feat.center.length >= 2) {
            const [lonN, latN] = feat.center;
            const maxMeters = Number(radiusKm || 10) * 1000;
            usedCoords = { lon: lonN, lat: latN, maxMeters };
            filters['serviceArea.coordinates'] = {
              $near: { $geometry: { type: 'Point', coordinates: [lonN, latN] }, $maxDistance: maxMeters },
            };
          }
        } catch (e) {
          request.log?.warn?.('mapbox geocode failed', e?.message || e);
        }
      }
      if (!usedCoords) {
        // fallback to address regex
        filters['serviceArea.address'] = { $regex: location, $options: 'i' };
      }
    }

    // Build query and execute
    const query = Artisan.find(filters).sort({ [sortBy]: -1 }).skip((page - 1) * limit).limit(Number(limit));
    // const query = Artisan.find(filters).sort({ [sortBy]: -1 }).skip((page - 1) * limit).limit(Number(limit)).populate('userId', 'name profileImage');
    const results = await query.exec();
    const objs = dedupeArtisansByUser(results);
    // console.log(objs);
    // console.log('typeof',objs);
    const idsToResolve = [];
    for (const obj of objs) {
      // Collect ids where user info is not already populated (populated docs have a `name` field)
      if (obj.userId && !(obj.userId && obj.userId.name)) {
        idsToResolve.push(String(obj.userId));
      }
    }
    // console.log('idsToResolve', idsToResolve);
    let resolvedUsersMap = {};
    if (idsToResolve.length) {
      // console.log('resolving userIds', idsToResolve);
      const User = (await import('../models/User.js')).default;
      const users = await User.find({ _id: { $in: idsToResolve } }, 'name profileImage email kycVerified isVerified').lean();
      // console.log('users', users);
      for (const u of users) resolvedUsersMap[String(u._id)] = u;
    }

    // Build a set of all user ids present on the returned artisans (whether populated or raw)
    const allUserIdsSet = new Set();
    for (const obj of objs) {
      if (!obj.userId) continue;
      let idStr = null;
      if (typeof obj.userId === 'string') idStr = obj.userId;
      else if (obj.userId._id) idStr = String(obj.userId._id);
      else idStr = String(obj.userId);
      if (idStr) allUserIdsSet.add(idStr);
    }

    // Fetch reviews for these artisan user ids and compute avg/count per artisan (artisanId in Review refers to User._id)
    const reviewsSummaryMap = {};
    if (allUserIdsSet.size) {
      const Review = (await import('../models/Review.js')).default;
      const idsArray = Array.from(allUserIdsSet);
      const reviews = await Review.find({ artisanId: { $in: idsArray } }, 'rating artisanId').lean();
      for (const r of reviews) {
        const key = String(r.artisanId);
        if (!reviewsSummaryMap[key]) reviewsSummaryMap[key] = { sum: 0, count: 0 };
        reviewsSummaryMap[key].sum += (r.rating || 0);
        reviewsSummaryMap[key].count += 1;
      }
      for (const k of Object.keys(reviewsSummaryMap)) {
        const rec = reviewsSummaryMap[k];
        rec.avg = rec.count ? rec.sum / rec.count : 0;
      }
    }

    // Fetch KYC information for artisans
    const kycMap = {};
    if (allUserIdsSet.size) {
      const Kyc = (await import('../models/Kyc.js')).default;
      const idsArray = Array.from(allUserIdsSet);
      const kycRecords = await Kyc.find({ userId: { $in: idsArray } }).sort({ createdAt: -1 }).lean();
      for (const kyc of kycRecords) {
        const key = String(kyc.userId);
        if (!kycMap[key]) kycMap[key] = kyc; // Get most recent KYC
      }
    }

    // Fetch completed bookings count for artisans
    const bookingsCountMap = {};
    if (allUserIdsSet.size) {
      const Booking = (await import('../models/Booking.js')).default;
      const mongoose = (await import('mongoose')).default;
      const idsArray = Array.from(allUserIdsSet);
      const bookings = await Booking.aggregate([
        { $match: { artisanId: { $in: idsArray.map(id => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: '$artisanId', total: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } }
      ]);
      for (const b of bookings) {
        bookingsCountMap[String(b._id)] = { total: b.total, completed: b.completed };
      }
    }

    // Fetch artisan services for returned artisans (ArtisanService.artisanId stores User._id)
    const artisanUserIds2 = Array.from(allUserIdsSet);
    let servicesMap = {};
    if (artisanUserIds2.length) {
      const artisanIdToUserId2 = {};
      for (const obj of objs) {
        const artisanIdStr = obj._id ? String(obj._id) : null;
        const userIdStr = obj.userId && (typeof obj.userId === 'string' ? obj.userId : (obj.userId._id || obj.userId));
        if (artisanIdStr && userIdStr) artisanIdToUserId2[artisanIdStr] = String(userIdStr);
      }
      const searchIds2 = Array.from(new Set(artisanUserIds2.concat(Object.keys(artisanIdToUserId2))));
      const svcDocs = await ArtisanService.find({ artisanId: { $in: searchIds2 }, isActive: true }).populate('categoryId', 'name').populate('services.subCategoryId', 'name').lean();
      for (const s of svcDocs) {
        const aid = String(s.artisanId);
        let key = null;
        if (artisanUserIds2.includes(aid)) key = aid;
        else if (artisanIdToUserId2[aid]) key = artisanIdToUserId2[aid];
        else key = aid;
        if (!servicesMap[key]) servicesMap[key] = [];
        servicesMap[key].push(s);
      }
    }

    const out = objs.map(obj => {
      // derive a stable userId string whether populated or raw
      let rawUserId = null;
      if (obj.userId) {
        if (typeof obj.userId === 'string') rawUserId = obj.userId;
        else if (obj.userId._id) rawUserId = String(obj.userId._id);
        else rawUserId = String(obj.userId);
      }

      // resolve user object: prefer populated subdoc, fallback to resolvedUsersMap
      let authUser = null;
      if (obj.userId && obj.userId.name) authUser = obj.userId;
      else if (rawUserId) authUser = resolvedUsersMap[rawUserId] || null;

      const reviewSummary = rawUserId ? reviewsSummaryMap[rawUserId] || null : null;
      const kycInfo = rawUserId ? kycMap[rawUserId] || null : null;
      const bookingsStats = rawUserId ? bookingsCountMap[rawUserId] || { total: 0, completed: 0 } : { total: 0, completed: 0 };

      return {
        ...obj,
        verified: !!obj.verified,
        userId: rawUserId,
        artisanAuthDetails: authUser ? {
          name: authUser.name || null,
          profileImage: authUser.profileImage || null,
        } : null,
        user: authUser ? { _id: authUser._id, name: authUser.name || null, profileImageUrl: authUser.profileImage?.url || null } : null,
        reviewsSummary: reviewSummary ? { avgRating: reviewSummary.avg, count: reviewSummary.count } : { avgRating: obj.rating || 0, count: 0 },
        kycDetails: kycInfo ? (isAdmin ? {
          businessName: kycInfo.businessName || null,
          country: kycInfo.country || null,
          state: kycInfo.state || null,
          lga: kycInfo.lga || null,
          profileImage: kycInfo.profileImage || null,
          idType: kycInfo.IdType || kycInfo.idType || null,
          idUploadFront: kycInfo.IdUploadFront || kycInfo.idUploadFront || null,
          idUploadBack: kycInfo.IdUploadBack || kycInfo.idUploadBack || null,
          serviceCategory: kycInfo.serviceCategory || null,
          yearsExperience: kycInfo.yearsExperience || null,
          status: kycInfo.status || null,
          providerStatus: kycInfo.providerStatus || null,
          failureReason: kycInfo.failureReason || null,
          reviewedBy: kycInfo.reviewedBy || null,
          submittedAt: kycInfo.createdAt || null,
          raw: kycInfo
        } : buildPublicKycDetails(kycInfo)) : null,
        bookingsStats: bookingsStats,
        profileProgress: computeProfileProgress(obj, kycInfo),
        trade: (servicesMap[String(rawUserId)] || []).map(s => s.categoryId && s.categoryId.name).filter(Boolean),
        services: servicesMap[String(rawUserId)] || [],
      };
    });

    return reply.send({ success: true, data: out });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to search artisans' });
  }
}

export async function createArtisan(request, reply) {
  try {
    let payload = {};
    // If authenticated, prefer server-side user id to avoid spoofing
    const userId = (request.user && request.user.id);

    // Check Content-Type to determine how to handle the request
    const contentType = request.headers['content-type'] || '';
    const isMultipart = contentType.includes('multipart/form-data');

    // Handle file uploads if multipart/form-data is sent
    if (isMultipart && typeof request.parts === 'function') {
      // Stream parts directly to Cloudinary (like KYC does)
      const portfolioImages = [];
      for await (const part of request.parts()) {
        if (part.file) {
          try {
            const res = await new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                { folder: 'artisans/portfolio', resource_type: 'auto' },
                (err, result) => {
                  if (err) return reject(err);
                  resolve(result);
                }
              );
              part.file.pipe(uploadStream);
            });
            portfolioImages.push({
              url: res.secure_url || res.url,
              public_id: res.public_id,
              fieldName: part.fieldname || part.field
            });
          } catch (err) {
            request.log?.warn?.('cloudinary portfolio upload failed', err?.message || err);
          }
        } else if (part.value !== undefined) {
          // Handle non-file form fields
          try {
            const value = typeof part.value === 'string' && (part.value.startsWith('{') || part.value.startsWith('['))
              ? JSON.parse(part.value)
              : part.value;
            payload[part.fieldname || part.field] = value;
          } catch {
            payload[part.fieldname || part.field] = part.value;
          }
        }
      }

      // Add uploaded images to portfolio
      if (portfolioImages.length) {
        payload.portfolio = mergePortfolioUploads(payload.portfolio, portfolioImages);
      }
    } else {
      // JSON request - portfolio images should already be uploaded and URLs included
      payload = request.body || {};
    }

    // Set userId from authenticated user
    if (userId) payload.userId = userId;
    else if (payload.userId) payload.userId = payload.userId; // fallback to payload

    // Validate categories if provided
    if (payload.categories && Array.isArray(payload.categories) && payload.categories.length) {
      const JobCategory = (await import('../models/JobCategory.js')).default;
      const validCategories = await JobCategory.find({ _id: { $in: payload.categories } }).select('_id');
      if (validCategories.length !== payload.categories.length) {
        return reply.code(400).send({ success: false, message: 'One or more invalid category IDs' });
      }
    }

    const artisan = await Artisan.findOneAndUpdate(
      { userId: payload.userId },
      payload,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // ensure the user has artisan role
    try {
      if (payload.userId) {
        await User.findByIdAndUpdate(payload.userId, { role: 'artisan' });
        try {
          const user = await User.findById(payload.userId).lean();
          if (user) {
            await createNotification(request.server, user._id, {
              type: 'welcome',
              title: 'Welcome, Artisan!',
              body: `Hello ${user.name || 'there'}, your artisan profile has been created successfully.`,
              data: { sendEmail: true, email: user.email }
            });
          }
        } catch (notifErr) {
          request.log?.warn?.('artisan welcome notification failed', notifErr?.message || notifErr);
        }
      }
    } catch (err) {
      request.log?.warn?.('failed to set user role to artisan', err?.message || err);
    }

    return reply.code(201).send({ success: true, data: artisan });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(400).send({ success: false, message: err.message });
  }
}

export async function getArtisan(request, reply) {
  try {
    const artisan = await Artisan.findById(request.params.id);
    if (!artisan) return reply.code(404).send({ success: false, message: 'Not found' });
    // compute profile progress by checking KYC and profile fields
    let kycInfo = null;
    try {
      const Kyc = (await import('../models/Kyc.js')).default;
      const [latestKyc, approvedKyc, user] = await Promise.all([
        Kyc.findOne({ userId: artisan.userId }).sort({ createdAt: -1 }).lean(),
        Kyc.findOne({ userId: artisan.userId, status: 'approved' }).sort({ verifiedAt: -1, createdAt: -1 }).lean(),
        User.findById(artisan.userId).select('kycVerified isVerified').lean(),
      ]);
      kycInfo = chooseVisibleKycRecord({ latestKyc, approvedKyc, user, artisan });
    } catch (e) { request.log?.warn?.('getArtisan: failed to fetch kyc', e?.message || e); }

    const out = artisan.toObject ? artisan.toObject() : artisan;
    out.profileProgress = computeProfileProgress(out, kycInfo);
    out.kycDetails = buildPublicKycDetails(kycInfo);
    // include artisan services (ArtisanService.artisanId stores User._id)
    try {
      const services = await ArtisanService.find({ artisanId: artisan.userId, isActive: true }).populate('categoryId', 'name').populate('services.subCategoryId', 'name').lean();
      out.services = services || [];
    } catch (e) { request.log?.warn?.('getArtisan: failed to fetch services', e?.message || e); }
    return reply.send({ success: true, data: out });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to get artisan' });
  }
}

export async function getArtisanByUser(request, reply) {
  try {
    const userId = request.params.id;
    const artisan = await Artisan.findOne({ userId });
    if (!artisan) return reply.code(404).send({ success: false, message: 'Not found' });

    let kycInfo = null;
    try {
      const Kyc = (await import('../models/Kyc.js')).default;
      const [latestKyc, approvedKyc, user] = await Promise.all([
        Kyc.findOne({ userId: artisan.userId }).sort({ createdAt: -1 }).lean(),
        Kyc.findOne({ userId: artisan.userId, status: 'approved' }).sort({ verifiedAt: -1, createdAt: -1 }).lean(),
        User.findById(artisan.userId).select('kycVerified isVerified').lean(),
      ]);
      kycInfo = chooseVisibleKycRecord({ latestKyc, approvedKyc, user, artisan });
    } catch (e) { request.log?.warn?.('getArtisanByUser: failed to fetch kyc', e?.message || e); }

    const out = artisan.toObject ? artisan.toObject() : artisan;
    out.profileProgress = computeProfileProgress(out, kycInfo);
    out.kycDetails = buildPublicKycDetails(kycInfo);
    try {
      const services = await ArtisanService.find({ artisanId: artisan.userId, isActive: true }).populate('categoryId', 'name').populate('services.subCategoryId', 'name').lean();
      out.services = services || [];
    } catch (e) { request.log?.warn?.('getArtisanByUser: failed to fetch services', e?.message || e); }
    return reply.send({ success: true, data: out });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to get artisan by user' });
  }
}

export async function updateArtisan(request, reply) {
  try {
    const updates = request.body || {};
    // Prevent userId from being changed by clients
    if ('userId' in updates) delete updates.userId;
    const artisan = await Artisan.findByIdAndUpdate(request.params.id, updates, { new: true });
    if (!artisan) return reply.code(404).send({ success: false, message: 'Not found' });
    return reply.send({ success: true, data: artisan });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(400).send({ success: false, message: err.message });
  }
}

export async function updateMyArtisanProfile(request, reply) {
  try {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Unauthorized' });
    const existingArtisan = await Artisan.findOne({ userId }).lean();

    // Allowed fields artisans can update themselves
    const allowed = ['trade', 'categories', 'experience', 'certifications', 'bio', 'portfolio', 'serviceArea', 'pricing', 'availability'];
    let payload = {};
    const updates = {};

    // Check Content-Type to determine how to handle the request
    const contentType = request.headers['content-type'] || '';
    const isMultipart = contentType.includes('multipart/form-data');

    // Handle file uploads if multipart/form-data is sent
    if (isMultipart && typeof request.parts === 'function') {
      const portfolioImages = [];
      for await (const part of request.parts()) {
        if (part.file) {
          try {
            const res = await new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                { folder: 'artisans/portfolio', resource_type: 'auto' },
                (err, result) => {
                  if (err) return reject(err);
                  resolve(result);
                }
              );
              part.file.pipe(uploadStream);
            });
            portfolioImages.push({
              url: res.secure_url || res.url,
              public_id: res.public_id,
              fieldName: part.fieldname || part.field,
            });
          } catch (err) {
            request.log?.warn?.('cloudinary portfolio upload failed', err?.message || err);
          }
        } else if (part.value !== undefined) {
          try {
            const value = typeof part.value === 'string' && (part.value.startsWith('{') || part.value.startsWith('['))
              ? JSON.parse(part.value)
              : part.value;
            payload[part.fieldname || part.field] = value;
          } catch {
            payload[part.fieldname || part.field] = part.value;
          }
        }
      }

      // Add uploaded images to portfolio
      if (portfolioImages.length) {
        const basePortfolio = payload.portfolio || existingArtisan?.portfolio;
        payload.portfolio = mergePortfolioUploads(basePortfolio, portfolioImages);
      }
    } else {
      // JSON request
      payload = request.body || {};
    }

    for (const k of allowed) if (k in payload) updates[k] = payload[k];

    // Validate categories if being updated
    if (updates.categories && Array.isArray(updates.categories) && updates.categories.length) {
      const JobCategory = (await import('../models/JobCategory.js')).default;
      const validCategories = await JobCategory.find({ _id: { $in: updates.categories } }).select('_id');
      if (validCategories.length !== updates.categories.length) {
        return reply.code(400).send({ success: false, message: 'One or more invalid category IDs' });
      }
    }

    // Only admin may toggle verification flag
    if (request.user?.role === 'admin' && 'verified' in payload) updates.verified = !!payload.verified;

    // Find artisan document for this user
    const artisan = await Artisan.findOneAndUpdate({ userId }, updates, { new: true });
    if (!artisan) return reply.code(404).send({ success: false, message: 'Artisan profile not found for this user' });
    return reply.send({ success: true, data: artisan });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(400).send({ success: false, message: err.message });
  }
}

export async function verifyArtisan(request, reply) {
  try {
    const { id } = request.params;

    // Try to resolve id as either Artisan._id or as linked User._id
    let artisan = await Artisan.findById(id);
    if (!artisan) artisan = await Artisan.findOne({ userId: id });
    if (!artisan) return reply.code(404).send({ success: false, message: 'Artisan profile not found' });

    const userId = artisan.userId;
    if (!userId) return reply.code(400).send({ success: false, message: 'Artisan profile has no associated user' });

    // Update artisan verified status
    artisan.verified = true;
    await artisan.save();

    // Load the linked User document so we can update verification flags and notify
    const user = await User.findById(userId);
    if (user) {
      user.isVerified = true;
      user.kycVerified = true;
      await user.save();

      // Send notification and email
      try {
        await createNotification(request.server, userId, {
          type: 'verification',
          title: 'Artisan Profile Verified',
          body: 'Congratulations! Your artisan profile has been verified. You can now be discovered by clients.',
          data: {
            artisanId: artisan._id,
            verified: true,
            sendEmail: true,
            email: user.email
          }
        });
      } catch (notifErr) {
        request.log?.warn?.('Failed to send verification notification', notifErr?.message);
      }
    }

    return reply.send({
      success: true,
      message: 'Artisan verified successfully',
      data: {
        artisan: { _id: artisan._id, verified: artisan.verified },
        user: user ? { _id: user._id, isVerified: user.isVerified, kycVerified: user.kycVerified } : null
      }
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to verify artisan' });
  }
}

export async function unverifyArtisan(request, reply) {
  try {
    const { id } = request.params;

    // Try to resolve id as either Artisan._id or as linked User._id
    let artisan = await Artisan.findById(id);
    if (!artisan) artisan = await Artisan.findOne({ userId: id });
    if (!artisan) return reply.code(404).send({ success: false, message: 'Artisan profile not found' });

    const userId = artisan.userId;
    if (!userId) return reply.code(400).send({ success: false, message: 'Artisan profile has no associated user' });

    // Update artisan verified status to false
    artisan.verified = false;
    await artisan.save();

    // Update user isVerified and kycVerified status to false
    const user = await User.findById(userId);
    if (user) {
      user.isVerified = false;
      user.kycVerified = false;
      await user.save();

      // Send notification and email
      try {
        await createNotification(request.server, userId, {
          type: 'verification',
          title: 'Artisan Verification Revoked',
          body: 'Your artisan profile verification has been revoked. Please contact support for more information.',
          data: {
            artisanId: artisan._id,
            verified: false,
            sendEmail: true,
            email: user.email
          }
        });
      } catch (notifErr) {
        request.log?.warn?.('Failed to send unverification notification', notifErr?.message || notifErr);
      }
    }

    return reply.send({
      success: true,
      message: 'Artisan verification revoked successfully',
      data: {
        artisan: { _id: artisan._id, verified: artisan.verified },
        user: user ? { _id: user._id, isVerified: user.isVerified, kycVerified: user.kycVerified } : null
      }
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to unverify artisan' });
  }
}
