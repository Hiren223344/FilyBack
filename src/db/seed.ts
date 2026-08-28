import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { hash, Algorithm } from '@node-rs/argon2';
import { fileURLToPath } from 'node:url';
import { query, withTransaction, closePool } from './index.js';
import { Model } from '../types/db.types.js';
import { CREDITS_PER_USD } from '../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ModelsYaml {
  models: Model[];
}

export async function seedModels(modelsFilePath?: string): Promise<void> {
  const filePath = modelsFilePath || path.join(__dirname, '../../models.yaml');
  if (!fs.existsSync(filePath)) {
    throw new Error(`models.yaml not found at path: ${filePath}`);
  }

  const rawYaml = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(rawYaml) as ModelsYaml;

  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error('Invalid models.yaml: expected top-level "models" array');
  }

  console.log(`Seeding ${parsed.models.length} models from ${filePath}...`);

  for (const m of parsed.models) {
    await query(
      `
      INSERT INTO models (
        id, display_name, provider, category, engine, upstream_url, upstream_model,
        ctx_len, max_concurrency, price_in_per_mtok, price_out_per_mtok,
        price_per_image, price_per_audio_min, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        provider = EXCLUDED.provider,
        category = EXCLUDED.category,
        engine = EXCLUDED.engine,
        upstream_url = EXCLUDED.upstream_url,
        upstream_model = EXCLUDED.upstream_model,
        ctx_len = EXCLUDED.ctx_len,
        max_concurrency = EXCLUDED.max_concurrency,
        price_in_per_mtok = EXCLUDED.price_in_per_mtok,
        price_out_per_mtok = EXCLUDED.price_out_per_mtok,
        price_per_image = EXCLUDED.price_per_image,
        price_per_audio_min = EXCLUDED.price_per_audio_min,
        status = EXCLUDED.status;
      `,
      [
        m.id,
        m.display_name,
        m.provider,
        m.category,
        m.engine,
        m.upstream_url,
        m.upstream_model,
        m.ctx_len,
        m.max_concurrency,
        m.price_in_per_mtok,
        m.price_out_per_mtok,
        m.price_per_image,
        m.price_per_audio_min,
        m.status || 'live',
      ]
    );
    console.log(`  ✓ Synced model: ${m.id} (${m.engine} -> ${m.upstream_url})`);
  }

  // Prune any model (and endpoints referencing it) that is no longer declared
  // in models.yaml, so stale seed data can't leak into /v1/models or /healthz.
  const keepIds = parsed.models.map((m) => m.id);
  const prunedEndpoints = await query(
    'DELETE FROM endpoints WHERE model_id <> ALL($1::text[]) RETURNING id',
    [keepIds]
  );
  const prunedModels = await query(
    'DELETE FROM models WHERE id <> ALL($1::text[]) RETURNING id',
    [keepIds]
  );
  if (prunedModels.rowCount || prunedEndpoints.rowCount) {
    console.log(
      `  ✓ Pruned ${prunedModels.rowCount ?? 0} stale model(s) and ${prunedEndpoints.rowCount ?? 0} orphaned endpoint(s)`
    );
  }
}

export async function seedInitialAdmin(): Promise<{
  accountId: string;
  projectId: string;
  apiKey: string;
}> {
  return withTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM accounts WHERE email = $1', [
      'admin@filybase.com',
    ]);

    let accountId: string;
    let projectId: string;
    const defaultApiKey = 'sk-fb-live-demo-key-1234567890abcdef';

    if (existing.rows.length === 0) {
      console.log('Creating initial admin account: admin@filybase.com...');
      const passwordHash = await hash('Password123!', {
        algorithm: Algorithm.Argon2id,
        timeCost: 2,
        memoryCost: 65536,
        parallelism: 2,
      });

      const accRes = await client.query<{ id: string }>(
        'INSERT INTO accounts (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
        ['admin@filybase.com', passwordHash, 'FilyBase Admin']
      );
      const row = accRes.rows[0];
      if (!row) throw new Error('Failed to create account');
      accountId = row.id;

      // Create default project
      const projRes = await client.query<{ id: string }>(
        'INSERT INTO projects (account_id, name) VALUES ($1, $2) RETURNING id',
        [accountId, 'Default Project']
      );
      const projRow = projRes.rows[0];
      if (!projRow) throw new Error('Failed to create project');
      projectId = projRow.id;

      // Seed balance with 50,000,000 credits ($100 USD)
      const initialCredits = 100 * CREDITS_PER_USD; // 50,000,000
      await client.query(
        'INSERT INTO balances (account_id, credits) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET credits = $2',
        [accountId, initialCredits]
      );

      // Ledger entry
      await client.query(
        'INSERT INTO ledger (account_id, delta, reason, ref) VALUES ($1, $2, $3, $4)',
        [accountId, initialCredits, 'Initial account credit seed', 'SYSTEM_SEED']
      );

      // Seed API key
      const keyHash = crypto.createHash('sha256').update(defaultApiKey).digest();
      await client.query(
        'INSERT INTO api_keys (project_id, name, key_hash, prefix, last4) VALUES ($1, $2, $3, $4, $5)',
        [projectId, 'Default Demo Key', keyHash, 'sk-fb-live', 'cdef']
      );

      // Seed a starter endpoint for each currently-registered model.
      await client.query(
        `INSERT INTO endpoints (project_id, name, model_id, live)
         SELECT $1, m.display_name || ' Endpoint', m.id, true
         FROM models m
         ON CONFLICT (project_id, name) DO NOTHING`,
        [projectId]
      );

      console.log('✓ Initial admin, project, balance, and default API key seeded.');
    } else {
      const row = existing.rows[0];
      if (!row) throw new Error('Failed to get existing account');
      accountId = row.id;
      const projRes = await client.query<{ id: string }>(
        'SELECT id FROM projects WHERE account_id = $1 LIMIT 1',
        [accountId]
      );
      const projRow = projRes.rows[0];
      if (!projRow) throw new Error('Failed to get existing project');
      projectId = projRow.id;
      console.log('Admin account already exists.');
    }

    return { accountId, projectId, apiKey: defaultApiKey };
  });
}

export async function runSeed(): Promise<void> {
  await seedModels();
  // The demo admin account ships with a well-known API key — dev/test only.
  if (process.env.NODE_ENV === 'production') {
    console.log('Skipping demo admin seed (NODE_ENV=production).');
  } else {
    await seedInitialAdmin();
  }
  console.log('🎉 Seeding completed successfully.');
}

// If run from CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      await runSeed();
      await closePool();
      process.exit(0);
    } catch (err) {
      console.error('Seeding failed:', err);
      await closePool().catch(() => {});
      process.exit(1);
    }
  })();
}
