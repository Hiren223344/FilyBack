import { FastifyPluginAsync } from 'fastify';
import { requireApiKey } from '../../middleware/auth.middleware.js';
import { inferencePipelineService } from '../../services/inference-pipeline.service.js';
import { proxyService } from '../../services/proxy.service.js';
import { HEADERS } from '../../config/constants.js';

export const embeddingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/embeddings',
    {
      preHandler: [requireApiKey],
    },
    async (req, reply) => {
      const body = req.body as Record<string, unknown>;

      if (!body || typeof body !== 'object' || !body['model'] || !body['input']) {
        reply.status(400).send({
          error: {
            message: 'Missing required parameters: "model" and "input" must be provided.',
            type: 'invalid_request_error',
            param: !body?.['model'] ? 'model' : 'input',
            code: 'invalid_request_error',
          },
        });
        return;
      }

      const modelId = String(body['model']);

      const ctx = await inferencePipelineService.prepare(
        req,
        reply,
        'embedding',
        modelId,
        body
      );

      if (!ctx) return;

      const nonStreamRes = await proxyService.proxyNonStreaming(
        req,
        ctx.model,
        '/embeddings',
        body
      );

      const actualCredits = await inferencePipelineService.finalize(req, ctx, {
        statusCode: nonStreamRes.statusCode,
        usage: {
          inTokens: nonStreamRes.usage.prompt_tokens,
          outTokens: 0,
        },
        latencyMs: nonStreamRes.latencyMs,
        isStream: false,
      });

      reply.header(HEADERS.REQUEST_ID, req.requestId);
      reply.header(HEADERS.MODEL, ctx.model.id);
      reply.header(HEADERS.LATENCY_MS, nonStreamRes.latencyMs);
      reply.header(HEADERS.CREDITS_USED, actualCredits);

      reply.status(nonStreamRes.statusCode).send(nonStreamRes.data);
    }
  );
};
