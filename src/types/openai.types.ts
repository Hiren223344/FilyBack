export interface OpenAIErrorShape {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  [key: string]: unknown;
}

export interface CompletionRequest {
  model: string;
  prompt: string | string[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stop?: string | string[];
  [key: string]: unknown;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[] | number[] | number[][];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
  [key: string]: unknown;
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  response_format?: 'url' | 'b64_json';
  style?: string;
  user?: string;
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: unknown[];
  };
  finish_reason: string | null;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string;
    tool_calls?: unknown[];
  };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
  system_fingerprint?: string;
  latency_ms?: number;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: Usage | null;
  system_fingerprint?: string;
}

export interface ModelListItem {
  id: string;
  name: string;
  provider: string;
  owned_by: string;
  category: 'text' | 'image' | 'audio' | 'embedding';
  price: {
    in_per_mtok: number;
    out_per_mtok: number;
    per_image: number;
    per_audio_min: number;
  };
  ctx_len: number;
  max_concurrency: number;
  status: 'live' | 'disabled' | 'sleeping';
}
