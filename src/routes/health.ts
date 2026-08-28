import { FastifyPluginAsync } from 'fastify';
import { checkDbHealth } from '../db/index.js';
import { checkRedisHealth } from '../db/redis.js';
import { modelRegistryService } from '../services/model-registry.service.js';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET / - Welcome & API Gateway root status
   */
  fastify.get('/', async (_req, reply) => {
    reply.send({
      name: 'FilyBase Inference Gateway',
      status: 'online',
      version: '1.0.0',
      health: '/healthz',
      endpoints: {
        chat: '/v1/chat/completions',
        completions: '/v1/completions',
        images: '/v1/images/generations',
        audio: '/v1/audio/transcriptions',
        embeddings: '/v1/embeddings',
        models: '/v1/models',
      },
    });
  });

  /**
   * GET /healthz - Comprehensive passive health check
   */
  fastify.get('/healthz', async (_req, reply) => {
    const [dbHealth, redisHealth, upstreamsHealth] = await Promise.all([
      checkDbHealth(),
      checkRedisHealth(),
      modelRegistryService.checkUpstreamHealth(),
    ]);

    const isHealthy =
      dbHealth.status === 'healthy' &&
      redisHealth.status === 'healthy';

    const statusCode = isHealthy ? 200 : 503;

    // Never expose internal upstream URLs / IPs in a publicly reachable endpoint.
    const upstreams: Record<string, { status: string; engine: string; latencyMs: number }> = {};
    for (const [id, info] of Object.entries(upstreamsHealth)) {
      upstreams[id] = { status: info.status, engine: info.engine, latencyMs: info.latencyMs };
    }

    reply.status(statusCode).send({
      status: isHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      gateway: {
        status: 'healthy',
        uptime_seconds: Math.floor(process.uptime()),
        memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      postgres: { status: dbHealth.status, latencyMs: dbHealth.latencyMs },
      redis: { status: redisHealth.status, latencyMs: redisHealth.latencyMs },
      upstreams,
    });
  });
};
