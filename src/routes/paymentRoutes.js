import { createPayment, verifyPayment, listPayments, paymentWebhook, initializePaystackTransaction, reconcilePendingQuoteTransactions, getPaystackBanks, resolvePaystackAccount, paystackCallback, getCompanyCommission } from '../controllers/paymentController.js';
import { verifyJWT } from '../middlewares/auth.js';
import { requireRole } from '../middlewares/roles.js';

export default async function paymentRoutes(fastify, opts) {
  const createPaymentSchema = {
    body: {
      type: 'object',
      required: ['amount', 'currency'],
      properties: {
        amount: { type: 'number', minimum: 0 },
        currency: { type: 'string' },
        method: { type: 'string' },
        metadata: { type: 'object' },
      },
    },
  };

  const verifySchema = {
    body: {
      type: 'object',
      required: ['reference'],
      properties: {
        reference: { type: 'string' },
        status: { type: 'string' },
      },
    },
  };

  const listQuery = { querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } } } };
  const commissionQuery = { querystring: { type: 'object', properties: { amount: { type: 'number', minimum: 0 } } } };

    fastify.post('/', { preHandler: verifyJWT, schema: createPaymentSchema }, createPayment);
    fastify.post('/verify', { preHandler: verifyJWT, schema: verifySchema }, verifyPayment);
    // webhook from payment gateway (public endpoint; validate signature in production)
    fastify.post('/webhook', { bodyLimit: 1048576, config: { rawBody: true }, preHandler: async (req, reply) => { /* rawBody plugin requires runFirst true; nothing to do here */ } }, paymentWebhook);
      // Admin reconciliation endpoint for pending quote transactions
      fastify.post('/reconcile/pending-quotes', { preHandler: [verifyJWT, requireRole('admin')] }, reconcilePendingQuoteTransactions);
    // initialize Paystack transaction (server-side)
    fastify.post('/initialize', { preHandler: verifyJWT }, initializePaystackTransaction);
    fastify.get('/callback', paystackCallback);
    fastify.get('/commission', { preHandler: verifyJWT, schema: commissionQuery }, getCompanyCommission);
    fastify.get('/', { preHandler: verifyJWT, schema: listQuery }, listPayments);
    // Paystack helpers: list banks and resolve account name
    fastify.get('/banks', { preHandler: verifyJWT }, getPaystackBanks);
    fastify.get('/banks/resolve', { preHandler: verifyJWT }, resolvePaystackAccount);
}
