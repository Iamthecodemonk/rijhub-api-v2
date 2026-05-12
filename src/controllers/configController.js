import Config from '../models/Config.js';
import { getConfig, setConfig } from '../utils/config.js';

export async function listConfigs(request, reply) {
  try {
    const docs = await Config.find({}).lean();
    return reply.send({ success: true, data: docs });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list configs' });
  }
}

export async function getConfigByKey(request, reply) {
  try {
    const key = request.params.key;
    const val = await getConfig(key);
    if (val === null) return reply.code(404).send({ success: false, message: 'Not found' });
    return reply.send({ success: true, data: { key, value: val } });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to get config' });
  }
}

export async function upsertConfig(request, reply) {
  try {
    const rawKey = request.params.key || '';
    const { value, type, description } = request.body || {};
    if (value === undefined) return reply.code(400).send({ success: false, message: 'value required' });
    // Normalize key to avoid duplicates differing only by case/whitespace
    const normalize = k => String(k || '').trim();
    const normalizedKey = normalize(rawKey).toUpperCase();

    // Try to find an existing config case-insensitively. If found, reuse its stored key to avoid duplicates.
    const existing = await Config.findOne({ key: { $regex: `^${normalizedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
    const targetKey = existing ? existing.key : normalizedKey;

    let parsed;
    // Special validation for COMPANY_FEE_PCT: must be a number between 0 and 100 (percent)
    if (String(targetKey).toUpperCase() === 'COMPANY_FEE_PCT') {
      const n = Number(value);
      if (isNaN(n) || n < 0 || n > 100) return reply.code(400).send({ success: false, message: 'COMPANY_FEE_PCT must be a number between 0 and 100' });
      parsed = n;
      // force type to number for storage
      const updated = await setConfig(targetKey, parsed, { type: 'number', description: description || 'Platform/company fee percent', updatedBy: request.user?.id });
      return reply.send({ success: true, data: { key: targetKey, value: updated } });
    }

    parsed = type === 'number' ? Number(value) : (type === 'json' ? value : String(value));
    const updated = await setConfig(targetKey, parsed, { type, description, updatedBy: request.user?.id });
    return reply.send({ success: true, data: { key: targetKey, value: updated } });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to upsert config' });
  }
}
