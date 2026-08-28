import crypto from 'node:crypto';
import { query } from '../db/index.js';
import { env } from '../config/env.js';
import { creditsService } from '../redis/credits.service.js';
import { billingService } from './billing.service.js';
import { BILLING } from '../config/constants.js';

export interface CheckoutResult {
  invoice_url: string;
  order_id: string;
  payment_id: string;
  amount_usd: number;
}

export interface PaymentRecord {
  id: string;
  amount_usd: number;
  credits: number;
  status: string;
  created_at: Date;
  credited_at: Date | null;
}

interface NowPaymentsIpn {
  order_id?: string;
  payment_status?: string;
  payment_id?: string | number;
  price_amount?: string | number;
  pay_currency?: string;
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** Recursively sort object keys — NOWPayments signs the key-sorted JSON body. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    return Object.keys(src)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortDeep(src[key]);
        return acc;
      }, {});
  }
  return value;
}

export class PaymentsService {
  isConfigured(): boolean {
    return Boolean(env.NOWPAYMENTS_API_KEY && env.NOWPAYMENTS_IPN_SECRET);
  }

  /**
   * Create a NOWPayments hosted invoice for a credit top-up and record it as
   * a pending payment. The account is credited later, from the IPN webhook.
   */
  async createCheckout(accountId: string, amountUsd: number): Promise<CheckoutResult> {
    if (!this.isConfigured()) {
      throw httpError('Crypto payments are not configured on this server.', 503);
    }

    const amount = Math.round(amountUsd * 100) / 100;
    if (!Number.isFinite(amount) || amount < BILLING.MIN_TOPUP_USD || amount > BILLING.MAX_TOPUP_USD) {
      throw httpError(
        `Top-up amount must be between $${BILLING.MIN_TOPUP_USD} and $${BILLING.MAX_TOPUP_USD}.`,
        400
      );
    }

    const orderId = crypto.randomUUID();
    const credits = creditsService.usdToCredits(amount);

    const inserted = await query<{ id: string }>(
      `INSERT INTO payments (account_id, provider, order_id, amount_usd, credits, status)
       VALUES ($1, 'nowpayments', $2, $3, $4, 'pending')
       RETURNING id`,
      [accountId, orderId, amount, credits]
    );
    const paymentId = inserted.rows[0]!.id;

    let res: Response;
    try {
      res = await fetch(`${env.NOWPAYMENTS_API_URL}/v1/invoice`, {
        method: 'POST',
        headers: {
          'x-api-key': env.NOWPAYMENTS_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          price_amount: amount,
          price_currency: 'usd',
          order_id: orderId,
          order_description: `FilyBase credits — $${amount.toFixed(2)}`,
          ipn_callback_url: `${env.PUBLIC_API_URL}/v1/webhooks/nowpayments`,
          success_url: `${env.APP_URL}/billing?payment=success`,
          cancel_url: `${env.APP_URL}/billing?payment=cancelled`,
        }),
      });
    } catch {
      await this.markFailed(paymentId, 'provider_unreachable');
      throw httpError('Could not reach the payment provider. Please try again.', 502);
    }

    const bodyText = await res.text();
    if (!res.ok) {
      await this.markFailed(paymentId, `provider_${res.status}`);
      throw httpError('The payment provider rejected the request.', 502);
    }

    let data: { id?: string | number; invoice_url?: string };
    try {
      data = JSON.parse(bodyText);
    } catch {
      await this.markFailed(paymentId, 'provider_bad_json');
      throw httpError('The payment provider returned an unexpected response.', 502);
    }

    if (!data.invoice_url) {
      await this.markFailed(paymentId, 'no_invoice_url');
      throw httpError('The payment provider did not return a checkout URL.', 502);
    }

    await query('UPDATE payments SET provider_invoice_id = $1, updated_at = NOW() WHERE id = $2', [
      data.id != null ? String(data.id) : null,
      paymentId,
    ]);

    return { invoice_url: data.invoice_url, order_id: orderId, payment_id: paymentId, amount_usd: amount };
  }

  /** Constant-time verify of the x-nowpayments-sig HMAC-SHA512 header. */
  verifySignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature || !env.NOWPAYMENTS_IPN_SECRET || !rawBody) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return false;
    }

    const sortedJson = JSON.stringify(sortDeep(parsed));
    const expected = crypto
      .createHmac('sha512', env.NOWPAYMENTS_IPN_SECRET)
      .update(sortedJson)
      .digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Apply an IPN. Idempotent: a payment is credited at most once, on the first
   * `finished`/`confirmed` notification.
   */
  async handleIpn(payload: NowPaymentsIpn): Promise<void> {
    const orderId = payload.order_id;
    const providerStatus = String(payload.payment_status || '').toLowerCase();
    if (!orderId) return;

    const found = await query<{
      id: string;
      account_id: string;
      amount_usd: string;
      status: string;
    }>('SELECT id, account_id, amount_usd, status FROM payments WHERE order_id = $1 LIMIT 1', [orderId]);
    const payment = found.rows[0];
    if (!payment) return;
    if (payment.status === 'credited') return; // already done

    const paid = providerStatus === 'finished' || providerStatus === 'confirmed';
    const failed = ['failed', 'expired', 'refunded'].includes(providerStatus);

    if (paid) {
      await billingService.topUpCredits(
        payment.account_id,
        Number(payment.amount_usd),
        `NOWPAYMENTS:${orderId}`
      );
      await query(
        `UPDATE payments
         SET status = 'credited', raw_status = $1, provider_payment_id = $2,
             credited_at = NOW(), updated_at = NOW()
         WHERE id = $3`,
        [providerStatus, payload.payment_id != null ? String(payload.payment_id) : null, payment.id]
      );
      return;
    }

    await query(
      `UPDATE payments SET status = $1, raw_status = $2, updated_at = NOW() WHERE id = $3`,
      [failed ? 'failed' : 'pending', providerStatus, payment.id]
    );
  }

  async listPayments(accountId: string): Promise<PaymentRecord[]> {
    const res = await query<{
      id: string;
      amount_usd: string;
      credits: string;
      status: string;
      created_at: Date;
      credited_at: Date | null;
    }>(
      `SELECT id, amount_usd, credits, status, created_at, credited_at
       FROM payments WHERE account_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [accountId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      amount_usd: Number(r.amount_usd),
      credits: Number(r.credits),
      status: r.status,
      created_at: r.created_at,
      credited_at: r.credited_at,
    }));
  }

  private async markFailed(paymentId: string, reason: string): Promise<void> {
    await query('UPDATE payments SET status = $1, raw_status = $2, updated_at = NOW() WHERE id = $3', [
      'failed',
      reason,
      paymentId,
    ]);
  }
}

export const paymentsService = new PaymentsService();
