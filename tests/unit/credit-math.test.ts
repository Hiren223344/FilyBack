import '../setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CreditsService } from '../../src/redis/credits.service.js';
import { CREDITS_PER_USD } from '../../src/config/constants.js';
import { Model } from '../../src/types/db.types.js';

describe('CreditsService & Pricing Math', () => {
  const creditsService = new CreditsService();

  const mockGptOssModel: Model = {
    id: 'gpt-oss-120b',
    display_name: 'GPT OSS 120B',
    provider: 'Filybase',
    category: 'text',
    engine: 'vllm',
    upstream_url: 'http://150.136.129.227:8000/v1',
    upstream_model: 'openai/gpt-oss-120b',
    ctx_len: 131072,
    max_concurrency: 32,
    price_in_per_mtok: 0.03, // $0.03 per Mtok -> 0.015 credit / token
    price_out_per_mtok: 0.15, // $0.15 per Mtok -> 0.075 credit / token
    price_per_image: 0,
    price_per_audio_min: 0,
    status: 'live',
  };

  const mockTextModel: Model = {
    id: 'llama-3.3-70b',
    display_name: 'Llama 3.3 70B Instruct',
    provider: 'Meta',
    category: 'text',
    engine: 'vllm',
    upstream_url: 'http://127.0.0.1:8001/v1',
    upstream_model: 'meta-llama/Llama-3.3-70B-Instruct',
    ctx_len: 131072,
    max_concurrency: 32,
    price_in_per_mtok: 0.50, // $0.50 per Mtok -> 0.25 credit / token
    price_out_per_mtok: 1.50, // $1.50 per Mtok -> 0.75 credit / token
    price_per_image: 0,
    price_per_audio_min: 0,
    status: 'live',
  };

  const mockImageModel: Model = {
    id: 'stable-diffusion-3.5',
    display_name: 'Stable Diffusion 3.5 Large',
    provider: 'Stability AI',
    category: 'image',
    engine: 'diffusers',
    upstream_url: 'http://127.0.0.1:8002/v1',
    upstream_model: 'stabilityai/stable-diffusion-3.5-large',
    ctx_len: 0,
    max_concurrency: 4,
    price_in_per_mtok: 0,
    price_out_per_mtok: 0,
    price_per_image: 0.035, // $0.035 per image -> 17,500 credits
    price_per_audio_min: 0,
    status: 'live',
  };

  const mockAudioModel: Model = {
    id: 'whisper-large-v3',
    display_name: 'Faster Whisper Large v3',
    provider: 'OpenAI',
    category: 'audio',
    engine: 'whisper',
    upstream_url: 'http://127.0.0.1:8003/v1',
    upstream_model: 'openai/whisper-large-v3',
    ctx_len: 0,
    max_concurrency: 8,
    price_in_per_mtok: 0,
    price_out_per_mtok: 0,
    price_per_image: 0,
    price_per_audio_min: 0.006, // $0.006 per min -> 3,000 credits
    status: 'live',
  };

  it('correctly converts USD to credits and vice versa (1 credit = $1/500,000)', () => {
    assert.equal(CREDITS_PER_USD, 500_000);
    assert.equal(creditsService.usdToCredits(1.0), 500_000);
    assert.equal(creditsService.usdToCredits(0.002), 1_000);
    assert.equal(creditsService.creditsToUsd(500_000), 1.0);
    assert.equal(creditsService.creditsToUsd(250), 0.0005);
  });

  it('calculates actual text token costs accurately without precision loss', () => {
    // 1000 in tokens at $0.50/Mtok = $0.00050 = 250 credits
    // 500 out tokens at $1.50/Mtok = $0.00075 = 375 credits
    // Total = 625 credits ($0.00125)
    const cost = creditsService.calculateActualCredits(mockTextModel, {
      inTokens: 1000,
      outTokens: 500,
    });
    assert.equal(cost, 625);
    assert.equal(creditsService.creditsToUsd(cost), 0.00125);
  });

  it('calculates GPT OSS 120B token costs with $0.03 input and $0.15 output per Mtok', () => {
    // 100,000 in tokens at $0.03/Mtok = $0.003 = 1,500 credits
    // 50,000 out tokens at $0.15/Mtok = $0.0075 = 3,750 credits
    // Total = 5,250 credits ($0.0105)
    const cost = creditsService.calculateActualCredits(mockGptOssModel, {
      inTokens: 100_000,
      outTokens: 50_000,
    });
    assert.equal(cost, 5_250);
    assert.equal(creditsService.creditsToUsd(cost), 0.0105);
  });

  it('calculates actual image generation cost', () => {
    // 2 images at $0.035 = $0.070 = 35,000 credits
    const cost = creditsService.calculateActualCredits(mockImageModel, {
      images: 2,
    });
    assert.equal(cost, 35_000);
    assert.equal(creditsService.creditsToUsd(cost), 0.07);
  });

  it('calculates actual audio transcription cost by seconds', () => {
    // 120 seconds (2 mins) at $0.006/min = $0.012 = 6,000 credits
    const cost = creditsService.calculateActualCredits(mockAudioModel, {
      audioSec: 120,
    });
    assert.equal(cost, 6_000);
    assert.equal(creditsService.creditsToUsd(cost), 0.012);
  });

  it('estimates reservation credits conservatively for chat requests', () => {
    const { estimatedCredits, estimatedTokens } =
      creditsService.calculateEstimatedCredits(mockTextModel, 'chat', {
        messages: [{ role: 'user', content: 'What is quantum computing in 50 words?' }],
        max_tokens: 200,
      });

    assert.ok(estimatedCredits > 0, 'Estimated credits should be > 0');
    assert.ok(estimatedTokens >= 200, 'Estimated tokens should include max_tokens');
  });
});
