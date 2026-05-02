import mongoose from 'mongoose';
import fastifyCors from '@fastify/cors';
import jwtPlugin from './plugins/jwt.js';
import fastifyMultipart from '@fastify/multipart';
import fastifyRawBody from 'fastify-raw-body';
// import cors from "cors";

import connectDB from './config/db.js';
import { migrateEnvToDb } from './utils/config.js';
import fs from 'fs/promises';
import authRoutes from './routes/authRoutes.js';
import artisanRoutes from './routes/artisanRoutes.js';
import bookingRoutes from './routes/bookingRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import socketPlugin from './plugins/socket.js';
import swaggerPlugin from './plugins/swagger.js';
import kycRoutes from './routes/kycRoutes.js';
import dojahKycRoutes from './routes/dojahKycRoutes.js';
import locationsRoutes from './routes/locationsRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import reviewRoutes from './routes/reviewRoutes.js';
import usersRoutes from './routes/users.js';  
import { startAutoCancel } from './utils/autoCancel.js';
import jobRoutes from './routes/jobRoutes.js';
import jobCategoryRoutes from './routes/jobCategoryRoutes.js';
import jobSubCategoryRoutes from './routes/jobSubCategoryRoutes.js';
import artisanServiceRoutes from './routes/artisanServiceRoutes.js';
import adRoutes from './routes/adRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import deviceRoutes from './routes/deviceRoutes.js';
import transactionRoutes from './routes/transactionRoutes.js';
import supportRoutes from './routes/supportRoutes.js';
import specialServiceRequestRoutes from './routes/specialServiceRequestRoutes.js';

export default async function app(fastify, opts) {
  // Normalize environment secrets that may be wrapped in quotes by .env tools
  const normalizeEnv = (key) => {
    if (!process.env[key]) return;
    let v = process.env[key];
    // Trim whitespace
    v = v.trim();
    // Remove wrapping single or double quotes if present
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[key] = v;
  };
  normalizeEnv('JWT_SECRET');
  normalizeEnv('SENDCHAMP_API_KEY');
  normalizeEnv('SENDCHAMP_DEFAULT_SENDER');
  normalizeEnv('PAYSTACK_SECRET_KEY');
  normalizeEnv('PAYSTACK_WEBHOOK_SECRET');
  normalizeEnv('DOJAH_BASE_URL');
  normalizeEnv('DOJAH_APP_ID');
  normalizeEnv('DOJAH_SECRET_KEY');
  // Connect MongoDB (don't block app startup if DB is slow/unreachable)
  // connectDB will log and exit on fatal errors; here we start it but don't await
  connectDB()
  .then(async () => {
    fastify.log.info('MongoDB connection initiated');
    try {
      await migrateEnvToDb(fastify);
    } catch (e) {
      fastify.log?.warn?.('migrateEnvToDb error', e?.message || e);
    }
  }).catch(err => fastify.log.error(err));

  // Register plugins
  await fastify.register(fastifyCors, { 
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS','PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'] });
  await fastify.register(jwtPlugin);
  await fastify.register(fastifyMultipart,{
    limits: { fileSize: 15 * 1024 * 1024 }, // 5MB file size limit
  });
  // Register raw body parser so webhooks (Paystack) can validate signatures against raw payload
  await fastify.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  // Register socket.io plugin (requires fastify-jwt to be available)
  await fastify.register(socketPlugin);
  // Register swagger plugin only when enabled. Set `SWAGGER_ENABLED=false` to disable.
  if (process.env.SWAGGER_ENABLED && process.env.SWAGGER_ENABLED.toLowerCase() === 'false') {
    fastify.log?.info?.('Swagger documentation disabled (SWAGGER_ENABLED=false)');
  } else {
    await fastify.register(swaggerPlugin);
  }

  // Register routes
  // fastify.register(authRoutes, { prefix: 'api/auth' });
  // fastify.register(artisanRoutes, { prefix: 'api/artisans' });
  // fastify.register(bookingRoutes, { prefix: 'api/bookings' });
  // fastify.register(chatRoutes, { prefix: 'api/chat' });
  // fastify.register(kycRoutes, { prefix: 'api/kyc' });
  // fastify.register(locationsRoutes, { prefix: 'api/locations' });
  // fastify.register(walletRoutes, { prefix: 'api/wallet' });
  // fastify.register(paymentRoutes, { prefix: 'api/payments' });
  // fastify.register(reviewRoutes, { prefix: 'api/reviews' });
  // fastify.register(adminRoutes, { prefix: 'api/admin' });
  // fastify.register(usersRoutes, { prefix: 'api/users' });
  // fastify.register(jobRoutes, { prefix: 'api/jobs' });
  fastify.register(authRoutes, { prefix: '/api/auth' });
  fastify.register(artisanRoutes, { prefix: '/api/artisans' });
  fastify.register(bookingRoutes, { prefix: '/api/bookings' });
  fastify.register(chatRoutes, { prefix: '/api/chat' });
  fastify.register(kycRoutes, { prefix: '/api/kyc' });
  fastify.register(dojahKycRoutes, { prefix: '/api/kyc/dojah' });
  fastify.register(locationsRoutes, { prefix: '/api/locations' });
  fastify.register(walletRoutes, { prefix: '/api/wallet' });
  fastify.register(paymentRoutes, { prefix: '/api/payments' });
  fastify.register(reviewRoutes, { prefix: '/api/reviews' });
  fastify.register(adminRoutes, { prefix: '/api/admin' });
  fastify.register(usersRoutes, { prefix: '/api/users' });
  fastify.register(jobRoutes, { prefix: '/api/jobs' });
  fastify.register(jobCategoryRoutes, { prefix: '/api/job-categories' });
  fastify.register(jobSubCategoryRoutes, { prefix: '/api/job-subcategories' });
  // Artisan services (artisan selects category + subcategories with prices)
  fastify.register(artisanServiceRoutes, { prefix: '/api/artisan-services' });
  // Notifications
  fastify.register(notificationRoutes, { prefix: '/api/notifications' });
  // Device token registration for push notifications
  fastify.register(deviceRoutes, { prefix: '/api/devices' });
  // Transactions
  fastify.register(transactionRoutes, { prefix: '/api/transactions' });
  // Ads / announcements
  fastify.register(adRoutes, { prefix: '/api/ads' });
  // Expose under announcements as well: /api/announcements/ads
  fastify.register(adRoutes, { prefix: '/api/announcements/ads' });

  // Support chat
  fastify.register(supportRoutes, { prefix: '/api/support' });

  // Special service requests (clients create, artisans respond)
  fastify.register(specialServiceRequestRoutes, { prefix: '/api/special-service-requests' });

  // Serve project API documentation (Markdown)
  fastify.get('/docs', async (request, reply) => {
    try {
      const md = await fs.readFile(new URL('../API_DOCS.md', import.meta.url), 'utf8');
      reply.header('Content-Type', 'text/markdown; charset=utf-8').send(md);
    } catch (err) {
      fastify.log.error({ err }, 'Failed to read API_DOCS.md');
      reply.code(500).send({ error: 'API docs not available' });
    }
  });

  // Start background auto-cancel job (unpaid bookings)
  try {
    startAutoCancel(fastify);
  } catch (err) {
    fastify.log?.error?.('failed to start auto-cancel', err);
  }
}
