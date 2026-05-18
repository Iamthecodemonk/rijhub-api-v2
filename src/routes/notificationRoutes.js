import { listNotifications, getNotification, markRead, markAllRead, deleteNotification, getNotificationsCount } from '../controllers/notificationController.js';
import { createNotificationEndpoint } from '../controllers/notificationController.js';
import { verifyJWT } from '../middlewares/auth.js';

export default async function notificationRoutes(fastify, opts) {
  const idParams = { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } };
  const listQuery = { querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, unread: { type: 'string' } } } };

  // list notifications for authenticated user
  fastify.get('/', { preHandler: verifyJWT, schema: listQuery }, listNotifications);
  // count notifications (place before :id so 'count' isn't treated as an id)
  fastify.get('/count', { preHandler: verifyJWT }, getNotificationsCount);
  fastify.get('/unread-count', { preHandler: verifyJWT }, async (request, reply) => {
    request.query = { ...(request.query || {}), unread: 'true' };
    return getNotificationsCount(request, reply);
  });
  // bulk mark as read
  fastify.post('/mark-read', { preHandler: verifyJWT }, markRead);
  // mark all read
  fastify.post('/mark-all-read', { preHandler: verifyJWT }, markAllRead);
  // create notification (internal/admin)
  fastify.post('/', { preHandler: verifyJWT }, createNotificationEndpoint);
  // get single notification
  fastify.get('/:id', { preHandler: verifyJWT, schema: idParams }, getNotification);
  // delete notification
  fastify.delete('/:id', { preHandler: verifyJWT, schema: idParams }, deleteNotification);
}
