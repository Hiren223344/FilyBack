import crypto from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { modelRegistryService } from './model-registry.service.js';
import { rateLimiterService } from '../redis/rate-limiter.service.js';
import { semaphoreService } from '../redis/semaphore.service.js';
import { creditsService } from '../redis/credits.service.js';
import { usageAggregatorService } from './usage-aggregator.service.js';
import { metrics } from './metrics.service.js';
import { HEADERS } from '../config/constants.js';
import { Model } from '../types/db.types.js';

export type InferenceCategory = 'chat' | 'completion' | 'image' | 'audio' | 'embedding';

export interface PreparedInferenceContext {
  model: Model;
  reserveId: string;
  estimatedCredits: number;
}

export class InferencePipelineService {
  /**
   * Pre-inference execution pipeline:
   * 1. Model Resolution
   * 2. Token-Bucket Rate Limiting (RPM + TPM)
   * 3. Admission Control Concurrency Semaphore
   * 4. Atomic Credit Reservation
   */
  async prepare(
    req: FastifyRequest,
    reply: FastifyReply,
    category: InferenceCategory,
    requestedModelId: string,
    body: Record<string, unknown>
  ): Promise<PreparedInferenceContext | null> {
    const apiKey = req.apiKey!;
    const project = req.project!;

    // 1. Resolve model
    const model = await modelRegistryService.resolveModel(requestedModelId);
    if (!model) {
      reply.status(404).send({
        error: {
          message: `The model '${requestedModelId}' does not exist or is disabled.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      });
      return null;
    }

    req.resolvedModel = model;

    // Estimate credits & tokens
    const { estimatedCredits, estimatedTokens } =
      creditsService.calculateEstimatedCredits(model, category, body);

    // 2. Token Bucket Rate Limiting
    const rateLimit = await rateLimiterService.checkRateLimits(
      apiKey.id,
      project.id,
      estimatedTokens
    );

    // Always append rate limit headers
    reply.header(HEADERS.RATELIMIT_LIMIT_REQUESTS, rateLimit.limitRequests);
    reply.header(HEADERS.RATELIMIT_REMAINING_REQUESTS, rateLimit.remainingRequests);
    reply.header(HEADERS.RATELIMIT_RESET_REQUESTS, rateLimit.resetRequests);
    reply.header(HEADERS.RATELIMIT_LIMIT_TOKENS, rateLimit.limitTokens);
    reply.header(HEADERS.RATELIMIT_REMAINING_TOKENS, rateLimit.remainingTokens);
    reply.header(HEADERS.RATELIMIT_RESET_TOKENS, rateLimit.resetTokens);

    if (!rateLimit.allowed) {
      metrics.rateLimitHitsTotal.inc({ type: rateLimit.remainingRequests <= 0 ? 'rpm' : 'tpm' });
      reply.header(HEADERS.RETRY_AFTER, rateLimit.retryAfter);
      reply.status(429).send({
        error: {
          message: 'Rate limit reached for requests or tokens. Please slow down and wait before retrying.',
          type: 'rate_limit_exceeded',
          param: null,
          code: 'rate_limit_exceeded',
        },
      });
      return null;
    }

    // 3. Admission Control (Per-Model Concurrency Semaphore)
    const sem = await semaphoreService.acquireSlot(
      model.id,
      model.max_concurrency,
      req.requestId
    );

    metrics.queueWaitDurationSeconds.labels(model.id).observe(sem.waitMs / 1000);

    if (!sem.acquired) {
      metrics.concurrencyRejectionsTotal.inc({ model: model.id });
      reply.header(HEADERS.RETRY_AFTER, '2');
      reply.status(429).send({
        error: {
          message: `Model '${model.id}' is currently at maximum capacity (${model.max_concurrency} in-flight requests). Admission queue timeout exceeded.`,
          type: 'rate_limit_exceeded',
          param: null,
          code: 'model_concurrency_limit_exceeded',
        },
      });
      return null;
    }

    req.acquiredConcurrency = true;
    metrics.activeConcurrency.labels(model.id).set(sem.currentCount);

    // 4. Atomic Credit Reservation
    const reserveId = crypto.randomUUID();
    req.reserveId = reserveId;
    req.estimatedCredits = estimatedCredits;

    const creditResult = await creditsService.reserveCredits(
      project.account_id,
      reserveId,
      estimatedCredits
    );

    if (!creditResult.success) {
      // Release acquired semaphore slot if credit reserve fails
      await semaphoreService.releaseSlot(model.id, req.requestId);
      req.acquiredConcurrency = false;

      reply.status(402).send({
        error: {
          message: `Insufficient credits to run this request. Estimated cost: ~${estimatedCredits} credits (~$${creditsService.creditsToUsd(estimatedCredits).toFixed(6)}), Available balance: ${creditResult.availableCredits} credits.`,
          type: 'insufficient_credits',
          param: null,
          code: 'insufficient_credits',
        },
      });
      return null;
    }

    return {
      model,
      reserveId,
      estimatedCredits,
    };
  }

  /**
   * Post-inference execution pipeline:
   * 1. Release Semaphore
   * 2. Reconcile Credits with actual usage
   * 3. Record Prometheus Metrics
   * 4. Enqueue Usage Event to Async In-Memory Buffer
   */
  async finalize(
    req: FastifyRequest,
    ctx: PreparedInferenceContext,
    result: {
      statusCode: number;
      usage?: { inTokens?: number; outTokens?: number; images?: number; audioSec?: number };
      latencyMs: number;
      ttftMs?: number;
      isStream?: boolean;
    }
  ): Promise<number> {
    const { model, reserveId } = ctx;
    const apiKey = req.apiKey!;
    const project = req.project!;
    const usage = result.usage || {};

    // 1. Release Semaphore immediately
    if (req.acquiredConcurrency) {
      await semaphoreService.releaseSlot(model.id, req.requestId);
      req.acquiredConcurrency = false;
      const count = await semaphoreService.getActiveCount(model.id);
      metrics.activeConcurrency.labels(model.id).set(count);
    }

    let actualCredits = 0;

    // 2. Reconcile credits if request succeeded
    if (result.statusCode >= 200 && result.statusCode < 300) {
      actualCredits = creditsService.calculateActualCredits(model, usage);
      await creditsService.reconcileCredits(project.account_id, reserveId, actualCredits);
    } else {
      // Release reservation on failure/abort
      await creditsService.releaseReservation(project.account_id, reserveId);
    }

    // 3. Prometheus metrics
    metrics.requestsTotal.inc({
      model: model.id,
      method: req.method,
      path: req.url,
      status_code: result.statusCode.toString(),
    });

    metrics.requestDurationSeconds.labels(
      model.id,
      model.engine,
      result.isStream ? 'true' : 'false',
      result.statusCode.toString()
    ).observe(result.latencyMs / 1000);

    if (usage.inTokens) {
      metrics.tokensTotal.inc({ model: model.id, type: 'prompt' }, usage.inTokens);
    }
    if (usage.outTokens) {
      metrics.tokensTotal.inc({ model: model.id, type: 'completion' }, usage.outTokens);
    }
    if (actualCredits > 0) {
      metrics.creditsTotal.inc({ model: model.id }, actualCredits);
    }

    // 4. Enqueue async usage event (zero retention on payload)
    usageAggregatorService.enqueue({
      project_id: project.id,
      key_id: apiKey.id,
      endpoint_id: null,
      model_id: model.id,
      ts: new Date(),
      in_tokens: usage.inTokens || 0,
      out_tokens: usage.outTokens || 0,
      images: usage.images || 0,
      audio_sec: usage.audioSec || 0,
      latency_ms: result.latencyMs,
      ttft_ms: result.ttftMs || 0,
      status_code: result.statusCode,
      cost_credits: actualCredits,
    });

    return actualCredits;
  }
}

export const inferencePipelineService = new InferencePipelineService();
