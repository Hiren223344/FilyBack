import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireJwtAuth } from '../../middleware/jwt.middleware.js';
import { billingService } from '../../services/billing.service.js';

const TopUpSchema = z.object({
  amount: z.number().positive('Top-up amount must be greater than $0').max(10000),
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
   * POST /v1/billing/topup
   */
  fastify.post('/billing/topup', async (req, reply) => {
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
