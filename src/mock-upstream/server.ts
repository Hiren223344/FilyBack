import Fastify from 'fastify';
import multipart from '@fastify/multipart';

export async function createMockUpstreamServer(port: number = 8001) {
  const app = Fastify({ logger: false });

  await app.register(multipart);

  // Health endpoint
  app.get('/health', async (_req, reply) => {
    reply.send({ status: 'ok', engine: 'filybase-mock-upstream' });
  });

  // Models endpoint
  app.get('/v1/models', async (_req, reply) => {
    reply.send({
      object: 'list',
      data: [
        { id: 'openai/gpt-oss-120b', object: 'model', owned_by: 'filybase' },
        { id: 'meta-llama/Llama-3.3-70B-Instruct', object: 'model', owned_by: 'vllm' },
        { id: 'meta-llama/Llama-3.1-8B-Instruct', object: 'model', owned_by: 'vllm' },
        { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', object: 'model', owned_by: 'vllm' },
        { id: 'Qwen/Qwen2.5-72B-Instruct', object: 'model', owned_by: 'vllm' },
      ],
    });
  });

  // OpenAI Chat Completions (vLLM simulation)
  app.post('/v1/chat/completions', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const model = String(body['model'] || 'meta-llama/Llama-3.3-70B-Instruct');
    const isStream = Boolean(body['stream']);
    const messages = (body['messages'] as Array<{ role: string; content: string }>) || [];
    const lastUserMessage = messages[messages.length - 1]?.content || 'Hello';

    const mockResponseText = `FilyBase GPU response for model [${model}]: Generated answer to "${String(lastUserMessage).slice(0, 40)}"`;

    if (isStream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const words = mockResponseText.split(' ');
      const promptTokens = Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
      const completionTokens = words.length;

      // Stream words with small delay to simulate generation
      for (let i = 0; i < words.length; i++) {
        const chunk = {
          id: `chatcmpl-${Date.now()}-${i}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content: (i > 0 ? ' ' : '') + words[i] },
              finish_reason: i === words.length - 1 ? 'stop' : null,
            },
          ],
        };
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // If stream_options.include_usage was requested (vLLM contract)
      const streamOptions = body['stream_options'] as { include_usage?: boolean } | undefined;
      if (streamOptions?.include_usage) {
        const usageChunk = {
          id: `chatcmpl-usage-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
        reply.raw.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
      }

      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return;
    }

    const promptTokens = Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
    const completionTokens = mockResponseText.split(' ').length;

    reply.send({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: mockResponseText,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  });

  // Text Completions (vLLM simulation)
  app.post('/v1/completions', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const model = String(body['model'] || 'meta-llama/Llama-3.3-70B-Instruct');
    const prompt = String(body['prompt'] || '');
    const isStream = Boolean(body['stream']);

    const mockResponseText = ` completed text continuation for: ${prompt.slice(0, 30)}`;

    if (isStream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const chunk = {
        id: `cmpl-${Date.now()}`,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ text: mockResponseText, index: 0, finish_reason: 'stop' }],
      };
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return;
    }

    reply.send({
      id: `cmpl-${Date.now()}`,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ text: mockResponseText, index: 0, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)),
        completion_tokens: 16,
        total_tokens: Math.max(1, Math.ceil(prompt.length / 4)) + 16,
      },
    });
  });

  // Diffusers Image Generation
  app.post('/v1/images/generations', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const prompt = String(body['prompt'] || 'A high quality image');
    const n = Number(body['n']) || 1;

    const data = Array.from({ length: n }, (_, i) => ({
      url: `https://images.filybase.local/mock-generated-${Date.now()}-${i}.png`,
      revised_prompt: prompt,
    }));

    reply.send({
      created: Math.floor(Date.now() / 1000),
      data,
    });
  });

  // Faster-Whisper Audio Transcription
  app.post('/v1/audio/transcriptions', async (req, reply) => {
    const parts = req.parts();
    let fileFound = false;

    for await (const part of parts) {
      if (part.type === 'file') {
        fileFound = true;
        await part.toBuffer();
      }
    }

    reply.send({
      text: 'This is a simulated transcript from FilyBase Whisper GPU audio inference.',
      duration: 12.5,
      language: 'en',
    });
  });

  // TEI Embeddings
  app.post('/v1/embeddings', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const input = body['input'];
    const inputs = Array.isArray(input) ? input : [input];

    const data = inputs.map((_, idx) => ({
      object: 'embedding',
      index: idx,
      embedding: Array.from({ length: 1024 }, () => Number((Math.random() * 2 - 1).toFixed(6))),
    }));

    const tokens = inputs.reduce((acc, str) => acc + Math.max(1, Math.ceil(String(str).length / 4)), 0);

    reply.send({
      object: 'list',
      data,
      model: String(body['model'] || 'BAAI/bge-large-en-v1.5'),
      usage: {
        prompt_tokens: tokens,
        total_tokens: tokens,
      },
    });
  });

  return { app, port };
}

// If executed directly from CLI
if (process.argv[1] && process.argv[1].includes('mock-upstream/server')) {
  (async () => {
    const port = Number(process.env.MOCK_UPSTREAM_PORT) || 8001;
    const { app } = await createMockUpstreamServer(port);
    try {
      await app.listen({ port, host: '0.0.0.0' });
      console.log(`🚀 Mock GPU Upstream Server running at http://127.0.0.1:${port}`);
    } catch (err) {
      console.error('Failed to start mock upstream:', err);
      process.exit(1);
    }
  })();
}
