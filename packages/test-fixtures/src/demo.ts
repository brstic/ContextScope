import type { ImportedTrace, ProviderId } from '@contextscope/shared';

const BASE = Date.parse('2026-10-01T09:00:00Z');
const ANSWER = 'Check the documented retry policy and add a regression test before releasing the SDK.';
const DOCUMENT =
  'SDK retry policy: retry idempotent requests with exponential backoff and jitter. Honor Retry-After; never retry validation errors. '.repeat(
    48,
  );
const SYSTEM =
  'You are a developer support assistant. Cite SDK documentation, review changes for correctness, and do not invent behavior. ';
const MODELS: Record<ProviderId, readonly string[]> = {
  openai: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-4.1-mini', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  anthropic: [
    'claude-sonnet-4-5',
    'claude-opus-4-5',
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5',
  ],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
};
const SCENARIOS = ['support-tools', 'review', 'growing-history', 'retrieval', 'release-notes'];
const tokens = (value: unknown): number =>
  Math.ceil(new TextEncoder().encode(JSON.stringify(value)).length / 4);
const event = (name: string | null, data: unknown): string =>
  `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 120 deterministic synthetic exchanges: five eight-turn sessions per provider.
 * Turns in each session are two minutes apart (inside Anthropic's default cache TTL);
 * session starts span nine days. Fresh objects and a freshly seeded PRNG on every call.
 * Input usage is estimated from native request bytes / 4, not a claim of tokenization.
 * Anthropic cache reads/writes partition that total; OpenAI/Gemini include reads in input.
 */
export function demoTraces(): ImportedTrace[] {
  let seed = 0x43545853;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const traces: ImportedTrace[] = [];
  for (const [providerIndex, provider] of (['openai', 'anthropic', 'gemini'] as const).entries()) {
    for (let session = 0; session < 5; session++) {
      const history: Message[] = [];
      const sessionId = `demo-${provider}-${SCENARIOS[session]}`;
      for (let turn = 0; turn < 8; turn++) {
        const trivial = provider === 'anthropic' && session === 1;
        const noCache = provider === 'anthropic' && session === 0;
        const largeTools = provider === 'openai' && session === 0;
        const responses = provider === 'openai' && session === 3;
        const truncated = responses && turn === 6;
        const stream = truncated || turn === 3 || turn === 7;
        const model =
          provider === 'openai' && session === 2 && turn === 7
            ? 'gpt-5.6-custom-ft'
            : (MODELS[provider][session] as string);
        const id = `${sessionId}-${turn + 1}`;
        const system = trivial
          ? 'Classify the request as docs or bug.'
          : SYSTEM.repeat(noCache ? 70 : session === 2 ? 1 : 10);
        const tools = Array.from({ length: trivial ? 0 : largeTools ? 25 : 2 }, (_, i) => ({
          name: `lookup_sdk_${i}`,
          // One tool alone exceeds 1,000 tokens: repeated_tool_schemas is per definition,
          // not per toolset. The remaining 24 bring the set well above 4,000 tokens.
          description: largeTools
            ? 'Search SDK modules; return documented behavior and citations. '.repeat(i === 0 ? 80 : 15)
            : 'Search SDK documentation.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  session === 1 && turn >= 4
                    ? 'Module name or error code (schema v2).'
                    : 'Module name (schema v1).',
              },
            },
            required: ['query'],
          },
        }));
        let prompt = trivial
          ? `Classify: where are the SDK docs? (${turn + 1})`
          : `Review SDK issue ${turn + 1}: how should retries handle timeouts?`;
        if (session === 2)
          prompt +=
            `\nTurn ${turn + 1} diagnostic context: ` +
            'The SDK integration test exercises idempotent retry handling and validates the timeout contract. '.repeat(
              14,
            );
        // A sudden, deliberately oversized retrieval, not synthetic reported tokens alone.
        if (session === 3 && turn === 7)
          prompt +=
            '\nRetrieved integration log:\n' +
            'Retry diagnostics: timeout at the SDK boundary; operation remains idempotent. '.repeat(1400);
        const messages: Message[] = [...history, { role: 'user', content: prompt }];
        const request: Record<string, unknown> = {};
        let endpoint: string;
        if (provider === 'openai') {
          Object.assign(request, {
            model,
            stream,
            tools: tools.map((t) =>
              responses ? { type: 'function', ...t } : { type: 'function', function: t },
            ),
            prompt_cache_key: sessionId,
          });
          if (responses) {
            endpoint = '/v1/responses';
            Object.assign(request, { instructions: system, input: messages, reasoning: { effort: 'low' } });
          } else {
            endpoint = '/v1/chat/completions';
            Object.assign(request, {
              messages: [{ role: 'system', content: system }, ...messages],
              stream_options: stream ? { include_usage: true } : undefined,
            });
          }
        } else if (provider === 'anthropic') {
          endpoint = '/v1/messages';
          Object.assign(request, {
            model,
            max_tokens: 512,
            stream,
            system: [
              {
                type: 'text',
                text: system,
                ...(!noCache && !trivial ? { cache_control: { type: 'ephemeral' } } : {}),
              },
            ],
            tools: tools.map(({ parameters, ...t }) => ({ ...t, input_schema: parameters })),
            messages: messages.map((m, i) =>
              session === 3 && i === messages.length - 1
                ? {
                    role: m.role,
                    content: [
                      { type: 'text', text: m.content },
                      // Identical document nodes deliberately duplicated within one request.
                      ...[0, 1].map(() => ({
                        type: 'document',
                        title: 'SDK retry policy',
                        source: { type: 'text', media_type: 'text/plain', data: DOCUMENT },
                      })),
                    ],
                  }
                : m,
            ),
          });
        } else {
          endpoint = `/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
          Object.assign(request, {
            systemInstruction: { parts: [{ text: system }] },
            tools: [{ functionDeclarations: tools }],
            contents: messages.map((m) => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
            generationConfig: { thinkingConfig: { thinkingBudget: 128 } },
            ...(turn > 0 ? { cachedContent: `cachedContents/${sessionId}` } : {}),
          });
        }
        const total = tokens(request);
        const reads = noCache || trivial ? 0 : Math.floor(total * Math.min(turn * 0.1, 0.7));
        const writes =
          provider === 'anthropic' && !noCache && !trivial
            ? Math.floor(total * (turn === 0 || (session === 3 && turn === 7) ? 0.8 : 0))
            : 0;
        // Unexpected writes deliberately replace the read share for that one spike.
        const cacheRead = writes > 0 ? 0 : reads;
        // Each turn answers differently (identical assistant turns would be a real duplication signal).
        const output = trivial ? 'docs' : `${ANSWER} (turn ${turn + 1}, ref ${id})`;
        const outputTokens = Math.ceil(output.length / 4);
        const reasoning = trivial ? 0 : 16;
        let response: Record<string, unknown>;
        let responseSse: string;
        if (provider === 'openai') {
          if (responses) {
            response = {
              id: `resp-${id}`,
              model,
              status: 'completed',
              output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] },
              ],
              usage: {
                input_tokens: total,
                input_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: 0 },
                output_tokens: outputTokens + reasoning,
                output_tokens_details: { reasoning_tokens: reasoning },
                total_tokens: total + outputTokens + reasoning,
              },
            };
            responseSse =
              event('response.created', { type: 'response.created', response: { id: `resp-${id}`, model } }) +
              event('response.output_text.delta', { type: 'response.output_text.delta', delta: output });
            if (!truncated)
              responseSse += event('response.completed', { type: 'response.completed', response });
          } else {
            const usage = {
              prompt_tokens: total,
              prompt_tokens_details: { cached_tokens: cacheRead },
              completion_tokens: outputTokens + reasoning,
              completion_tokens_details: { reasoning_tokens: reasoning },
              total_tokens: total + outputTokens + reasoning,
            };
            response = {
              id: `chat-${id}`,
              model,
              choices: [{ message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
              usage,
            };
            responseSse =
              event(null, {
                id: `chat-${id}`,
                model,
                choices: [{ delta: { content: output }, finish_reason: null }],
              }) +
              event(null, { id: `chat-${id}`, model, choices: [], usage }) +
              event(null, '[DONE]');
          }
        } else if (provider === 'anthropic') {
          const usage = {
            input_tokens: total - cacheRead - writes,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: writes,
            cache_creation: { ephemeral_5m_input_tokens: writes, ephemeral_1h_input_tokens: 0 },
            output_tokens: outputTokens,
          };
          response = {
            id: `msg-${id}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text: output }],
            stop_reason: 'end_turn',
            usage,
          };
          responseSse =
            event('message_start', {
              type: 'message_start',
              message: { ...response, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } },
            }) +
            event('ping', { type: 'ping' }) +
            event('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: output },
            }) +
            event('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: outputTokens },
            }) +
            event('message_stop', { type: 'message_stop' });
        } else {
          response = {
            responseId: `gm-${id}`,
            modelVersion: model,
            candidates: [{ content: { role: 'model', parts: [{ text: output }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: total,
              cachedContentTokenCount: cacheRead,
              candidatesTokenCount: outputTokens,
              thoughtsTokenCount: reasoning,
              totalTokenCount: total + outputTokens + reasoning,
            },
          };
          responseSse = event(null, response);
        }
        const failed = session === 4 && turn === 6;
        const status = failed ? (provider === 'gemini' ? 500 : 429) : 200;
        const slow = turn === 5 || (session === 3 && turn === 7);
        const trace: ImportedTrace = {
          id,
          provider,
          endpoint,
          method: 'POST',
          sessionId,
          traceId: `trace-${id}`,
          projectId: 'demo-developer-app',
          startedAt: new Date(
            BASE + (session * 3 + providerIndex) * ((9 * 86400000) / 14) + turn * 120000,
          ).toISOString(),
          durationMs: slow ? 30000 + Math.floor(random() * 30000) : 600 + Math.floor(random() * 2400),
          ttfbMs: 80 + Math.floor(random() * 150),
          ttftMs: slow ? 12000 : 250 + Math.floor(random() * 300),
          httpStatus: status,
          state: truncated ? 'client_aborted' : failed ? 'upstream_error' : 'completed',
          request,
          ...(failed
            ? {
                response:
                  provider === 'gemini'
                    ? { error: { code: status, status: 'INTERNAL', message: 'Synthetic upstream failure.' } }
                    : { error: { type: 'rate_limit_error', message: 'Synthetic rate limit; retry later.' } },
              }
            : stream
              ? { responseSse }
              : { response }),
        };
        traces.push(trace);
        history.push({ role: 'user', content: prompt }, { role: 'assistant', content: output });
      }
    }
  }
  return traces.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
