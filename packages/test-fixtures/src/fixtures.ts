import type { NormalizedUsage, ProviderId } from '@contextscope/shared';

/**
 * Deterministic provider fixtures modelled on the documented request/response schemas
 * (OpenAI API reference, Anthropic Messages + streaming docs, Gemini generateContent docs).
 * IDs and contents are synthetic; there are no secrets or personal data.
 */
export interface ProviderFixture {
  name: string;
  provider: ProviderId;
  method: 'POST';
  /** Path after the provider prefix; may include a query (e.g. ?alt=sse). */
  path: string;
  requestBody: unknown;
  response: {
    status: number;
    headers: Record<string, string>;
    json?: unknown;
    sse?: string;
    jsonArray?: string;
  };
  expected: {
    model: string | null;
    stream: boolean;
    usage: Partial<NormalizedUsage>;
    segmentKinds?: string[];
    providerRequestId?: string | null;
  };
}

/** Build SSE text from `[event|null, data]` pairs. */
const sse = (events: [string | null, unknown][]): string =>
  events
    .map(([event, data]) => {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      return `${event !== null ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
    })
    .join('');

const SUPPORT_SYSTEM =
  'You are the support assistant for Acme Cloud Storage. Answer concisely, cite help-center articles by id, and never invent pricing.';

const lookupTool = {
  type: 'function',
  function: {
    name: 'lookup_article',
    description: 'Look up a help-center article by keyword.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

const responsesTool = {
  type: 'function',
  name: 'lookup_article',
  description: 'Look up a help-center article by keyword.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  strict: true,
};

const nullUsage: Partial<NormalizedUsage> = {
  totalInputTokens: null,
  uncachedInputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  source: 'unavailable',
  complete: false,
};

// ------------------------------------------------------------------------------------------------
// OpenAI

const openaiChatJson: ProviderFixture = {
  name: 'openai chat json with cached_tokens + reasoning',
  provider: 'openai',
  method: 'POST',
  path: '/v1/chat/completions',
  requestBody: {
    model: 'gpt-5.6-mini',
    reasoning_effort: 'low',
    prompt_cache_key: 'support-bot-v3',
    tools: [lookupTool],
    tool_choice: 'auto',
    messages: [
      { role: 'developer', content: SUPPORT_SYSTEM },
      { role: 'user', content: 'How do I restore a deleted folder?' },
    ],
  },
  response: {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_chat_json_001' },
    json: {
      id: 'chatcmpl-AbC123json',
      object: 'chat.completion',
      created: 1790845200,
      model: 'gpt-5.6-mini-2026-08-01',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Open Trash, select the folder and choose Restore (see HC-112).',
            refusal: null,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 2048,
        completion_tokens: 300,
        total_tokens: 2348,
        prompt_tokens_details: { cached_tokens: 1792, audio_tokens: 0 },
        completion_tokens_details: {
          reasoning_tokens: 256,
          audio_tokens: 0,
          accepted_prediction_tokens: 0,
          rejected_prediction_tokens: 0,
        },
      },
      service_tier: 'default',
    },
  },
  expected: {
    model: 'gpt-5.6-mini',
    stream: false,
    usage: {
      totalInputTokens: 2048,
      uncachedInputTokens: 256,
      cacheReadTokens: 1792,
      cacheWriteTokens: null,
      outputTokens: 300,
      reasoningTokens: 256,
      providerTotalTokens: 2348,
      source: 'reported',
      complete: true,
    },
    segmentKinds: ['tool_definition', 'developer', 'user'],
    providerRequestId: 'chatcmpl-AbC123json',
  },
};

const chatChunk = (delta: unknown, finish: string | null = null): unknown => ({
  id: 'chatcmpl-Stream42',
  object: 'chat.completion.chunk',
  created: 1790845300,
  model: 'gpt-4.1-mini-2025-04-14',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const openaiChatStreamUsage: ProviderFixture = {
  name: 'openai chat stream with include_usage',
  provider: 'openai',
  method: 'POST',
  path: '/v1/chat/completions',
  requestBody: {
    model: 'gpt-4.1-mini',
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: SUPPORT_SYSTEM },
      { role: 'user', content: 'Is there a file size limit?' },
    ],
  },
  response: {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_chat_stream_001' },
    sse:
      sse([
        [null, { ...(chatChunk({ role: 'assistant', content: '' }) as object), usage: null }],
        [null, { ...(chatChunk({ content: 'Single files can be up to ' }) as object), usage: null }],
        [null, { ...(chatChunk({ content: '250 GB (HC-087).' }) as object), usage: null }],
        [null, { ...(chatChunk({}, 'stop') as object), usage: null }],
        [
          null,
          {
            id: 'chatcmpl-Stream42',
            object: 'chat.completion.chunk',
            created: 1790845300,
            model: 'gpt-4.1-mini-2025-04-14',
            choices: [],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 12,
              total_tokens: 1212,
              prompt_tokens_details: { cached_tokens: 1024, audio_tokens: 0 },
              completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
            },
          },
        ],
      ]) + 'data: [DONE]\n\n',
  },
  expected: {
    model: 'gpt-4.1-mini',
    stream: true,
    usage: {
      totalInputTokens: 1200,
      uncachedInputTokens: 176,
      cacheReadTokens: 1024,
      outputTokens: 12,
      reasoningTokens: 0,
      providerTotalTokens: 1212,
      source: 'reported',
      complete: true,
    },
    segmentKinds: ['system', 'user'],
    providerRequestId: 'chatcmpl-Stream42',
  },
};

const openaiChatStreamNoUsage: ProviderFixture = {
  name: 'openai chat stream without include_usage',
  provider: 'openai',
  method: 'POST',
  path: '/v1/chat/completions',
  requestBody: {
    model: 'gpt-4.1-mini',
    stream: true,
    messages: [{ role: 'user', content: 'Say hello.' }],
  },
  response: {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_chat_stream_002' },
    sse:
      sse([
        [null, chatChunk({ role: 'assistant', content: '' })],
        [null, chatChunk({ content: 'Hello!' })],
        [null, chatChunk({}, 'stop')],
      ]) + 'data: [DONE]\n\n',
  },
  expected: {
    model: 'gpt-4.1-mini',
    stream: true,
    usage: nullUsage,
    segmentKinds: ['user'],
    providerRequestId: 'chatcmpl-Stream42',
  },
};

const responsesUsageObj = {
  input_tokens: 5000,
  input_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1500 },
  output_tokens: 900,
  output_tokens_details: { reasoning_tokens: 600 },
  total_tokens: 5900,
};

const responsesBody = (status: string, usage: unknown): Record<string, unknown> => ({
  id: 'resp_0a1b2c3d4e5f',
  object: 'response',
  created_at: 1790845400,
  status,
  model: 'gpt-5.6',
  output: [
    {
      type: 'reasoning',
      id: 'rs_01',
      summary: [],
    },
    {
      type: 'message',
      id: 'msg_01',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'The diff looks safe to merge.', annotations: [] }],
    },
  ],
  usage,
});

const responsesRequest = (stream: boolean): Record<string, unknown> => ({
  model: 'gpt-5.6',
  stream,
  instructions: 'You are a code-review agent. Flag correctness and security issues first.',
  reasoning: { effort: 'medium' },
  prompt_cache_key: 'code-review-agent',
  prompt_cache_options: { mode: 'explicit', ttl: '30m' },
  tools: [responsesTool],
  text: {
    format: {
      type: 'json_schema',
      name: 'review',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['approve', 'request_changes'] },
          notes: { type: 'string' },
        },
        required: ['verdict', 'notes'],
        additionalProperties: false,
      },
    },
  },
  input: [
    {
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'Repository conventions: strict TypeScript, no any.',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Review this diff: - const a = 1;\n+ const a = 2;' }],
    },
    { type: 'function_call', call_id: 'call_1', name: 'lookup_article', arguments: '{"query":"const"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'No article found.' },
  ],
});

const RESPONSES_KINDS = [
  'tool_definition',
  'schema',
  'system',
  'developer',
  'user',
  'tool_call',
  'tool_result',
];

const openaiResponsesJson: ProviderFixture = {
  name: 'openai responses json with cached + cache_write_tokens',
  provider: 'openai',
  method: 'POST',
  path: '/v1/responses',
  requestBody: responsesRequest(false),
  response: {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_resp_json_001' },
    json: responsesBody('completed', responsesUsageObj),
  },
  expected: {
    model: 'gpt-5.6',
    stream: false,
    usage: {
      totalInputTokens: 5000,
      uncachedInputTokens: 500,
      cacheReadTokens: 3000,
      cacheWriteTokens: 1500,
      outputTokens: 900,
      reasoningTokens: 600,
      providerTotalTokens: 5900,
      source: 'reported',
      complete: true,
    },
    segmentKinds: RESPONSES_KINDS,
    providerRequestId: 'resp_0a1b2c3d4e5f',
  },
};

const responsesStreamEvents = (): [string, unknown][] => {
  const inProgress = { ...responsesBody('in_progress', null), output: [] };
  return [
    ['response.created', { type: 'response.created', sequence_number: 0, response: inProgress }],
    ['response.in_progress', { type: 'response.in_progress', sequence_number: 1, response: inProgress }],
    [
      'response.output_item.added',
      {
        type: 'response.output_item.added',
        sequence_number: 2,
        output_index: 1,
        item: { type: 'message', id: 'msg_01', status: 'in_progress', role: 'assistant', content: [] },
      },
    ],
    [
      'response.output_text.delta',
      {
        type: 'response.output_text.delta',
        sequence_number: 3,
        item_id: 'msg_01',
        output_index: 1,
        content_index: 0,
        delta: 'The diff looks ',
      },
    ],
    [
      'response.output_text.delta',
      {
        type: 'response.output_text.delta',
        sequence_number: 4,
        item_id: 'msg_01',
        output_index: 1,
        content_index: 0,
        delta: 'safe to merge.',
      },
    ],
  ];
};

const openaiResponsesStream: ProviderFixture = {
  name: 'openai responses SSE ending in response.completed',
  provider: 'openai',
  method: 'POST',
  path: '/v1/responses',
  requestBody: responsesRequest(true),
  response: {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_resp_stream_001' },
    sse: sse([
      ...responsesStreamEvents(),
      [
        'response.output_text.done',
        {
          type: 'response.output_text.done',
          sequence_number: 5,
          item_id: 'msg_01',
          output_index: 1,
          content_index: 0,
          text: 'The diff looks safe to merge.',
        },
      ],
      [
        'response.completed',
        {
          type: 'response.completed',
          sequence_number: 6,
          response: responsesBody('completed', responsesUsageObj),
        },
      ],
    ]),
  },
  expected: { ...openaiResponsesJson.expected, stream: true },
};

const openaiResponsesTruncated: ProviderFixture = {
  name: 'openai responses stream truncated before response.completed',
  provider: 'openai',
  method: 'POST',
  path: '/v1/responses',
  requestBody: responsesRequest(true),
  response: {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_resp_stream_002' },
    sse: sse(responsesStreamEvents()),
  },
  expected: {
    model: 'gpt-5.6',
    stream: true,
    usage: nullUsage,
    segmentKinds: RESPONSES_KINDS,
    providerRequestId: 'resp_0a1b2c3d4e5f',
  },
};

const openai429: ProviderFixture = {
  name: 'openai 429 rate limit error body',
  provider: 'openai',
  method: 'POST',
  path: '/v1/chat/completions',
  requestBody: { model: 'gpt-5.6', messages: [{ role: 'user', content: 'ping' }] },
  response: {
    status: 429,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_err_429', 'retry-after': '20' },
    json: {
      error: {
        message: 'Rate limit reached for gpt-5.6 on tokens per min (TPM). Please try again in 20s.',
        type: 'tokens',
        param: null,
        code: 'rate_limit_exceeded',
      },
    },
  },
  expected: { model: 'gpt-5.6', stream: false, usage: nullUsage, providerRequestId: null },
};

const openai401: ProviderFixture = {
  name: 'openai 401 invalid api key',
  provider: 'openai',
  method: 'POST',
  path: '/v1/responses',
  requestBody: { model: 'gpt-5.6', input: 'ping' },
  response: {
    status: 401,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_err_401' },
    json: {
      error: {
        message:
          'Incorrect API key provided. You can find your API key at https://platform.openai.com/account/api-keys.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    },
  },
  expected: {
    model: 'gpt-5.6',
    stream: false,
    usage: nullUsage,
    segmentKinds: ['user'],
    providerRequestId: null,
  },
};

// ------------------------------------------------------------------------------------------------
// Anthropic

const DOCS_SYSTEM =
  'You are the documentation assistant for the Nimbus SDK. Answer only from the provided documents and cite section titles.';

const searchDocsTool = {
  name: 'search_docs',
  description: 'Full-text search over the Nimbus SDK documentation.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    required: ['query'],
  },
  cache_control: { type: 'ephemeral' },
};

const anthropicRequest = (stream: boolean): Record<string, unknown> => ({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  stream,
  tools: [searchDocsTool],
  system: [
    { type: 'text', text: DOCS_SYSTEM },
    {
      type: 'text',
      text: 'Style: short paragraphs, code samples in TypeScript.',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ],
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: 'Nimbus SDK retries: the client retries idempotent calls 3 times with jittered backoff.',
          },
          title: 'Retries',
        },
        { type: 'text', text: 'How many retries does the client do?', cache_control: { type: 'ephemeral' } },
      ],
    },
  ],
});

const anthropicUsageObj = {
  input_tokens: 50,
  cache_creation_input_tokens: 1500,
  cache_read_input_tokens: 2000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 500 },
  output_tokens: 120,
  service_tier: 'standard',
};

const anthropicJson: ProviderFixture = {
  name: 'anthropic json with cache_creation 5m/1h + cache_read',
  provider: 'anthropic',
  method: 'POST',
  path: '/v1/messages',
  requestBody: anthropicRequest(false),
  response: {
    status: 200,
    headers: { 'content-type': 'application/json', 'request-id': 'req_011CTanthropicJson' },
    json: {
      id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'The client retries idempotent calls 3 times (see "Retries").' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: anthropicUsageObj,
    },
  },
  expected: {
    model: 'claude-sonnet-4-5',
    stream: false,
    usage: {
      totalInputTokens: 3550,
      uncachedInputTokens: 50,
      cacheReadTokens: 2000,
      cacheWriteTokens: 1500,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 500,
      outputTokens: 120,
      source: 'reported',
      complete: true,
    },
    segmentKinds: ['tool_definition', 'system', 'system', 'user', 'document'],
    providerRequestId: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  },
};

const anthropicSse: ProviderFixture = {
  name: 'anthropic SSE with ping, tool_use input_json_delta, message_delta usage',
  provider: 'anthropic',
  method: 'POST',
  path: '/v1/messages',
  requestBody: anthropicRequest(true),
  response: {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_011CTanthropicSse' },
    sse: sse([
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg_014p7gG3wDgGV9EUtLvnow3U',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5-20250929',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 50,
              cache_creation_input_tokens: 1500,
              cache_read_input_tokens: 2000,
              cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 500 },
              output_tokens: 1,
            },
          },
        },
      ],
      ['ping', { type: 'ping' }],
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Let me search the docs.' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
            name: 'search_docs',
            input: {},
          },
        },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"query": "ret' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: 'ries"}' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: {
            input_tokens: 50,
            cache_creation_input_tokens: 1500,
            cache_read_input_tokens: 2000,
            output_tokens: 89,
          },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]),
  },
  expected: {
    model: 'claude-sonnet-4-5',
    stream: true,
    usage: {
      totalInputTokens: 3550,
      uncachedInputTokens: 50,
      cacheReadTokens: 2000,
      cacheWriteTokens: 1500,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 500,
      outputTokens: 89,
      source: 'reported',
      complete: true,
    },
    segmentKinds: ['tool_definition', 'system', 'system', 'user', 'document'],
    providerRequestId: 'msg_014p7gG3wDgGV9EUtLvnow3U',
  },
};

const anthropicErrorStream: ProviderFixture = {
  name: 'anthropic stream ending in an error event (overloaded)',
  provider: 'anthropic',
  method: 'POST',
  path: '/v1/messages',
  requestBody: {
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    stream: true,
    messages: [{ role: 'user', content: 'Summarise the changelog.' }],
  },
  response: {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_011CTanthropicErr' },
    sse: sse([
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg_01ErrStream0001',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 14,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 1,
            },
          },
        },
      ],
      ['ping', { type: 'ping' }],
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    ]),
  },
  expected: {
    model: 'claude-haiku-4-5',
    stream: true,
    // input side reported in message_start; output never finalised → incomplete
    usage: {
      totalInputTokens: 14,
      uncachedInputTokens: 14,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      source: 'reported',
      complete: false,
    },
    segmentKinds: ['user'],
    providerRequestId: 'msg_01ErrStream0001',
  },
};

const anthropicError = (status: number, type: string, message: string): unknown => ({
  type: 'error',
  error: { type, message },
  request_id: `req_011CTerr${status}`,
});

const anthropic429: ProviderFixture = {
  name: 'anthropic 429 rate limit error body',
  provider: 'anthropic',
  method: 'POST',
  path: '/v1/messages',
  requestBody: { model: 'claude-opus-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] },
  response: {
    status: 429,
    headers: { 'content-type': 'application/json', 'request-id': 'req_011CTerr429', 'retry-after': '30' },
    json: anthropicError(
      429,
      'rate_limit_error',
      'Number of request tokens has exceeded your per-minute rate limit.',
    ),
  },
  expected: {
    model: 'claude-opus-4-5',
    stream: false,
    usage: nullUsage,
    providerRequestId: 'req_011CTerr429',
  },
};

const anthropic401: ProviderFixture = {
  name: 'anthropic 401 authentication error body',
  provider: 'anthropic',
  method: 'POST',
  path: '/v1/messages',
  requestBody: { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] },
  response: {
    status: 401,
    headers: { 'content-type': 'application/json', 'request-id': 'req_011CTerr401' },
    json: anthropicError(401, 'authentication_error', 'invalid x-api-key'),
  },
  expected: {
    model: 'claude-haiku-4-5',
    stream: false,
    usage: nullUsage,
    segmentKinds: ['user'],
    providerRequestId: 'req_011CTerr401',
  },
};

// ------------------------------------------------------------------------------------------------
// Gemini

const geminiRequest = {
  systemInstruction: {
    parts: [{ text: 'You are a release-notes writer for an open-source CLI. Be factual and brief.' }],
  },
  tools: [
    {
      functionDeclarations: [
        {
          name: 'get_commits',
          description: 'List commits between two tags.',
          parameters: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string' } },
            required: ['from', 'to'],
          },
        },
      ],
    },
  ],
  contents: [{ role: 'user', parts: [{ text: 'Draft release notes for v2.4.0.' }] }],
  generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 1024 } },
};

const geminiUsageObj = {
  promptTokenCount: 4096,
  cachedContentTokenCount: 3072,
  candidatesTokenCount: 200,
  thoughtsTokenCount: 300,
  totalTokenCount: 4596,
  promptTokensDetails: [{ modality: 'TEXT', tokenCount: 4096 }],
  cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 3072 }],
};

const geminiChunk = (text: string, usage: unknown, finish: string | null): unknown => ({
  candidates: [
    {
      content: { role: 'model', parts: [{ text }] },
      ...(finish !== null ? { finishReason: finish } : {}),
      index: 0,
    },
  ],
  usageMetadata: usage,
  modelVersion: 'gemini-2.5-flash',
  responseId: 'gm_resp_7Hc2kQ',
});

const geminiExpectedUsage: Partial<NormalizedUsage> = {
  totalInputTokens: 4096,
  uncachedInputTokens: 1024,
  cacheReadTokens: 3072,
  cacheWriteTokens: null,
  outputTokens: 500,
  reasoningTokens: 300,
  providerTotalTokens: 4596,
  source: 'reported',
  complete: true,
};

const GEMINI_KINDS = ['system', 'tool_definition', 'user'];

const geminiJson: ProviderFixture = {
  name: 'gemini json with cachedContentTokenCount + thoughtsTokenCount',
  provider: 'gemini',
  method: 'POST',
  path: '/v1beta/models/gemini-2.5-flash:generateContent',
  requestBody: { ...geminiRequest, cachedContent: 'cachedContents/release-notes-ctx-01' },
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    json: geminiChunk('## v2.4.0\n- Faster startup\n- New `config` command', geminiUsageObj, 'STOP'),
  },
  expected: {
    model: 'gemini-2.5-flash',
    stream: false,
    usage: geminiExpectedUsage,
    segmentKinds: ['system', 'tool_definition', 'cached_content_ref', 'user'],
    providerRequestId: 'gm_resp_7Hc2kQ',
  },
};

const partialUsage = {
  promptTokenCount: 4096,
  cachedContentTokenCount: 3072,
  candidatesTokenCount: 40,
  thoughtsTokenCount: 300,
  totalTokenCount: 4436,
};

const geminiChunks = [
  geminiChunk('## v2.4.0\n', partialUsage, null),
  geminiChunk('- Faster startup\n', partialUsage, null),
  geminiChunk('- New `config` command', geminiUsageObj, 'STOP'),
];

const geminiSse: ProviderFixture = {
  name: 'gemini alt=sse stream',
  provider: 'gemini',
  method: 'POST',
  path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
  requestBody: geminiRequest,
  response: {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    // Gemini SSE uses CRLF line endings and no event names.
    sse: geminiChunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''),
  },
  expected: {
    model: 'gemini-2.5-flash',
    stream: true,
    usage: geminiExpectedUsage,
    segmentKinds: GEMINI_KINDS,
    providerRequestId: 'gm_resp_7Hc2kQ',
  },
};

const geminiJsonArray: ProviderFixture = {
  name: 'gemini JSON-array stream (no alt=sse)',
  provider: 'gemini',
  method: 'POST',
  path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
  requestBody: geminiRequest,
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    jsonArray: `[${geminiChunks.map((c) => JSON.stringify(c, null, 2)).join('\r\n,\r\n')}]`,
  },
  expected: {
    model: 'gemini-2.5-flash',
    stream: true,
    usage: geminiExpectedUsage,
    segmentKinds: GEMINI_KINDS,
    providerRequestId: 'gm_resp_7Hc2kQ',
  },
};

const geminiError = (code: number, status: string, message: string): unknown => ({
  error: { code, message, status },
});

const gemini429: ProviderFixture = {
  name: 'gemini 429 RESOURCE_EXHAUSTED error body',
  provider: 'gemini',
  method: 'POST',
  path: '/v1beta/models/gemini-2.5-pro:generateContent',
  requestBody: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
  response: {
    status: 429,
    headers: { 'content-type': 'application/json' },
    json: geminiError(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).'),
  },
  expected: {
    model: 'gemini-2.5-pro',
    stream: false,
    usage: nullUsage,
    segmentKinds: ['user'],
    providerRequestId: null,
  },
};

const gemini401: ProviderFixture = {
  name: 'gemini 400/401 invalid API key error body',
  provider: 'gemini',
  method: 'POST',
  path: '/v1beta/models/gemini-2.5-flash:generateContent',
  requestBody: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
  response: {
    status: 401,
    headers: { 'content-type': 'application/json' },
    json: geminiError(401, 'UNAUTHENTICATED', 'API key not valid. Please pass a valid API key.'),
  },
  expected: {
    model: 'gemini-2.5-flash',
    stream: false,
    usage: nullUsage,
    segmentKinds: ['user'],
    providerRequestId: null,
  },
};

export const fixtures: ProviderFixture[] = [
  openaiChatJson,
  openaiChatStreamUsage,
  openaiChatStreamNoUsage,
  openaiResponsesJson,
  openaiResponsesStream,
  openaiResponsesTruncated,
  openai429,
  openai401,
  anthropicJson,
  anthropicSse,
  anthropicErrorStream,
  anthropic429,
  anthropic401,
  geminiJson,
  geminiSse,
  geminiJsonArray,
  gemini429,
  gemini401,
];
