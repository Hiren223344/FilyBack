import { FastifyRequest, FastifyReply } from 'fastify';
import { createParser, EventSourceMessage } from 'eventsource-parser';
import { Model } from '../types/db.types.js';
import { Usage, ChatCompletionResponse, OpenAIErrorShape } from '../types/openai.types.js';
import { HEADERS } from '../config/constants.js';
import { metrics } from './metrics.service.js';

export interface ProxyNonStreamResult {
  statusCode: number;
  data: unknown;
  usage: Usage;
  latencyMs: number;
}

export interface ProxyStreamResult {
  statusCode: number;
  usage: Usage;
  latencyMs: number;
  ttftMs: number;
}

export class ProxyService {
  /**
   * Non-streaming proxy to upstream engine
   */
  async proxyNonStreaming(
    req: FastifyRequest,
    model: Model,
    upstreamPath: string,
    payload: Record<string, unknown>
  ): Promise<ProxyNonStreamResult> {
    const startTime = req.startTime || Date.now();
    const url = `${model.upstream_url.replace(/\/v1\/?$/, '')}/v1${upstreamPath}`;

    // Rewrite model in payload to upstream model name
    const upstreamPayload = {
      ...payload,
      model: model.upstream_model,
      stream: false,
    };

    const controller = new AbortController();
    const onClientClose = () => {
      controller.abort();
    };
    req.raw.on('close', onClientClose);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(upstreamPayload),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;
      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        return {
          statusCode: response.status,
          data,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          latencyMs,
        };
      }

      // Extract usage if present
      let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      if (data && typeof data === 'object' && 'usage' in data && data['usage']) {
        const u = data['usage'] as Partial<Usage>;
        usage = {
          prompt_tokens: Number(u.prompt_tokens) || 0,
          completion_tokens: Number(u.completion_tokens) || 0,
          total_tokens: Number(u.total_tokens) || 0,
        };
      } else if (model.category === 'embedding') {
        // Approximate for embeddings if upstream omitted usage
        const input = payload['input'];
        let tokenCount = 1;
        if (typeof input === 'string') tokenCount = Math.max(1, Math.ceil(input.length / 4));
        else if (Array.isArray(input)) tokenCount = Math.max(1, Math.ceil(JSON.stringify(input).length / 4));
        usage = { prompt_tokens: tokenCount, completion_tokens: 0, total_tokens: tokenCount };
      }

      // If data is a ChatCompletionResponse, add latency_ms field
      if (data && typeof data === 'object' && data['object'] === 'chat.completion') {
        (data as unknown as ChatCompletionResponse).latency_ms = latencyMs;
      }

      return {
        statusCode: response.status,
        data,
        usage,
        latencyMs,
      };
    } finally {
      req.raw.removeListener('close', onClientClose);
    }
  }

  /**
   * Streaming SSE proxy to upstream engine with zero buffering and TTFT recording
   */
  async proxyStreaming(
    req: FastifyRequest,
    reply: FastifyReply,
    model: Model,
    upstreamPath: string,
    payload: Record<string, unknown>
  ): Promise<ProxyStreamResult> {
    const startTime = req.startTime || Date.now();
    const url = `${model.upstream_url.replace(/\/v1\/?$/, '')}/v1${upstreamPath}`;

    // Configure payload with stream_options: { include_usage: true } for vLLM
    const upstreamPayload = {
      ...payload,
      model: model.upstream_model,
      stream: true,
      stream_options: {
        include_usage: true,
        ...(typeof payload['stream_options'] === 'object' && payload['stream_options'] !== null
          ? (payload['stream_options'] as Record<string, unknown>)
          : {}),
      },
    };

    const controller = new AbortController();
    let clientDisconnected = false;

    const onClientClose = () => {
      clientDisconnected = true;
      controller.abort();
    };
    req.raw.on('close', onClientClose);

    let ttftMs = 0;
    let hasReceivedFirstToken = false;
    let extractedUsage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let estimatedChunkTokens = 0;

    try {
      const upstreamResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
        },
        body: JSON.stringify(upstreamPayload),
        signal: controller.signal,
      });

      if (!upstreamResponse.ok) {
        const errorData = (await upstreamResponse.json().catch(() => ({}))) as OpenAIErrorShape;
        const latencyMs = Date.now() - startTime;
        reply.status(upstreamResponse.status).send(errorData);
        return {
          statusCode: upstreamResponse.status,
          usage: extractedUsage,
          latencyMs,
          ttftMs: 0,
        };
      }

      if (!upstreamResponse.body) {
        throw new Error('Upstream response body is null');
      }

      // Initialize SSE streaming headers to the client
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        [HEADERS.REQUEST_ID]: req.requestId,
        [HEADERS.MODEL]: model.id,
        'Trailer': `${HEADERS.LATENCY_MS}, ${HEADERS.TTFT_MS}, ${HEADERS.CREDITS_USED}`,
      });

      const parser = createParser({
        onEvent: (event: EventSourceMessage) => {
          if (!hasReceivedFirstToken && event.data && event.data !== '[DONE]') {
            hasReceivedFirstToken = true;
            ttftMs = Date.now() - startTime;
            metrics.ttftSeconds.labels(model.id, model.engine).observe(ttftMs / 1000);
          }

          if (event.data && event.data !== '[DONE]') {
            try {
              const parsed = JSON.parse(event.data) as {
                usage?: Usage;
                choices?: Array<{ delta?: { content?: string } }>;
              };
              if (parsed.usage) {
                extractedUsage = {
                  prompt_tokens: Number(parsed.usage.prompt_tokens) || 0,
                  completion_tokens: Number(parsed.usage.completion_tokens) || 0,
                  total_tokens: Number(parsed.usage.total_tokens) || 0,
                };
              }
              if (parsed.choices && parsed.choices[0]?.delta?.content) {
                estimatedChunkTokens += 1;
              }
            } catch {
              // Ignore non-JSON delta parse errors
            }
          }
        },
      });

      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          const textChunk = decoder.decode(value, { stream: true });
          parser.feed(textChunk);

          if (!reply.raw.writableEnded && !clientDisconnected) {
            reply.raw.write(value);
          }
        }
      }

      const latencyMs = Date.now() - startTime;

      // Fallback token estimation if upstream didn't send usage block
      if (extractedUsage.total_tokens === 0 && estimatedChunkTokens > 0) {
        extractedUsage.completion_tokens = estimatedChunkTokens;
        extractedUsage.prompt_tokens = Math.max(1, Math.ceil(JSON.stringify(payload).length / 8));
        extractedUsage.total_tokens = extractedUsage.prompt_tokens + extractedUsage.completion_tokens;
      }

      // Add HTTP Trailers before terminating stream
      try {
        if (!reply.raw.writableEnded) {
          reply.raw.addTrailers({
            [HEADERS.LATENCY_MS]: latencyMs.toString(),
            [HEADERS.TTFT_MS]: ttftMs.toString(),
          });
          reply.raw.end();
        }
      } catch {
        // Client might have already closed
      }

      return {
        statusCode: 200,
        usage: extractedUsage,
        latencyMs,
        ttftMs,
      };
    } catch (err: unknown) {
      if (clientDisconnected || (err instanceof Error && err.name === 'AbortError')) {
        const latencyMs = Date.now() - startTime;
        return {
          statusCode: 499, // Client Closed Request
          usage: extractedUsage,
          latencyMs,
          ttftMs,
        };
      }
      throw err;
    } finally {
      req.raw.removeListener('close', onClientClose);
    }
  }

  /**
   * Proxy image generation to diffusers upstream
   */
  async proxyImageGeneration(
    req: FastifyRequest,
    model: Model,
    payload: Record<string, unknown>
  ): Promise<{ statusCode: number; data: unknown; imagesCount: number; latencyMs: number }> {
    const startTime = req.startTime || Date.now();
    const url = `${model.upstream_url.replace(/\/v1\/?$/, '')}/v1/images/generations`;

    const upstreamPayload = {
      ...payload,
      model: model.upstream_model,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(upstreamPayload),
    });

    const latencyMs = Date.now() - startTime;
    const data = (await response.json()) as Record<string, unknown>;
    const n = Number(payload['n']) || 1;

    return {
      statusCode: response.status,
      data,
      imagesCount: response.ok ? n : 0,
      latencyMs,
    };
  }

  /**
   * Proxy multipart audio transcription to faster-whisper upstream
   */
  async proxyAudioTranscription(
    req: FastifyRequest,
    model: Model,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
    fields: Record<string, string>
  ): Promise<{ statusCode: number; data: unknown; audioSec: number; latencyMs: number }> {
    const startTime = req.startTime || Date.now();
    const url = `${model.upstream_url.replace(/\/v1\/?$/, '')}/v1/audio/transcriptions`;

    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType || 'audio/wav' });
    formData.append('file', blob, fileName || 'audio.wav');
    formData.append('model', model.upstream_model);

    for (const [k, v] of Object.entries(fields)) {
      if (k !== 'file' && k !== 'model') {
        formData.append(k, v);
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    const latencyMs = Date.now() - startTime;
    const data = (await response.json()) as Record<string, unknown>;

    // Estimate audio seconds (e.g. from duration field or file size ~16KB/s for 128kbps)
    let audioSec = 30; // default 30s
    if (data && typeof data === 'object' && 'duration' in data) {
      audioSec = Math.ceil(Number(data['duration']) || 30);
    } else if (fileBuffer.length > 0) {
      audioSec = Math.max(1, Math.ceil(fileBuffer.length / 16000));
    }

    return {
      statusCode: response.status,
      data,
      audioSec: response.ok ? audioSec : 0,
      latencyMs,
    };
  }
}

export const proxyService = new ProxyService();
