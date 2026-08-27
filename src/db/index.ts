import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_MAX_CONNECTIONS,
  idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_CONNECTION_TIMEOUT_MS,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
    console.debug('Executed DB query', { text, duration, rows: res.rowCount });
  }
  return res;
}

export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDbHealth(): Promise<{ status: 'healthy' | 'unhealthy'; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'unhealthy', latencyMs: Date.now() - start, error: message };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
