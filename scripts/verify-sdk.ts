/**
 * Verification of official Node.js `openai` SDK compatibility with FilyBase
 */

import OpenAI from 'openai';
import { createMockUpstreamServer } from '../src/mock-upstream/server.js';
import { buildApp } from '../src/app.js';
import { runMigrationsUp } from '../src/db/migrate.js';
import { runSeed } from '../src/db/seed.js';
import { closePool } from '../src/db/index.js';
import { closeRedis } from '../src/db/redis.js';

let BASE_URL = process.env.GATEWAY_URL ? `${process.env.GATEWAY_URL}/v1` : 'http://localhost:8080/v1';
const API_KEY = process.env.FILYBASE_API_KEY || 'sk-fb-live-demo-key-1234567890abcdef';

let localGatewayServer: Awaited<ReturnType<typeof buildApp>> | null = null;
let localMockServer: Awaited<ReturnType<typeof createMockUpstreamServer>>['app'] | null = null;

async function setupIfRequired() {
  try {
    const res = await fetch(`${BASE_URL.replace(/\/v1$/, '')}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (res.ok || res.status === 503) {
      console.log(`✓ Connected to existing FilyBase instance at ${BASE_URL}`);
      return;
    }
  } catch {
    console.log(`ℹ️  Launching local mock upstream & gateway runtime for SDK verification...`);
  }

  // 1. Mock upstream on 8001
  const mockPort = 8001;
  const { app: mockApp } = await createMockUpstreamServer(mockPort);
  try {
    await mockApp.listen({ port: mockPort, host: '0.0.0.0' });
    localMockServer = mockApp;
  } catch {
    // Already running
  }

  // 2. Migrations & Seed
  try {
    await runMigrationsUp();
    await runSeed();
  } catch {
    // Database may be offline during quick test
  }

  // 3. Gateway on 8080
  const gateway = await buildApp();
  try {
    await gateway.listen({ port: 8080, host: '0.0.0.0' });
    localGatewayServer = gateway;
    BASE_URL = 'http://localhost:8080/v1';
  } catch {
    // Port in use
  }
}

async function main() {
  await setupIfRequired();

  console.log(`\n🤖 Testing Official OpenAI Node.js SDK against FilyBase:`);
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   API Key:  ${API_KEY.slice(0, 10)}...`);

  const client = new OpenAI({
    baseURL: BASE_URL,
    apiKey: API_KEY,
  });

  // 1. Test Non-Streaming Chat Completion
  console.log('\n1️⃣ Testing client.chat.completions.create (non-streaming)...');
  const chatResponse = await client.chat.completions.create({
    model: 'llama-3.3-70b',
    messages: [
      { role: 'system', content: 'You are an AI assistant powered by FilyBase GPU server.' },
      { role: 'user', content: 'Explain zero-retention architecture in one sentence.' },
    ],
  });

  console.log('   Response ID:', chatResponse.id);
  console.log('   Model:', chatResponse.model);
  console.log('   Content:', chatResponse.choices[0]?.message.content);
  console.log('   Tokens used:', chatResponse.usage?.total_tokens);

  // 2. Test Streaming Chat Completion
  console.log('\n2️⃣ Testing client.chat.completions.create (streaming)...');
  const stream = await client.chat.completions.create({
    model: 'llama-3.3-70b',
    messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
    stream: true,
  });

  process.stdout.write('   Stream output: "');
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || '';
    process.stdout.write(text);
  }
  console.log('"\n');

  // 3. Test Embeddings
  console.log('3️⃣ Testing client.embeddings.create...');
  const embeddingResponse = await client.embeddings.create({
    model: 'bge-large-en-v1.5',
    input: 'FilyBase high-throughput serverless GPU gateway',
  });

  console.log('   Embedding vector dimension:', embeddingResponse.data[0]?.embedding.length);
  console.log('   Prompt tokens:', embeddingResponse.usage?.prompt_tokens);

  // 4. Test Images
  console.log('\n4️⃣ Testing client.images.generate...');
  const imageResponse = await client.images.generate({
    model: 'stable-diffusion-3.5',
    prompt: 'A datacenter server room glowing with neon blue LEDs',
    n: 1,
  });

  console.log('   Generated Image URL:', imageResponse.data?.[0]?.url);

  console.log('\n✅ Official OpenAI Node.js SDK verified successfully with FilyBase!\n');

  if (localGatewayServer) await localGatewayServer.close();
  if (localMockServer) await localMockServer.close();
  await closePool().catch(() => {});
  await closeRedis().catch(() => {});
}

main().catch(async (err) => {
  console.error('\n❌ SDK Verification Error:', err);
  if (localGatewayServer) await localGatewayServer.close().catch(() => {});
  if (localMockServer) await localMockServer.close().catch(() => {});
  await closePool().catch(() => {});
  await closeRedis().catch(() => {});
  process.exit(1);
});
