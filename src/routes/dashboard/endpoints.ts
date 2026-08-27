import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireJwtAuth } from '../../middleware/jwt.middleware.js';
import { endpointsService } from '../../services/endpoints.service.js';
import { query } from '../../db/index.js';

const CreateEndpointSchema = z.object({
  name: z.string().min(1, 'Endpoint name is required').max(100),
  model: z.string().min(1, 'Model ID is required'),
  project_id: z.string().uuid().optional(),
});

const ToggleEndpointSchema = z.object({
  live: z.boolean(),
});

export const endpointsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', requireJwtAuth);

  /**
   * GET /v1/endpoints
   */
  fastify.get('/endpoints', async (req, reply) => {
    const user = req.user!;
    const endpoints = await endpointsService.listEndpoints(user.accountId);
    reply.send(endpoints);
  });

  /**
   * POST /v1/endpoints
   */
  fastify.post('/endpoints', async (req, reply) => {
    const user = req.user!;
    const parseResult = CreateEndpointSchema.safeParse(req.body);

    if (!parseResult.success) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid input',
      });
      return;
    }

    const { name, model, project_id } = parseResult.data;

    let targetProjectId = project_id;
    if (!targetProjectId) {
      // Find first project for account
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

    // Verify model exists
    const modelCheck = await query('SELECT id FROM models WHERE id = $1', [model]);
    if (modelCheck.rows.length === 0) {
      reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Model '${model}' not found`,
      });
      return;
    }

    try {
      const created = await endpointsService.createEndpoint(targetProjectId, name, model);
      reply.status(201).send(created);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') || msg.includes('uq_endpoints_project_name')) {
        reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `An endpoint named '${name}' already exists in this project`,
        });
        return;
      }
      throw err;
    }
  });

  /**
   * PATCH /v1/endpoints/:id
   */
  fastify.patch('/endpoints/:id', async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const parseResult = ToggleEndpointSchema.safeParse(req.body);

    if (!parseResult.success) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid input',
      });
      return;
    }

    const updated = await endpointsService.updateEndpoint(
      id,
      user.accountId,
      parseResult.data.live
    );

    if (!updated) {
      reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Endpoint not found or does not belong to your account',
      });
      return;
    }

    reply.send(updated);
  });

  /**
   * DELETE /v1/endpoints/:id
   */
  fastify.delete('/endpoints/:id', async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };

    const deleted = await endpointsService.deleteEndpoint(id, user.accountId);
    if (!deleted) {
      reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Endpoint not found or does not belong to your account',
      });
      return;
    }

    reply.status(204).send();
  });
};
