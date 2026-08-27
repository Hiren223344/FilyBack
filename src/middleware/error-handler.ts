import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { OpenAIErrorShape } from '../types/openai.types.js';

export function errorHandler(
  error: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply
): void {
  const isAiRoute =
    req.url.startsWith('/v1/chat') ||
    req.url.startsWith('/v1/completions') ||
    req.url.startsWith('/v1/images') ||
    req.url.startsWith('/v1/audio') ||
    req.url.startsWith('/v1/embeddings');

  const statusCode = error.statusCode || 500;

  // Structured sanitized error logging (NO request bodies, NO authorization headers)
  console.error({
    event: 'request_error',
    requestId: req.requestId,
    url: req.url,
    method: req.method,
    statusCode,
    errorCode: error.code,
    errorMessage: error.message,
  });

  if (isAiRoute) {
    let errorType = 'api_error';
    if (statusCode === 400 || statusCode === 422) errorType = 'invalid_request_error';
    else if (statusCode === 401) errorType = 'authentication_error';
    else if (statusCode === 402) errorType = 'insufficient_credits';
    else if (statusCode === 404) errorType = 'invalid_request_error';
    else if (statusCode === 429) errorType = 'rate_limit_exceeded';

    const openAiError: OpenAIErrorShape = {
      error: {
        message: error.message || 'An internal error occurred processing your request.',
        type: errorType,
        param: null,
        code: error.code || null,
      },
    };

    reply.status(statusCode).send(openAiError);
    return;
  }

  // Dashboard RFC 7807 error format
  reply.status(statusCode).send({
    statusCode,
    error: error.name || 'Internal Server Error',
    message: error.message || 'Something went wrong',
    requestId: req.requestId,
  });
}
