import { dojahWebhook, getDojahConfig, startDojahSdkSession, verifyDojahReference, verifyNinSelfie } from '../controllers/dojahKycController.js';
import { verifyJWT } from '../middlewares/auth.js';

export default async function dojahKycRoutes(fastify, opts) {
  fastify.get('/config', { preHandler: verifyJWT }, getDojahConfig);
  fastify.post('/start-session', { preHandler: verifyJWT }, startDojahSdkSession);
  fastify.post('/verify-reference', { preHandler: verifyJWT }, verifyDojahReference);
  fastify.post('/webhook', { bodyLimit: 1048576, config: { rawBody: true } }, dojahWebhook);

  // Accepts JSON base64 selfieImage or multipart with a selfie/selfieImage file field.
  fastify.post('/nin-selfie', { preHandler: verifyJWT, bodyLimit: 15 * 1024 * 1024 }, verifyNinSelfie);
}
