import { FastifyPluginAsync } from 'fastify';
import { checkDbHealth } from '../db/index.js';
import { checkRedisHealth } from '../db/redis.js';
import { modelRegistryService } from '../services/model-registry.service.js';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
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

    reply.status(statusCode).send({
      status: isHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      gateway: {
        status: 'healthy',
        uptime_seconds: Math.floor(process.uptime()),
        memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      postgres: dbHealth,
      redis: redisHealth,
      upstreams: upstreamsHealth,
    });
  });
};
