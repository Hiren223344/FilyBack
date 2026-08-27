import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, withTransaction, closePool } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function runMigrationsUp(): Promise<void> {
  await ensureMigrationTable();

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  const appliedRows = await query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY id ASC'
  );
  const appliedSet = new Set(appliedRows.rows.map((r) => r.name));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`Migration already applied: ${file}`);
      continue;
    }

    console.log(`Applying migration: ${file}...`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });

    console.log(`✓ Migration applied successfully: ${file}`);
  }
}

export async function runMigrationsDown(): Promise<void> {
  await ensureMigrationTable();

  const appliedRows = await query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY id DESC'
  );

  if (appliedRows.rows.length === 0) {
    console.log('No migrations to rollback.');
    return;
  }

  const latest = appliedRows.rows[0];
  if (!latest) return;
  const downFile = latest.name.replace('.sql', '.down.sql');
  const downPath = path.join(MIGRATIONS_DIR, downFile);

  if (!fs.existsSync(downPath)) {
    throw new Error(`Down migration file not found: ${downFile}`);
  }

  console.log(`Rolling back migration: ${latest.name} using ${downFile}...`);
  const sql = fs.readFileSync(downPath, 'utf-8');

  await withTransaction(async (client) => {
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [latest.name]);
  });

  console.log(`✓ Rollback successful: ${latest.name}`);
}

// If invoked directly from CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const direction = process.argv[2] || 'up';
  (async () => {
    try {
      if (direction === 'down') {
        await runMigrationsDown();
      } else {
        await runMigrationsUp();
      }
      await closePool();
      process.exit(0);
    } catch (err) {
      console.error('Migration failed:', err);
      await closePool().catch(() => {});
      process.exit(1);
    }
  })();
}
