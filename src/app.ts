import crypto from 'node:crypto';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';

// Route imports
import { chatRoutes } from './routes/inference/chat.js';
import { completionsRoutes } from './routes/inference/completions.js';
import { imagesRoutes } from './routes/inference/images.js';
import { audioRoutes } from './routes/inference/audio.js';
import { embeddingsRoutes } from './routes/inference/embeddings.js';

import { dashboardAuthRoutes } from './routes/dashboard/auth.js';
import { modelsRoutes } from './routes/dashboard/models.js';
import { endpointsRoutes } from './routes/dashboard/endpoints.js';
import { keysRoutes } from './routes/dashboard/keys.js';
import { usageRoutes } from './routes/dashboard/usage.js';
import { billingRoutes } from './routes/dashboard/billing.js';

import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
    bodyLimit: env.MAX_REQUEST_BODY_SIZE_BYTES,
    trustProxy: true,
  });

  // Attach Request ID and Start Time
  app.addHook('onRequest', async (req) => {
    req.requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    req.startTime = Date.now();
  });

  // CORS configuration
  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Accept',
      'X-Requested-With',
      'x-filybase-request-id',
      'Idempotency-Key',
    ],
    exposedHeaders: [
      'x-filybase-request-id',
      'x-filybase-model',
      'x-filybase-latency-ms',
      'x-filybase-ttft-ms',
      'x-filybase-credits-used',
      'x-ratelimit-limit-requests',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-reset-requests',
      'x-ratelimit-limit-tokens',
      'x-ratelimit-remaining-tokens',
      'x-ratelimit-reset-tokens',
      'retry-after',
    ],
  });

  // Cookie plugin for refresh tokens
  await app.register(cookie, {
    secret: env.COOKIE_SECRET,
  });

  // Multipart plugin for Whisper audio file uploads
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_AUDIO_BODY_SIZE_BYTES,
      files: 1,
    },
  });

  // Custom error handler
  app.setErrorHandler(errorHandler);

  // Register Inference routes (/v1/...)
  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(completionsRoutes, { prefix: '/v1' });
  await app.register(imagesRoutes, { prefix: '/v1' });
  await app.register(audioRoutes, { prefix: '/v1' });
  await app.register(embeddingsRoutes, { prefix: '/v1' });

  // Register Dashboard routes (/v1/...)
  await app.register(dashboardAuthRoutes, { prefix: '/v1' });
  await app.register(modelsRoutes, { prefix: '/v1' });
  await app.register(endpointsRoutes, { prefix: '/v1' });
  await app.register(keysRoutes, { prefix: '/v1' });
  await app.register(usageRoutes, { prefix: '/v1' });
  await app.register(billingRoutes, { prefix: '/v1' });

  // Register Health and Metrics (root path)
  await app.register(healthRoutes);
  await app.register(metricsRoutes);

  return app;
}
