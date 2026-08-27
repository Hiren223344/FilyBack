import { query } from '../db/index.js';
import { redis } from '../db/redis.js';
import { Model } from '../types/db.types.js';
import { ModelListItem } from '../types/openai.types.js';
import { CACHE_TTL } from '../config/constants.js';

export class ModelRegistryService {
  /**
   * Resolve a model by its ID or alias
   */
  async resolveModel(modelId: string): Promise<Model | null> {
    const cacheKey = `cache:model:${modelId}`;

    // 1. Try Redis cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as Model;
      } catch {
        // Continue to DB on parse error
      }
    }

    // 2. Query Postgres
    const res = await query<Model>(
      `
      SELECT 
        id, display_name, provider, category, engine, upstream_url, upstream_model,
        ctx_len, max_concurrency, price_in_per_mtok, price_out_per_mtok,
        price_per_image, price_per_audio_min, status
      FROM models
      WHERE id = $1 AND status = 'live'
      LIMIT 1;
      `,
      [modelId]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const model = res.rows[0];
    if (!model) return null;

    // Cache model info in Redis
    await redis.set(cacheKey, JSON.stringify(model), 'EX', CACHE_TTL.MODEL_REGISTRY_SEC);

    return model;
  }

  /**
   * List all models formatted for the /v1/models endpoint
   */
  async listModels(): Promise<ModelListItem[]> {
    const res = await query<Model>(
      `
      SELECT 
        id, display_name, provider, category, engine, upstream_url, upstream_model,
        ctx_len, max_concurrency, price_in_per_mtok, price_out_per_mtok,
        price_per_image, price_per_audio_min, status
      FROM models
      ORDER BY category ASC, id ASC;
      `
    );

    return res.rows.map((m) => ({
      id: m.id,
      name: m.display_name,
      provider: m.provider,
      owned_by: m.provider.toLowerCase(),
      category: m.category,
      price: {
        in_per_mtok: Number(m.price_in_per_mtok),
        out_per_mtok: Number(m.price_out_per_mtok),
        per_image: Number(m.price_per_image),
        per_audio_min: Number(m.price_per_audio_min),
      },
      ctx_len: m.ctx_len,
      max_concurrency: m.max_concurrency,
      status: m.status,
    }));
  }

  /**
   * Passive upstream health check for all registered live models
   */
  async checkUpstreamHealth(): Promise<
    Record<
      string,
      {
        status: 'healthy' | 'unhealthy';
        engine: string;
        upstreamUrl: string;
        latencyMs: number;
        error?: string;
      }
    >
  > {
    const res = await query<Model>(
      'SELECT id, engine, upstream_url FROM models WHERE status = $1',
      ['live']
    );

    const results: Record<
      string,
      {
        status: 'healthy' | 'unhealthy';
        engine: string;
        upstreamUrl: string;
        latencyMs: number;
        error?: string;
      }
    > = {};

    await Promise.all(
      res.rows.map(async (m) => {
        const start = Date.now();
        const healthUrl = `${m.upstream_url.replace(/\/v1\/?$/, '')}/health`;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          const response = await fetch(healthUrl, {
            method: 'GET',
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          const latencyMs = Date.now() - start;

          if (response.ok || response.status === 404) {
            // Some engines return 404 or 200 for /health, either indicates the process is up
            results[m.id] = {
              status: 'healthy',
              engine: m.engine,
              upstreamUrl: m.upstream_url,
              latencyMs,
            };
          } else {
            results[m.id] = {
              status: 'unhealthy',
              engine: m.engine,
              upstreamUrl: m.upstream_url,
              latencyMs,
              error: `HTTP ${response.status}`,
            };
          }
        } catch (err: unknown) {
          const latencyMs = Date.now() - start;
          const msg = err instanceof Error ? err.message : String(err);
          results[m.id] = {
            status: 'unhealthy',
            engine: m.engine,
            upstreamUrl: m.upstream_url,
            latencyMs,
            error: msg,
          };
        }
      })
    );

    return results;
  }
}

export const modelRegistryService = new ModelRegistryService();
