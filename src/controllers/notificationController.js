import Notification from '../models/Notification.js';

export async function listNotifications(request, reply) {
  try {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });

    const { page = 1, limit = 20, unread } = request.query || {};
    const q = { userId };
    if (unread === 'true') q.read = false;

    const total = await Notification.countDocuments(q);
    const notifs = await Notification.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit));
    request.log?.info?.({
      userId,
      unread,
      page: Number(page),
      limit: Number(limit),
      total,
      returned: notifs.length,
      firstNotificationId: notifs[0]?._id ? String(notifs[0]._id) : null,
    }, 'notifications:list:result');
    return reply.send({
      success: true,
      data: notifs,
      notifications: notifs,
      meta: { page: Number(page), limit: Number(limit), total },
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to list notifications' });
  }
}

export async function getNotificationsCount(request, reply) {
  try {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
    const unreadOnly = request.query?.unread === 'true';
    const q = { userId };
    if (unreadOnly) q.read = false;
    const count = await Notification.countDocuments(q);
    request.log?.info?.({ userId, unreadOnly, count }, 'notifications:count:result');
    return reply.send({ success: true, count });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to get notification count' });
  }
}

export async function getNotification(request, reply) {
  try {
    const userId = request.user?.id;
    const id = request.params.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
    const n = await Notification.findById(id);
    if (!n) return reply.code(404).send({ success: false, message: 'Not found' });
    if (String(n.userId) !== String(userId) && request.user?.role !== 'admin') return reply.code(403).send({ success: false, message: 'Forbidden' });
    return reply.send({ success: true, data: n });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to fetch notification' });
  }
}

export async function markRead(request, reply) {
  try {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
    const ids = request.body?.ids || [];
    if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ success: false, message: 'ids array required' });
    const res = await Notification.updateMany({ _id: { $in: ids }, userId }, { $set: { read: true } });
    return reply.send({ success: true, modifiedCount: res.modifiedCount });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to mark notifications' });
  }
}

export async function markAllRead(request, reply) {
  try {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
    const res = await Notification.updateMany({ userId, read: false }, { $set: { read: true } });
    return reply.send({ success: true, modifiedCount: res.modifiedCount });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to mark notifications' });
  }
}

export async function deleteNotification(request, reply) {
  try {
    const userId = request.user?.id;
    const id = request.params.id;
    if (!userId) return reply.code(401).send({ success: false, message: 'Authentication required' });
    const n = await Notification.findById(id);
    if (!n) return reply.code(404).send({ success: false, message: 'Not found' });
    if (String(n.userId) !== String(userId) && request.user?.role !== 'admin') return reply.code(403).send({ success: false, message: 'Forbidden' });
    await Notification.deleteOne({ _id: id });
    return reply.send({ success: true });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to delete notification' });
  }
}

// Create a notification (admin or internal services can call)
export async function createNotificationEndpoint(request, reply) {
  try {
    // Require authentication for now
    const caller = request.user?.id;
    if (!caller) return reply.code(401).send({ success: false, message: 'Authentication required' });

    const { toUserId, title, body, payload } = request.body || {};
    if (!toUserId || !title || !body) return reply.code(400).send({ success: false, message: 'toUserId, title and body required' });

    const fastify = request.server;
    const { createNotification } = await import('../utils/notifier.js');
    const n = await createNotification(fastify, toUserId, { type: 'custom', title, body, data: payload || {} });
    return reply.code(201).send({ success: true, data: n });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ success: false, message: 'Failed to create notification' });
  }
}

export default { listNotifications, getNotification, markRead, markAllRead, deleteNotification };
