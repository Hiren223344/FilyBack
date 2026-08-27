import { query, withTransaction } from '../db/index.js';
import { creditsService } from '../redis/credits.service.js';
import { Invoice } from '../types/db.types.js';

export interface PlanOverview {
  plan: string;
  usage_this_month: {
    in_tokens: number;
    out_tokens: number;
    images: number;
    audio_sec: number;
    cost_credits: number;
    cost_usd: number;
  };
  estimated_total: number;
  balance_credits: number;
  balance_usd: number;
}

export interface CostBreakdownItem {
  model: string;
  category: string;
  in_tokens: number;
  out_tokens: number;
  images: number;
  audio_sec: number;
  rate_in_per_mtok: number;
  rate_out_per_mtok: number;
  rate_per_image: number;
  rate_per_audio_min: number;
  cost_credits: number;
  cost_usd: number;
}

export class BillingService {
  /**
   * Get billing plan and current month spend
   */
  async getPlanOverview(accountId: string, projectId?: string): Promise<PlanOverview> {
    const balanceCredits = await creditsService.getDbBalance(accountId);
    const balanceUsd = creditsService.creditsToUsd(balanceCredits);

    // Sum current month usage from usage_events / rollup
    const usageRes = await query<{
      in_tokens: string;
      out_tokens: string;
      images: string;
      audio_sec: string;
      cost_credits: string;
    }>(
      `
      SELECT 
        COALESCE(SUM(u.in_tokens), 0) AS in_tokens,
        COALESCE(SUM(u.out_tokens), 0) AS out_tokens,
        COALESCE(SUM(u.images), 0) AS images,
        COALESCE(SUM(u.audio_sec), 0) AS audio_sec,
        COALESCE(SUM(u.cost_credits), 0) AS cost_credits
      FROM usage_events u
      JOIN projects p ON p.id = u.project_id
      WHERE p.account_id = $1
        AND u.ts >= date_trunc('month', NOW());
      `,
      [accountId]
    );

    const u = usageRes.rows[0] || {
      in_tokens: '0',
      out_tokens: '0',
      images: '0',
      audio_sec: '0',
      cost_credits: '0',
    };

    const costCredits = Number(u.cost_credits);
    const costUsd = creditsService.creditsToUsd(costCredits);

    // Project estimated total to end of current month
    const now = new Date();
    const dayOfMonth = Math.max(1, now.getDate());
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const estimatedTotal = Number(((costUsd / dayOfMonth) * daysInMonth).toFixed(2));

    return {
      plan: 'Pay-as-you-go GPU Tier',
      usage_this_month: {
        in_tokens: Number(u.in_tokens),
        out_tokens: Number(u.out_tokens),
        images: Number(u.images),
        audio_sec: Number(u.audio_sec),
        cost_credits: costCredits,
        cost_usd: Number(costUsd.toFixed(4)),
      },
      estimated_total: estimatedTotal,
      balance_credits: balanceCredits,
      balance_usd: Number(balanceUsd.toFixed(2)),
    };
  }

  /**
   * Get list of invoices for the account
   */
  async getInvoices(accountId: string): Promise<Invoice[]> {
    const res = await query<Invoice>(
      `
      SELECT id, account_id, period, amount, status, issued_at
      FROM invoices
      WHERE account_id = $1
      ORDER BY period DESC, issued_at DESC;
      `,
      [accountId]
    );
    return res.rows;
  }

  /**
   * Get cost breakdown by model for a given period (YYYY-MM)
   */
  async getCostBreakdown(accountId: string, periodStr: string): Promise<CostBreakdownItem[]> {
    // Validate period YYYY-MM
    let startDate: Date;
    let endDate: Date;

    if (/^\d{4}-\d{2}$/.test(periodStr)) {
      const [yearStr, monthStr] = periodStr.split('-');
      const year = Number(yearStr);
      const month = Number(monthStr);
      startDate = new Date(Date.UTC(year, month - 1, 1));
      endDate = new Date(Date.UTC(year, month, 1));
    } else {
      // Default to current month
      const now = new Date();
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }

    const res = await query<{
      model_id: string;
      category: string;
      price_in_per_mtok: string;
      price_out_per_mtok: string;
      price_per_image: string;
      price_per_audio_min: string;
      in_tokens: string;
      out_tokens: string;
      images: string;
      audio_sec: string;
      cost_credits: string;
    }>(
      `
      SELECT 
        u.model_id,
        COALESCE(m.category, 'text') AS category,
        COALESCE(m.price_in_per_mtok, 0) AS price_in_per_mtok,
        COALESCE(m.price_out_per_mtok, 0) AS price_out_per_mtok,
        COALESCE(m.price_per_image, 0) AS price_per_image,
        COALESCE(m.price_per_audio_min, 0) AS price_per_audio_min,
        SUM(u.in_tokens) AS in_tokens,
        SUM(u.out_tokens) AS out_tokens,
        SUM(u.images) AS images,
        SUM(u.audio_sec) AS audio_sec,
        SUM(u.cost_credits) AS cost_credits
      FROM usage_events u
      JOIN projects p ON p.id = u.project_id
      LEFT JOIN models m ON m.id = u.model_id
      WHERE p.account_id = $1
        AND u.ts >= $2 AND u.ts < $3
      GROUP BY u.model_id, m.category, m.price_in_per_mtok, m.price_out_per_mtok, m.price_per_image, m.price_per_audio_min
      ORDER BY cost_credits DESC;
      `,
      [accountId, startDate, endDate]
    );

    return res.rows.map((r) => {
      const costCredits = Number(r.cost_credits) || 0;
      return {
        model: r.model_id,
        category: r.category,
        in_tokens: Number(r.in_tokens) || 0,
        out_tokens: Number(r.out_tokens) || 0,
        images: Number(r.images) || 0,
        audio_sec: Number(r.audio_sec) || 0,
        rate_in_per_mtok: Number(r.price_in_per_mtok),
        rate_out_per_mtok: Number(r.price_out_per_mtok),
        rate_per_image: Number(r.price_per_image),
        rate_per_audio_min: Number(r.price_per_audio_min),
        cost_credits: costCredits,
        cost_usd: Number(creditsService.creditsToUsd(costCredits).toFixed(4)),
      };
    });
  }

  /**
   * Top up account credits (e.g. via payment or test faucet)
   */
  async topUpCredits(
    accountId: string,
    amountUsd: number,
    ref: string = 'TOPUP_MANUAL'
  ): Promise<{ newBalanceCredits: number; newBalanceUsd: number }> {
    const creditsToAdd = creditsService.usdToCredits(amountUsd);

    return withTransaction(async (client) => {
      const balRes = await client.query<{ credits: string }>(
        `
        INSERT INTO balances (account_id, credits)
        VALUES ($1, $2)
        ON CONFLICT (account_id) DO UPDATE
        SET credits = balances.credits + $2
        RETURNING credits;
        `,
        [accountId, creditsToAdd]
      );

      const row = balRes.rows[0];
      const newCredits = row ? Number(row.credits) : creditsToAdd;

      await client.query(
        `INSERT INTO ledger (account_id, delta, reason, ref) VALUES ($1, $2, $3, $4)`,
        [accountId, creditsToAdd, `Account top-up ($${amountUsd})`, ref]
      );

      // Sync to Redis
      await creditsService.syncBalanceToRedis(accountId, newCredits);

      return {
        newBalanceCredits: newCredits,
        newBalanceUsd: creditsService.creditsToUsd(newCredits),
      };
    });
  }
}

export const billingService = new BillingService();
