import '../setup.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { closePool } from '../../src/db/index.js';
import { closeRedis } from '../../src/db/redis.js';

describe('Gateway HTTP Integration & Route Contracts', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
    await closePool().catch(() => {});
    await closeRedis().catch(() => {});
  });

  it('GET /metrics returns 200 and Prometheus formatted metrics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/plain'));
    assert.ok(res.body.includes('filybase_'));
  });

  it('POST /v1/chat/completions without auth returns OpenAI 401 missing_api_key error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'llama-3.3-70b',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.equal(res.statusCode, 401);
    const json = JSON.parse(res.body);
    assert.ok(json.error);
    assert.equal(json.error.code, 'missing_api_key');
    assert.equal(json.error.type, 'invalid_request_error');
  });

  it('POST /v1/chat/completions with non-sk-fb token returns OpenAI 401 invalid_api_key error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer invalid_prefix_key',
      },
      payload: {
        model: 'llama-3.3-70b',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.equal(res.statusCode, 401);
    const json = JSON.parse(res.body);
    assert.ok(json.error);
    assert.equal(json.error.code, 'invalid_api_key');
  });

  it('POST /v1/auth/signup with invalid email format returns 400 validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        name: 'Test',
        email: 'not-an-email',
        password: 'password123',
      },
    });

    assert.equal(res.statusCode, 400);
    const json = JSON.parse(res.body);
    assert.equal(json.error, 'Validation Error');
  });

  it('POST /v1/auth/signup with short password returns 400 validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        name: 'Test',
        email: 'valid@example.com',
        password: '123',
      },
    });

    assert.equal(res.statusCode, 400);
    const json = JSON.parse(res.body);
    assert.equal(json.error, 'Validation Error');
  });
});
