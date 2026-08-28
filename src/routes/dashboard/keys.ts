import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireJwtAuth } from '../../middleware/jwt.middleware.js';
import { authService } from '../../services/auth.service.js';
import { query } from '../../db/index.js';

const CreateKeySchema = z.object({
  name: z.string().min(1, 'Key name is required').max(100),
  project_id: z.string().uuid().optional(),
});

export const keysRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', requireJwtAuth);

  /**
   * GET /v1/keys
   */
  fastify.get('/keys', async (req, reply) => {
    const user = req.user!;

    const res = await query<{
      id: string;
      project_id: string;
      name: string;
      prefix: string;
      last4: string;
      revoked_at: Date | null;
      last_used_at: Date | null;
      created_at: Date;
    }>(
      `
      SELECT 
        k.id, k.project_id, k.name, k.prefix, k.last4,
        k.revoked_at, k.last_used_at, k.created_at
      FROM api_keys k
      JOIN projects p ON p.id = k.project_id
      WHERE p.account_id = $1
      ORDER BY k.created_at DESC;
      `,
      [user.accountId]
    );

    reply.send(res.rows);
  });

  /**
   * POST /v1/keys - Returns full secret key once only
   */
  fastify.post('/keys', async (req, reply) => {
    const user = req.user!;
    const parseResult = CreateKeySchema.safeParse(req.body);

    if (!parseResult.success) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid input',
      });
      return;
    }

    const { name, project_id } = parseResult.data;

    let targetProjectId = project_id;
    if (!targetProjectId) {
      const projRes = await query<{ id: string }>(
        'SELECT id FROM projects WHERE account_id = $1 ORDER BY created_at ASC LIMIT 1',
        [user.accountId]
      );
      if (projRes.rows.length === 0) {
        reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'No project found for this account',
        });
        return;
      }
      targetProjectId = projRes.rows[0]!.id;
    }

    const keyData = authService.generateApiKey();

    const insertRes = await query<{ id: string; created_at: Date }>(
      `
      INSERT INTO api_keys (project_id, name, key_hash, prefix, last4)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, created_at;
      `,
      [targetProjectId, name, keyData.keyHash, keyData.prefix, keyData.last4]
    );

    const row = insertRes.rows[0];
    if (!row) throw new Error('Failed to create API key');

    // Return the full secret key ONLY here
    reply.status(201).send({
      id: row.id,
      name,
      project_id: targetProjectId,
      key: keyData.rawKey,
      prefix: keyData.prefix,
      last4: keyData.last4,
      created_at: row.created_at,
    });
  });

  /**
   * DELETE /v1/keys/:id - Revoke key
   */
  fastify.delete('/keys/:id', async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };

    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: 'Invalid API key id',
      });
      return;
    }

    const findKey = await query<{ key_hash: Buffer; revoked_at: Date | null }>(
      `
      SELECT k.key_hash, k.revoked_at
      FROM api_keys k
      JOIN projects p ON p.id = k.project_id
      WHERE k.id = $1 AND p.account_id = $2
      LIMIT 1;
      `,
      [id, user.accountId]
    );

    if (findKey.rows.length === 0) {
      reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'API key not found',
      });
      return;
    }

    const keyHash = findKey.rows[0]!.key_hash;

    if (findKey.rows[0]!.revoked_at !== null) {
      // Already revoked — idempotent success, but skip the write.
      await authService.invalidateKeyCache(keyHash);
      reply.status(204).send();
      return;
    }

    // Ownership re-checked in the WHERE clause as defense in depth.
    await query(
      `
      UPDATE api_keys k
      SET revoked_at = NOW()
      FROM projects p
      WHERE k.id = $1 AND k.project_id = p.id AND p.account_id = $2;
      `,
      [id, user.accountId]
    );

    // Invalidate Redis cache
    await authService.invalidateKeyCache(keyHash);

    reply.status(204).send();
  });
};
