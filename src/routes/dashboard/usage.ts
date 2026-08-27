import { FastifyPluginAsync } from 'fastify';
import { requireJwtAuth } from '../../middleware/jwt.middleware.js';
import { query } from '../../db/index.js';
import { creditsService } from '../../redis/credits.service.js';

export const usageRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', requireJwtAuth);

  /**
   * GET /v1/usage?range=24h|7d|30d
   * Reads from materialized hourly rollup
   */
  fastify.get('/usage', async (req, reply) => {
    const user = req.user!;
    const { range = '24h', project_id } = req.query as {
      range?: string;
      project_id?: string;
    };

    let intervalStr = '24 hours';
    if (range === '7d') intervalStr = '7 days';
    else if (range === '30d') intervalStr = '30 days';

    const params: unknown[] = [user.accountId, intervalStr];
    let projectFilter = '';

    if (project_id) {
      params.push(project_id);
      projectFilter = 'AND r.project_id = $3';
    }

    const res = await query<{
      hour: Date;
      requests: string | number;
      tokens: string | number;
      cost_credits: string | number;
      p50_latency: string | number;
    }>(
      `
      SELECT 
        r.hour,
        COALESCE(SUM(r.request_count), 0)::bigint AS requests,
        COALESCE(SUM(r.in_tokens + r.out_tokens), 0)::bigint AS tokens,
        COALESCE(SUM(r.cost_credits), 0)::bigint AS cost_credits,
        COALESCE(AVG(r.p50_latency_ms), 0)::int AS p50_latency
      FROM usage_hourly_rollup r
      JOIN projects p ON p.id = r.project_id
      WHERE p.account_id = $1
        AND r.hour >= NOW() - $2::interval
        ${projectFilter}
      GROUP BY r.hour
      ORDER BY r.hour ASC;
      `,
      params
    );

    let totalRequests = 0;
    let totalTokens = 0;
    let totalCostCredits = 0;
    let latencySum = 0;

    const chart = res.rows.map((row) => {
      const requests = Number(row.requests) || 0;
      const tokens = Number(row.tokens) || 0;
      const costCredits = Number(row.cost_credits) || 0;
      const p50 = Number(row.p50_latency) || 0;

      totalRequests += requests;
      totalTokens += tokens;
      totalCostCredits += costCredits;
      latencySum += p50 * requests;

      return {
        t: row.hour.toISOString(),
        tokens_per_hour: tokens,
        requests_per_hour: requests,
        spend_per_hour: Number(creditsService.creditsToUsd(costCredits).toFixed(6)),
      };
    });

    const averageP50Latency = totalRequests > 0 ? Math.round(latencySum / totalRequests) : 0;
    const spendUsd = Number(creditsService.creditsToUsd(totalCostCredits).toFixed(4));

    reply.send({
      range,
      requests: totalRequests,
      tokens: totalTokens,
      spend: spendUsd,
      p50_latency_ms: averageP50Latency,
      chart,
    });
  });
};
