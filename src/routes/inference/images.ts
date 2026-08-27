import { FastifyPluginAsync } from 'fastify';
import { requireApiKey } from '../../middleware/auth.middleware.js';
import { inferencePipelineService } from '../../services/inference-pipeline.service.js';
import { proxyService } from '../../services/proxy.service.js';
import { HEADERS } from '../../config/constants.js';

export const imagesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/images/generations',
    {
      preHandler: [requireApiKey],
    },
    async (req, reply) => {
      const body = req.body as Record<string, unknown>;

      if (!body || typeof body !== 'object' || !body['prompt']) {
        reply.status(400).send({
          error: {
            message: 'Missing required parameter: "prompt" must be provided.',
            type: 'invalid_request_error',
            param: 'prompt',
            code: 'invalid_request_error',
          },
        });
        return;
      }

      // Default to stable-diffusion-3.5 if omitted
      const modelId = String(body['model'] || 'stable-diffusion-3.5');

      const ctx = await inferencePipelineService.prepare(
        req,
        reply,
        'image',
        modelId,
        body
      );

      if (!ctx) return;

      const imgRes = await proxyService.proxyImageGeneration(
        req,
        ctx.model,
        body
      );

      const actualCredits = await inferencePipelineService.finalize(req, ctx, {
        statusCode: imgRes.statusCode,
        usage: {
          images: imgRes.imagesCount,
        },
        latencyMs: imgRes.latencyMs,
        isStream: false,
      });

      reply.header(HEADERS.REQUEST_ID, req.requestId);
      reply.header(HEADERS.MODEL, ctx.model.id);
      reply.header(HEADERS.LATENCY_MS, imgRes.latencyMs);
      reply.header(HEADERS.CREDITS_USED, actualCredits);

      reply.status(imgRes.statusCode).send(imgRes.data);
    }
  );
};
