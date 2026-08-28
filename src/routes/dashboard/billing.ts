import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireJwtAuth } from '../../middleware/jwt.middleware.js';
import { billingService } from '../../services/billing.service.js';
import { paymentsService } from '../../services/payments.service.js';
import { BILLING } from '../../config/constants.js';

const TopUpSchema = z.object({
  amount: z.number().positive('Top-up amount must be greater than $0').max(10000),
});

const CheckoutSchema = z.object({
  amount: z
    .number()
    .min(BILLING.MIN_TOPUP_USD, `Minimum top-up is $${BILLING.MIN_TOPUP_USD}`)
    .max(BILLING.MAX_TOPUP_USD, `Maximum top-up is $${BILLING.MAX_TOPUP_USD}`),
});

export const billingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', requireJwtAuth);

  /**
   * GET /v1/billing/plan
   */
  fastify.get('/billing/plan', async (req, reply) => {
    const user = req.user!;
    const overview = await billingService.getPlanOverview(user.accountId);
    reply.send(overview);
  });

  /**
   * GET /v1/billing/invoices
   */
  fastify.get('/billing/invoices', async (req, reply) => {
    const user = req.user!;
    const invoices = await billingService.getInvoices(user.accountId);
    reply.send(
      invoices.map((inv) => ({
        id: inv.id,
        date: inv.period,
        amount: Number(inv.amount),
        status: inv.status,
      }))
    );
  });

  /**
   * GET /v1/billing/cost-breakdown?period=YYYY-MM
   */
  fastify.get('/billing/cost-breakdown', async (req, reply) => {
    const user = req.user!;
    const { period = '' } = req.query as { period?: string };
    const breakdown = await billingService.getCostBreakdown(user.accountId, period);
    reply.send(breakdown);
  });

  /**
   * GET /v1/billing/payments — recent top-up attempts
   */
  fastify.get('/billing/payments', async (req, reply) => {
    const user = req.user!;
    reply.send(await paymentsService.listPayments(user.accountId));
  });

  /**
   * POST /v1/billing/checkout — start a NOWPayments crypto checkout.
   * Returns { invoice_url } for the client to redirect to. Credits are applied
   * later by the IPN webhook once the payment confirms.
   */
  fastify.post('/billing/checkout', async (req, reply) => {
    const user = req.user!;
    const parseResult = CheckoutSchema.safeParse(req.body);

    if (!parseResult.success) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid amount',
      });
      return;
    }

    const result = await paymentsService.createCheckout(user.accountId, parseResult.data.amount);
    reply.send(result);
  });

  /**
   * POST /v1/billing/topup — direct credit faucet, DEV/TEST ONLY.
   * Disabled in production; use /v1/billing/checkout instead.
   */
  fastify.post('/billing/topup', async (req, reply) => {
    if (process.env.NODE_ENV === 'production') {
      reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Manual top-up is disabled in production. Use POST /v1/billing/checkout.',
      });
      return;
    }

    const user = req.user!;
    const parseResult = TopUpSchema.safeParse(req.body);

    if (!parseResult.success) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid amount',
      });
      return;
    }

    const result = await billingService.topUpCredits(user.accountId, parseResult.data.amount);
    reply.status(200).send({
      message: `Successfully added $${parseResult.data.amount} to account balance.`,
      ...result,
    });
  });
};
