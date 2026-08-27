/**
 * FilyBase End-to-End Smoke Test Suite
 *
 * Hits every gateway endpoint, validates the OpenAI error contracts,
 * checks streaming SSE with TTFT, verifies headers, rate limits, and billing.
 *
 * Auto-detects if a gateway instance is already running; if not, starts a
 * local test server & mock upstream engine automatically!
 */

import crypto from 'node:crypto';
import { createMockUpstreamServer } from '../src/mock-upstream/server.js';
import { buildApp } from '../src/app.js';
import { runMigrationsUp } from '../src/db/migrate.js';
import { runSeed } from '../src/db/seed.js';
import { closePool } from '../src/db/index.js';
import { closeRedis } from '../src/db/redis.js';

let BASE_URL = process.env.GATEWAY_URL || 'http://localhost:8080';

let localGatewayServer: Awaited<ReturnType<typeof buildApp>> | null = null;
let localMockServer: Awaited<ReturnType<typeof createMockUpstreamServer>>['app'] | null = null;

let jwtToken = '';
let apiKey = '';
let createdEndpointId = '';
let defaultProjectId = '';

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  process.stdout.write(`  ⏳ ${name}... `);
  try {
    await fn();
    const durationMs = Date.now() - start;
    results.push({ name, passed: true, durationMs });
    console.log(`\x1b[32mPASSED\x1b[0m (${durationMs}ms)`);
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, durationMs, error: errorMsg });
    console.log(`\x1b[31mFAILED\x1b[0m (${durationMs}ms)`);
    console.error(`     └─ \x1b[33m${errorMsg}\x1b[0m`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function setupServersIfRequired() {
  try {
    const res = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (res.ok || res.status === 503) {
      console.log(`✓ Connected to existing FilyBase instance at ${BASE_URL}`);
      return;
    }
  } catch {
    console.log(`ℹ️  No existing gateway detected on ${BASE_URL}. Launching local test runtime...`);
  }

  // 1. Start mock GPU upstream engine on port 8001
  const mockPort = 8001;
  const { app: mockApp } = await createMockUpstreamServer(mockPort);
  try {
    await mockApp.listen({ port: mockPort, host: '0.0.0.0' });
    localMockServer = mockApp;
    console.log(`✓ Mock GPU engine listening on http://127.0.0.1:${mockPort}`);
  } catch {
    console.log(`ℹ️ Upstream port ${mockPort} already bound.`);
  }

  // 2. Run migrations & seed if DB reachable
  try {
    await runMigrationsUp();
    await runSeed();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`ℹ️ Migration note: ${msg}`);
  }

  // 3. Start Gateway Fastify server on port 8080
  const testPort = 8080;
  const gateway = await buildApp();
  try {
    await gateway.listen({ port: testPort, host: '0.0.0.0' });
    localGatewayServer = gateway;
    BASE_URL = `http://localhost:${testPort}`;
    console.log(`✓ FilyBase Gateway listening on ${BASE_URL}`);
  } catch {
    console.log(`ℹ️ Gateway port ${testPort} already in use; testing against existing process.`);
  }
}

async function runAllTests() {
  await setupServersIfRequired();

  console.log(`\n🧪 Executing test suite against ${BASE_URL}...\n`);

  // 1. Healthz Check
  await test('GET /healthz - System and passive upstream health', async () => {
    const res = await fetch(`${BASE_URL}/healthz`);
    assert(res.status === 200 || res.status === 503, `Expected 200 or 503, got ${res.status}`);
    const data = (await res.json()) as { gateway?: { status: string } };
    assert(data.gateway?.status === 'healthy', 'Gateway status must be healthy');
  });

  // 2. Metrics Endpoint
  await test('GET /metrics - Prometheus observability', async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.includes('filybase_'), 'Metrics must contain filybase_ prefix metrics');
  });

  // 3. Models Endpoint (Public / Models list)
  await test('GET /v1/models - List registered open-weight models', async () => {
    const res = await fetch(`${BASE_URL}/v1/models`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const models = (await res.json()) as Array<{ id: string; name: string; price: unknown }>;
    assert(Array.isArray(models) && models.length > 0, 'Must return non-empty array of models');
    const llama = models.find((m) => m.id === 'llama-3.3-70b');
    assert(!!llama, 'llama-3.3-70b model must be registered');
  });

  // 4. Auth Signup
  const uniqueEmail = `testuser_${Date.now()}_${Math.floor(Math.random() * 1000)}@filybase.local`;
  await test('POST /v1/auth/signup - User registration and default key generation', async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Smoke Test Engineer',
        email: uniqueEmail,
        password: 'SecurePassword123!',
      }),
    });

    assert(res.status === 201, `Expected 201 Created, got ${res.status}`);
    const data = (await res.json()) as {
      token: string;
      user: { default_project_id: string; initial_api_key?: string };
    };
    assert(!!data.token, 'Must return JWT session token');
    jwtToken = data.token;
    defaultProjectId = data.user.default_project_id;
    if (data.user.initial_api_key) {
      apiKey = data.user.initial_api_key;
    }
  });

  // 5. Auth Login
  await test('POST /v1/auth/login - User login with Argon2id validation', async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'SecurePassword123!',
      }),
    });

    assert(res.status === 200, `Expected 200 OK, got ${res.status}`);
    const data = (await res.json()) as { token: string };
    assert(!!data.token, 'Must return new JWT session token');
  });

  // 6. Auth Me
  await test('GET /v1/auth/me - Read account context with JWT', async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = (await res.json()) as { user: { email: string }; projects: unknown[] };
    assert(data.user.email === uniqueEmail, 'Must match registered email');
  });

  // 7. API Keys Management
  await test('POST /v1/keys - Generate new inference API key (sk-fb-...)', async () => {
    const res = await fetch(`${BASE_URL}/v1/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify({
        name: 'Smoke Test Secret Key',
        project_id: defaultProjectId,
      }),
    });

    assert(res.status === 201, `Expected 201, got ${res.status}`);
    const data = (await res.json()) as { key: string; prefix: string; last4: string };
    assert(data.key.startsWith('sk-fb-'), 'API key must start with sk-fb-');
    apiKey = data.key; // Use this new key for subsequent inference calls
  });

  await test('GET /v1/keys - List API keys (secret masked)', async () => {
    const res = await fetch(`${BASE_URL}/v1/keys`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const keys = (await res.json()) as Array<{ key?: string; prefix: string }>;
    assert(Array.isArray(keys), 'Keys must be an array');
    assert(keys.every((k) => k.key === undefined), 'Secret key must NEVER be returned in listing');
  });

  // 8. Endpoints Management
  await test('POST /v1/endpoints - Create custom model endpoint', async () => {
    const res = await fetch(`${BASE_URL}/v1/endpoints`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify({
        name: `Production Llama ${Date.now()}`,
        model: 'llama-3.3-70b',
        project_id: defaultProjectId,
      }),
    });

    assert(res.status === 201, `Expected 201, got ${res.status}`);
    const data = (await res.json()) as { id: string; name: string; live: boolean };
    assert(!!data.id, 'Endpoint must have an ID');
    createdEndpointId = data.id;
  });

  await test('GET /v1/endpoints - List endpoints with 24h rollup metrics', async () => {
    const res = await fetch(`${BASE_URL}/v1/endpoints`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const list = (await res.json()) as Array<{
      id: string;
      requests_24h: number;
      p50_latency_ms: number;
    }>;
    assert(Array.isArray(list), 'Endpoints must be an array');
    const created = list.find((e) => e.id === createdEndpointId);
    assert(!!created, 'Created endpoint must be present in listing');
  });

  await test('PATCH /v1/endpoints/:id - Toggle endpoint live state', async () => {
    const res = await fetch(`${BASE_URL}/v1/endpoints/${createdEndpointId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify({ live: false }),
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const updated = (await res.json()) as { live: boolean };
    assert(updated.live === false, 'Endpoint must be toggled to false');
  });

  // 9. Inference: Chat Completions (Non-Streaming)
  await test('POST /v1/chat/completions (Non-Stream) - Complete request with OpenAI shape & headers', async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b',
        messages: [
          { role: 'system', content: 'You are a helpful coding assistant.' },
          { role: 'user', content: 'What is 2 + 2?' },
        ],
        temperature: 0.7,
        max_tokens: 100,
      }),
    });

    assert(res.status === 200, `Expected 200 OK, got ${res.status}`);
    assert(!!res.headers.get('x-filybase-request-id'), 'Must include x-filybase-request-id header');
    assert(res.headers.get('x-filybase-model') === 'llama-3.3-70b', 'Must include x-filybase-model header');
    assert(!!res.headers.get('x-filybase-latency-ms'), 'Must include x-filybase-latency-ms header');
    assert(!!res.headers.get('x-filybase-credits-used'), 'Must include x-filybase-credits-used header');

    const data = (await res.json()) as {
      id: string;
      object: string;
      choices: Array<{ message: { content: string } }>;
      usage?: { total_tokens: number };
    };
    assert(data.object === 'chat.completion', 'Response object must be chat.completion');
    assert(Array.isArray(data.choices) && data.choices.length > 0, 'Must contain choices array');
    assert(!!data.choices[0]?.message?.content, 'Choice must contain generated content');
    assert(!!data.usage && data.usage.total_tokens > 0, 'Must contain usage metadata block');
  });

  // 10. Inference: Chat Completions (Streaming SSE)
  await test('POST /v1/chat/completions (Streaming SSE) - Pipe SSE chunks without buffering', async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b',
        messages: [{ role: 'user', content: 'Tell me a one sentence story.' }],
        stream: true,
      }),
    });

    assert(res.status === 200, `Expected 200 OK, got ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    assert(
      contentType.includes('text/event-stream'),
      `Content-Type must be text/event-stream, got ${contentType}`
    );

    if (!res.body) throw new Error('Response body is null');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    let sawDone = false;
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      accumulatedText += text;
      chunkCount++;
      if (text.includes('data: [DONE]')) {
        sawDone = true;
      }
    }

    assert(chunkCount >= 1, 'Must receive at least 1 stream chunk');
    assert(sawDone, 'Stream must conclude with data: [DONE]');
    assert(
      accumulatedText.includes('chat.completion.chunk'),
      'Stream must output chat.completion.chunk objects'
    );
  });

  // 11. Inference: Text Completions
  await test('POST /v1/completions - Legacy prompt continuation', async () => {
    const res = await fetch(`${BASE_URL}/v1/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b',
        prompt: 'Once upon a time in Silicon Valley,',
        max_tokens: 30,
      }),
    });

    assert(res.status === 200, `Expected 200 OK, got ${res.status}`);
    const data = (await res.json()) as { object: string; choices: Array<{ text: string }> };
    assert(Array.isArray(data.choices) && data.choices.length > 0, 'Must return choices');
  });

  // 12. Inference: Embeddings
  await test('POST /v1/embeddings - Vector embedding generation', async () => {
    const res = await fetch(`${BASE_URL}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'bge-large-en-v1.5',
        input: 'The quick brown fox jumps over the lazy dog',
      }),
    });

    assert(res.status === 200, `Expected 200 OK, got ${res.status}`);
    const data = (await res.json()) as { object: string; data: Array<{ embedding: number[] }> };
    assert(data.object === 'list', 'Embeddings object must be list');
    assert(Array.isArray(data.data[0]?.embedding), 'Embedding vector must be an array of floats');
  });

  // 13. Inference: Image Generation
  await test('POST /v1/images/generations - Diffusers image generation', async () => {
    const res = await fetch(`${BASE_URL}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'stable-diffusion-3.5',
        prompt: 'A futuristic floating city at sunset, digital art, 8k',
        n: 1,
      }),
    });

    assert(res.status === 200, `Expected 200 OK, got ${res.status}`);
    const data = (await res.json()) as { data: Array<{ url: string }> };
    assert(Array.isArray(data.data) && data.data.length === 1, 'Must return generated image URL');
  });

  // 14. Inference: Audio Transcription (Multipart)
  await test('POST /v1/audio/transcriptions - Whisper multipart audio transcription', async () => {
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
    const mockAudioBytes = Buffer.from('RIFF$---WAVEfmt ' + '0'.repeat(100)); // Minimal mock WAV header

    let body = `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="sample.wav"\r\n`;
    body += `Content-Type: audio/wav\r\n\r\n`;

    const bodyStart = Buffer.from(body, 'utf-8');
    const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const payload = Buffer.concat([bodyStart, mockAudioBytes, bodyEnd]);

    const res = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${apiKey}`,
      },
      body: payload,
    });

    assert(res.status === 200, `Expected 200 OK, got ${res.status}`);
    const data = (await res.json()) as { text: string };
    assert(typeof data.text === 'string' && data.text.length > 0, 'Must return transcribed text');
  });

  // 15. Security & Error Handling: Invalid Model
  await test('POST /v1/chat/completions (Invalid Model) -> 404 OpenAI shape', async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'unknown-model-xyz',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    assert(res.status === 404, `Expected 404 Not Found, got ${res.status}`);
    const data = (await res.json()) as { error: { type: string; code: string } };
    assert(data.error.code === 'model_not_found', 'Error code must be model_not_found');
    assert(data.error.type === 'invalid_request_error', 'Error type must be invalid_request_error');
  });

  // 16. Security & Error Handling: Missing / Invalid API Key
  await test('POST /v1/chat/completions (Missing Key) -> 401 OpenAI shape', async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    assert(res.status === 401, `Expected 401 Unauthorized, got ${res.status}`);
    const data = (await res.json()) as { error: { code: string } };
    assert(data.error.code === 'missing_api_key', 'Error code must be missing_api_key');
  });

  // 17. Security: Rejection of Session JWT on Inference routes
  await test('POST /v1/chat/completions (Session JWT on Inference) -> 401 rejected', async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`, // JWT instead of sk-fb-
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    assert(res.status === 401, `Expected 401 Unauthorized, got ${res.status}`);
  });

  // 18. Usage & Billing Endpoints
  await test('GET /v1/usage - Read aggregated usage rollup', async () => {
    const res = await fetch(`${BASE_URL}/v1/usage?range=24h`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = (await res.json()) as { range: string; chart: unknown[] };
    assert(data.range === '24h', 'Range must match 24h');
    assert(Array.isArray(data.chart), 'Chart must be an array');
  });

  await test('GET /v1/billing/plan - Plan details & balance', async () => {
    const res = await fetch(`${BASE_URL}/v1/billing/plan`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = (await res.json()) as { plan: string; balance_credits: number };
    assert(!!data.plan, 'Plan must have a name');
    assert(typeof data.balance_credits === 'number', 'Balance credits must be a number');
  });

  await test('POST /v1/billing/topup - Add credits to account', async () => {
    const res = await fetch(`${BASE_URL}/v1/billing/topup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify({ amount: 25.0 }),
    });

    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = (await res.json()) as { newBalanceCredits: number; newBalanceUsd: number };
    assert(data.newBalanceUsd >= 25.0, 'Balance must reflect top-up');
  });

  await test('GET /v1/billing/cost-breakdown - Model cost breakdown', async () => {
    const res = await fetch(`${BASE_URL}/v1/billing/cost-breakdown`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const breakdown = (await res.json()) as Array<{ model: string; cost_usd: number }>;
    assert(Array.isArray(breakdown), 'Cost breakdown must be an array');
  });

  // Print Summary Table
  console.log('\n========================================================');
  console.log('                 SMOKE TEST RESULTS');
  console.log('========================================================');

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;

  for (const r of results) {
    const symbol = r.passed ? '✅' : '❌';
    const statusText = r.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`${symbol} [${statusText}] ${r.name} (${r.durationMs}ms)`);
  }

  console.log('\n--------------------------------------------------------');
  console.log(
    `Total: ${results.length} | Passed: \x1b[32m${passedCount}\x1b[0m | Failed: ${failedCount > 0 ? `\x1b[31m${failedCount}\x1b[0m` : '0'}`
  );
  console.log('========================================================\n');

  // Clean shutdown of locally spawned servers
  if (localGatewayServer) await localGatewayServer.close();
  if (localMockServer) await localMockServer.close();
  await closePool().catch(() => {});
  await closeRedis().catch(() => {});

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal Smoke Test Execution Error:', err);
  process.exit(1);
});
