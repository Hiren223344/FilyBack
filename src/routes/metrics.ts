import { FastifyPluginAsync } from 'fastify';
import { getPrometheusMetrics, getMetricsContentType } from '../services/metrics.service.js';

export const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /metrics - Prometheus scraping endpoint
   */
  fastify.get('/metrics', async (_req, reply) => {
    const data = await getPrometheusMetrics();
    reply.header('Content-Type', getMetricsContentType());
    reply.send(data);
  });
};
