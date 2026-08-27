import { FastifyPluginAsync } from 'fastify';
import { requireApiKey } from '../../middleware/auth.middleware.js';
import { inferencePipelineService } from '../../services/inference-pipeline.service.js';
import { proxyService } from '../../services/proxy.service.js';
import { HEADERS } from '../../config/constants.js';

export const completionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/completions',
    {
      preHandler: [requireApiKey],
    },
    async (req, reply) => {
      const body = req.body as Record<string, unknown>;

      if (!body || typeof body !== 'object' || !body['model'] || !body['prompt']) {
        reply.status(400).send({
          error: {
            message: 'Missing required parameters: "model" and "prompt" must be provided.',
            type: 'invalid_request_error',
            param: !body?.['model'] ? 'model' : 'prompt',
            code: 'invalid_request_error',
          },
        });
        return;
      }

      const modelId = String(body['model']);
      const isStream = Boolean(body['stream']);

      const ctx = await inferencePipelineService.prepare(
        req,
        reply,
        'completion',
        modelId,
        body
      );

      if (!ctx) return;

      if (isStream) {
        const streamRes = await proxyService.proxyStreaming(
          req,
          reply,
          ctx.model,
          '/completions',
          body
        );

        await inferencePipelineService.finalize(req, ctx, {
          statusCode: streamRes.statusCode,
          usage: {
            inTokens: streamRes.usage.prompt_tokens,
            outTokens: streamRes.usage.completion_tokens,
          },
          latencyMs: streamRes.latencyMs,
          ttftMs: streamRes.ttftMs,
          isStream: true,
        });
      } else {
        const nonStreamRes = await proxyService.proxyNonStreaming(
          req,
          ctx.model,
          '/completions',
          body
        );

        const actualCredits = await inferencePipelineService.finalize(req, ctx, {
          statusCode: nonStreamRes.statusCode,
          usage: {
            inTokens: nonStreamRes.usage.prompt_tokens,
            outTokens: nonStreamRes.usage.completion_tokens,
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
    }
  );
};
