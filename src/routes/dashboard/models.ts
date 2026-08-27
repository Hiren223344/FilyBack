import { FastifyPluginAsync } from 'fastify';
import { modelRegistryService } from '../../services/model-registry.service.js';

export const modelsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /v1/models
   */
  fastify.get('/models', async (_req, reply) => {
    const models = await modelRegistryService.listModels();
    reply.send(models);
  });
};
