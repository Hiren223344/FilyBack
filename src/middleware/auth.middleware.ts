import { FastifyRequest, FastifyReply } from 'fastify';
import { authService } from '../services/auth.service.js';
import { AUTH } from '../config/constants.js';

/**
 * Middleware strictly validating API keys (sk-fb-...) on inference endpoints
 * Rejects session JWTs or malformed tokens with standard OpenAI 401 error.
 */
export async function requireApiKey(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({
      error: {
        message: 'You didn\'t provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer sk-fb-...).',
        type: 'invalid_request_error',
        param: null,
        code: 'missing_api_key',
      },
    });
    return;
  }

  const rawKey = authHeader.slice(7).trim();

  // If someone passes a JWT to inference, reject with clear message
  if (!rawKey.startsWith(AUTH.KEY_PREFIX)) {
    reply.status(401).send({
      error: {
        message: 'Incorrect API key provided. FilyBase inference keys must begin with "sk-fb-". Dashboard session tokens cannot be used for inference.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
    return;
  }

  const resolution = await authService.resolveApiKey(rawKey);

  if (!resolution) {
    reply.status(401).send({
      error: {
        message: 'Incorrect API key provided or key has been revoked.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
    return;
  }

  // Attach resolved data to request context
  req.apiKey = resolution.apiKey;
  req.project = resolution.project;
  req.user = {
    accountId: resolution.account.id,
    email: resolution.account.email,
    name: resolution.project.name,
  };
}
