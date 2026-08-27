import { FastifyRequest, FastifyReply } from 'fastify';
import { authService, UserPayload } from '../services/auth.service.js';

/**
 * Middleware validating JWT session tokens for dashboard routes
 * Rejects inference API keys (sk-fb-...) on dashboard endpoints.
 */
export async function requireJwtAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  // Reject API keys on dashboard routes
  if (token && token.startsWith('sk-fb-')) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'API keys (sk-fb-...) cannot be used on dashboard routes. Please use a JWT session token.',
    });
    return;
  }

  if (!token) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Authentication token required.',
    });
    return;
  }

  try {
    const payload: UserPayload = authService.verifyAccessToken(token);
    req.user = payload;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid or expired session token';
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message,
    });
  }
}
