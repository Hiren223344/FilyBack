import { FastifyPluginAsync } from 'fastify';
import { paymentsService } from '../services/payments.service.js';

/**
 * Unauthenticated provider callbacks. Every route here MUST verify a signature.
 */
export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /v1/webhooks/nowpayments — instant payment notification.
   */
  fastify.post('/webhooks/nowpayments', async (req, reply) => {
    const signature = req.headers['x-nowpayments-sig'] as string | undefined;
    const rawBody =
      req.rawBody ??
      (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));

    if (!paymentsService.verifySignature(rawBody, signature)) {
      reply.status(401).send({ error: 'invalid_signature' });
      return;
    }

    try {
      await paymentsService.handleIpn((req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      req.log.error({ err, requestId: req.requestId }, 'NOWPayments IPN processing failed');
      // 5xx so the provider retries later.
      reply.status(500).send({ error: 'processing_error' });
      return;
    }

    reply.send({ ok: true });
  });
};
