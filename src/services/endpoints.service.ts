import { query } from '../db/index.js';
import { Endpoint, EndpointWithStats } from '../types/db.types.js';

export class EndpointsService {
  /**
   * List endpoints with 24h metrics from the materialized hourly rollup
   */
  async listEndpoints(accountId: string, projectId?: string): Promise<EndpointWithStats[]> {
    const params: unknown[] = [accountId];
    let projectFilter = '';

    if (projectId) {
      params.push(projectId);
      projectFilter = `AND e.project_id = $2`;
    }

    const res = await query<{
      id: string;
      name: string;
      model: string;
      live: boolean;
      created_at: Date;
      requests_24h: string | number;
      p50_latency_ms: string | number;
    }>(
      `
      SELECT 
        e.id,
        e.name,
        e.model_id AS model,
        e.live,
        e.created_at,
        COALESCE(SUM(r.request_count), 0)::int AS requests_24h,
        COALESCE(AVG(r.p50_latency_ms), 0)::int AS p50_latency_ms
      FROM endpoints e
      JOIN projects p ON p.id = e.project_id
      LEFT JOIN usage_hourly_rollup r 
        ON r.endpoint_id = e.id 
        AND r.hour >= NOW() - INTERVAL '24 hours'
      WHERE p.account_id = $1
        ${projectFilter}
      GROUP BY e.id, e.name, e.model_id, e.live, e.created_at
      ORDER BY e.created_at DESC;
      `,
      params
    );

    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      model: r.model,
      live: r.live,
      requests_24h: Number(r.requests_24h) || 0,
      p50_latency_ms: Number(r.p50_latency_ms) || 0,
      created_at: r.created_at,
    }));
  }

  /**
   * Create an endpoint for a project
   */
  async createEndpoint(
    projectId: string,
    name: string,
    modelId: string
  ): Promise<Endpoint> {
    const res = await query<Endpoint>(
      `
      INSERT INTO endpoints (project_id, name, model_id, live)
      VALUES ($1, $2, $3, true)
      RETURNING id, project_id, name, model_id, live, created_at;
      `,
      [projectId, name, modelId]
    );
    const row = res.rows[0];
    if (!row) throw new Error('Failed to create endpoint');
    return row;
  }

  /**
   * Toggle endpoint live state
   */
  async updateEndpoint(
    endpointId: string,
    accountId: string,
    live: boolean
  ): Promise<Endpoint | null> {
    const res = await query<Endpoint>(
      `
      UPDATE endpoints e
      SET live = $1
      FROM projects p
      WHERE e.id = $2
        AND e.project_id = p.id
        AND p.account_id = $3
      RETURNING e.id, e.project_id, e.name, e.model_id, e.live, e.created_at;
      `,
      [live, endpointId, accountId]
    );
    return res.rows[0] || null;
  }

  /**
   * Delete an endpoint
   */
  async deleteEndpoint(endpointId: string, accountId: string): Promise<boolean> {
    const res = await query(
      `
      DELETE FROM endpoints e
      USING projects p
      WHERE e.id = $1
        AND e.project_id = p.id
        AND p.account_id = $2;
      `,
      [endpointId, accountId]
    );
    return (res.rowCount || 0) > 0;
  }
}

export const endpointsService = new EndpointsService();
