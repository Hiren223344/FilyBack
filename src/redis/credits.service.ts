import { redis } from '../db/redis.js';
import { query } from '../db/index.js';
import { Model } from '../types/db.types.js';
import { CREDITS_PER_USD, CACHE_TTL } from '../config/constants.js';

export interface CreditReservationResult {
  success: boolean;
  availableCredits: number;
  totalBalance: number;
}

export class CreditsService {
  usdToCredits(usd: number): number {
    return Math.ceil(usd * CREDITS_PER_USD);
  }

  creditsToUsd(credits: number | string | bigint): number {
    return Number(credits) / CREDITS_PER_USD;
  }

  /**
   * Calculate estimated credits for an incoming inference request
   */
  calculateEstimatedCredits(
    model: Model,
    requestType: 'chat' | 'completion' | 'image' | 'audio' | 'embedding',
    body: Record<string, unknown>
  ): { estimatedCredits: number; estimatedTokens: number } {
    const priceInPerMtok = Number(model.price_in_per_mtok) || 0;
    const priceOutPerMtok = Number(model.price_out_per_mtok) || 0;
    const pricePerImage = Number(model.price_per_image) || 0;
    const pricePerAudioMin = Number(model.price_per_audio_min) || 0;

    let estimatedTokens = 1;
    let estimatedCredits = 0;

    if (requestType === 'chat') {
      const messages = Array.isArray(body['messages']) ? body['messages'] : [];
      let charLength = 0;
      for (const msg of messages) {
        if (typeof msg === 'object' && msg !== null && 'content' in msg) {
          const content = (msg as { content: unknown }).content;
          if (typeof content === 'string') {
            charLength += content.length;
          } else if (Array.isArray(content)) {
            charLength += JSON.stringify(content).length;
          }
        }
      }
      const promptTokens = Math.max(1, Math.ceil(charLength / 4));
      const maxTokens =
        Number(body['max_tokens']) ||
        Number(body['max_completion_tokens']) ||
        Math.min(model.ctx_len > 0 ? model.ctx_len : 4096, 4096);

      estimatedTokens = promptTokens + maxTokens;
      const inCost = Math.ceil((promptTokens * priceInPerMtok * CREDITS_PER_USD) / 1_000_000);
      const outCost = Math.ceil((maxTokens * priceOutPerMtok * CREDITS_PER_USD) / 1_000_000);
      estimatedCredits = inCost + outCost;
    } else if (requestType === 'completion') {
      const prompt = body['prompt'];
      let charLength = 0;
      if (typeof prompt === 'string') {
        charLength = prompt.length;
      } else if (Array.isArray(prompt)) {
        charLength = prompt.join(' ').length;
      }
      const promptTokens = Math.max(1, Math.ceil(charLength / 4));
      const maxTokens = Number(body['max_tokens']) || 4096;

      estimatedTokens = promptTokens + maxTokens;
      const inCost = Math.ceil((promptTokens * priceInPerMtok * CREDITS_PER_USD) / 1_000_000);
      const outCost = Math.ceil((maxTokens * priceOutPerMtok * CREDITS_PER_USD) / 1_000_000);
      estimatedCredits = inCost + outCost;
    } else if (requestType === 'embedding') {
      const input = body['input'];
      let charLength = 0;
      if (typeof input === 'string') {
        charLength = input.length;
      } else if (Array.isArray(input)) {
        charLength = JSON.stringify(input).length;
      }
      const promptTokens = Math.max(1, Math.ceil(charLength / 4));
      estimatedTokens = promptTokens;
      estimatedCredits = Math.ceil((promptTokens * priceInPerMtok * CREDITS_PER_USD) / 1_000_000);
    } else if (requestType === 'image') {
      const n = Number(body['n']) || 1;
      estimatedTokens = 1000;
      estimatedCredits = Math.ceil(n * pricePerImage * CREDITS_PER_USD);
    } else if (requestType === 'audio') {
      const audioSec = Number(body['audio_sec']) || 60; // default 60 sec estimate
      estimatedTokens = 500;
      estimatedCredits = Math.ceil((audioSec / 60) * pricePerAudioMin * CREDITS_PER_USD);
    }

    // Minimum reservation of at least 1 credit if pricing is non-zero
    if (estimatedCredits === 0 && (priceInPerMtok > 0 || priceOutPerMtok > 0 || pricePerImage > 0 || pricePerAudioMin > 0)) {
      estimatedCredits = 1;
    }

    return { estimatedCredits, estimatedTokens };
  }

  /**
   * Calculate actual credit cost based on realized upstream usage
   */
  calculateActualCredits(
    model: Model,
    usage: {
      inTokens?: number;
      outTokens?: number;
      images?: number;
      audioSec?: number;
    }
  ): number {
    const priceInPerMtok = Number(model.price_in_per_mtok) || 0;
    const priceOutPerMtok = Number(model.price_out_per_mtok) || 0;
    const pricePerImage = Number(model.price_per_image) || 0;
    const pricePerAudioMin = Number(model.price_per_audio_min) || 0;

    const inTokens = usage.inTokens || 0;
    const outTokens = usage.outTokens || 0;
    const images = usage.images || 0;
    const audioSec = usage.audioSec || 0;

    const inCost = Math.ceil((inTokens * priceInPerMtok * CREDITS_PER_USD) / 1_000_000);
    const outCost = Math.ceil((outTokens * priceOutPerMtok * CREDITS_PER_USD) / 1_000_000);
    const imageCost = Math.ceil(images * pricePerImage * CREDITS_PER_USD);
    const audioCost = Math.ceil((audioSec / 60) * pricePerAudioMin * CREDITS_PER_USD);

    return inCost + outCost + imageCost + audioCost;
  }

  /**
   * Get account balance from Postgres
   */
  async getDbBalance(accountId: string): Promise<number> {
    const res = await query<{ credits: string }>(
      'SELECT credits FROM balances WHERE account_id = $1',
      [accountId]
    );
    if (res.rows.length === 0) {
      // Initialize zero balance
      await query(
        'INSERT INTO balances (account_id, credits) VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING',
        [accountId]
      );
      return 0;
    }
    const row = res.rows[0];
    return row ? Number(row.credits) : 0;
  }

  /**
   * Reserve credits in Redis atomically using Lua
   */
  async reserveCredits(
    accountId: string,
    reserveId: string,
    estimatedCredits: number
  ): Promise<CreditReservationResult> {
    const balanceKey = `balance:${accountId}`;
    const resKey = `res:${accountId}:${reserveId}`;
    const resTotalKey = `res_total:${accountId}`;
    const ttlSec = CACHE_TTL.CREDIT_RESERVATION_SEC;

    let [status, val1, val2] = await redis.filybaseCredits(
      balanceKey,
      resKey,
      resTotalKey,
      'reserve',
      estimatedCredits,
      ttlSec,
      ''
    );

    if (status === -1) {
      // Balance not cached in Redis yet -> load from DB and retry
      const dbBalance = await this.getDbBalance(accountId);
      [status, val1, val2] = await redis.filybaseCredits(
        balanceKey,
        resKey,
        resTotalKey,
        'reserve',
        estimatedCredits,
        ttlSec,
        dbBalance
      );
    }

    const success = status === 1;
    return {
      success,
      availableCredits: val1,
      totalBalance: val2,
    };
  }

  /**
   * Reconcile credits: replace reservation with actual cost atomically
   */
  async reconcileCredits(
    accountId: string,
    reserveId: string,
    actualCredits: number
  ): Promise<{ newBalance: number }> {
    const balanceKey = `balance:${accountId}`;
    const resKey = `res:${accountId}:${reserveId}`;
    const resTotalKey = `res_total:${accountId}`;

    const [, newBalance] = await redis.filybaseCredits(
      balanceKey,
      resKey,
      resTotalKey,
      'reconcile',
      actualCredits,
      0,
      ''
    );

    return { newBalance };
  }

  /**
   * Release reservation without deducting any credits (e.g. aborted or upstream error)
   */
  async releaseReservation(accountId: string, reserveId: string): Promise<void> {
    const balanceKey = `balance:${accountId}`;
    const resKey = `res:${accountId}:${reserveId}`;
    const resTotalKey = `res_total:${accountId}`;

    try {
      await redis.filybaseCredits(
        balanceKey,
        resKey,
        resTotalKey,
        'release',
        0,
        0,
        ''
      );
    } catch (err) {
      console.error(`Failed to release credit reservation ${reserveId} for account ${accountId}:`, err);
    }
  }

  /**
   * Sync Redis balance with Postgres
   */
  async syncBalanceToRedis(accountId: string, newBalance: number): Promise<void> {
    const balanceKey = `balance:${accountId}`;
    await redis.filybaseCredits(
      balanceKey,
      '',
      '',
      'set_balance',
      newBalance,
      0,
      ''
    );
  }
}

export const creditsService = new CreditsService();
