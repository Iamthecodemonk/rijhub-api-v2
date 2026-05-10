/**import { submitKyc, getKycStatus, deleteKycFile } from '../controllers/kycController.js';
import { verifyJWT } from '../middlewares/auth.js';

export default async function kycRoutes(fastify, opts) {
  // multipart handled by fastify-multipart; upload middleware is a lightweight wrapper
  // Do not attach a strict JSON schema here because the endpoint accepts
  // multipart/form-data (files + fields). Fastify's schema validation will
  // reject multipart bodies as "body must be object". The controller
  // handles parsing/validation for multipart requests.
  fastify.post('/submit', { preHandler: [verifyJWT, (request, reply) => import('../middlewares/cloudinaryStream.js').then(m => m.default(request, reply))] }, submitKyc);
  fastify.get('/status', { preHandler: verifyJWT }, getKycStatus);
  fastify.delete('/:id/file', { preHandler: verifyJWT }, deleteKycFile);
}*/

import { submitKyc, getKycStatus, getArtisanKycStatus, deleteKycFile } from '../controllers/kycController.js';
import { optionalJWT, verifyJWT } from '../middlewares/auth.js';

export default async function kycRoutes(fastify, opts) {
  // multipart handled by fastify-multipart; the controller streams parts
  // directly to Cloudinary (same approach as artisan uploads). Do not
  // attach a strict JSON schema here because multipart bodies are used.
  fastify.post('/submit', { preHandler: [verifyJWT] }, submitKyc);
  fastify.get('/status', { preHandler: verifyJWT }, getKycStatus);
  fastify.get('/artisan/:id/status', { preHandler: optionalJWT }, getArtisanKycStatus);
  fastify.delete('/:id/file', { preHandler: verifyJWT }, deleteKycFile);
}
