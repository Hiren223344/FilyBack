import { FastifyPluginAsync } from 'fastify';
import { requireApiKey } from '../../middleware/auth.middleware.js';
import { inferencePipelineService } from '../../services/inference-pipeline.service.js';
import { proxyService } from '../../services/proxy.service.js';
import { HEADERS } from '../../config/constants.js';

export const audioRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/audio/transcriptions',
    {
      preHandler: [requireApiKey],
    },
    async (req, reply) => {
      if (!req.isMultipart()) {
        reply.status(400).send({
          error: {
            message: 'Invalid request: multipart/form-data Content-Type required.',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request_error',
          },
        });
        return;
      }

      const parts = req.parts();
      let fileBuffer: Buffer | null = null;
      let fileName = 'audio.wav';
      let mimeType = 'audio/wav';
      let modelId = 'whisper-large-v3';
      const fields: Record<string, string> = {};

      for await (const part of parts) {
        if (part.type === 'file') {
          fileBuffer = await part.toBuffer();
          fileName = part.filename || 'audio.wav';
          mimeType = part.mimetype || 'audio/wav';
        } else {
          fields[part.fieldname] = String(part.value);
          if (part.fieldname === 'model' && part.value) {
            modelId = String(part.value);
          }
        }
      }

      if (!fileBuffer || fileBuffer.length === 0) {
        reply.status(400).send({
          error: {
            message: 'Missing required file: "file" multipart field is required.',
            type: 'invalid_request_error',
            param: 'file',
            code: 'invalid_request_error',
          },
        });
        return;
      }

      // Estimate audio duration based on bytes
      const estimatedAudioSec = Math.max(5, Math.ceil(fileBuffer.length / 16000));

      const ctx = await inferencePipelineService.prepare(
        req,
        reply,
        'audio',
        modelId,
        { ...fields, audio_sec: estimatedAudioSec }
      );

      if (!ctx) return;

      const audioRes = await proxyService.proxyAudioTranscription(
        req,
        ctx.model,
        fileBuffer,
        fileName,
        mimeType,
        fields
      );

      const actualCredits = await inferencePipelineService.finalize(req, ctx, {
        statusCode: audioRes.statusCode,
        usage: {
          audioSec: audioRes.audioSec,
        },
        latencyMs: audioRes.latencyMs,
        isStream: false,
      });

      reply.header(HEADERS.REQUEST_ID, req.requestId);
      reply.header(HEADERS.MODEL, ctx.model.id);
      reply.header(HEADERS.LATENCY_MS, audioRes.latencyMs);
      reply.header(HEADERS.CREDITS_USED, actualCredits);

      reply.status(audioRes.statusCode).send(audioRes.data);
    }
  );
};
