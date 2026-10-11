import type {
  EndpointMatch,
  ParsedRequest,
  ParsedResponse,
  ProviderAdapter,
  SseEvent,
  StreamAccumulator,
  StreamEventResult,
} from '@contextscope/core';
import type { NormalizedUsage, RawSegment, RequestFeatures, SegmentKind } from '@contextscope/shared';
import {
  arr,
  collectOther,
  get,
  headerValue,
  isRecord,
  joinText,
  jsonText,
  makeSegment,
  nonEmpty,
  nonNeg,
  num,
  parseJson,
  rec,
  str,
  unavailableUsage,
} from './util.js';

/*
 * OpenAI: Responses API (POST /v1/responses) and Chat Completions (POST /v1/chat/completions).
 * Usage rules: see docs/ARCHITECTURE.md ("OpenAI Responses" / "OpenAI Chat Completions").
 */

export const OP_RESPONSES = 'openai.responses';
export const OP_CHAT = 'openai.chat.completions';

const MEDIA_PART_TYPES = new Set(['image_url', 'input_image', 'input_file', 'file', 'input_audio', 'audio']);
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text', 'refusal', 'summary_text']);

const isMediaPart = (p: unknown): boolean => isRecord(p) && MEDIA_PART_TYPES.has(str(p.type) ?? '');

/** Human text of a message `content` (string or parts); never base64. */
const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  return joinText(
    arr(content).map((p) => {
      if (typeof p === 'string') return p;
      if (!isRecord(p)) return null;
      if (TEXT_PART_TYPES.has(str(p.type) ?? '') || p.type === undefined)
        return str(p.text) ?? str(p.refusal);
      return null;
    }),
  );
};

const roleKind = (role: string | null): SegmentKind => {
  switch (role) {
    case 'system':
      return 'system';
    case 'developer':
      return 'developer';
    case 'assistant':
      return 'assistant';
    case 'tool':
    case 'function':
      return 'tool_result';
    case 'user':
      return 'user';
    default:
      return 'other';
  }
};

const toolLabel = (t: unknown, i: number): string =>
  nonEmpty(get(t, 'name')) ?? nonEmpty(get(t, 'function', 'name')) ?? nonEmpty(get(t, 'type')) ?? `tool ${i}`;

const toolChoiceOf = (tc: unknown): string | null => {
  if (typeof tc === 'string') return tc;
  if (!isRecord(tc)) return null;
  const type = str(tc.type);
  const name = str(tc.name) ?? str(get(tc, 'function', 'name'));
  if (type && name) return `${type}:${name}`;
  return type ?? name;
};

const hasBreakpoint = (p: unknown): boolean =>
  isRecord(p) && p.prompt_cache_breakpoint !== undefined && p.prompt_cache_breakpoint !== null;

const countBreakpoints = (content: unknown): number => arr(content).filter(hasBreakpoint).length;

const breakpointOf = (content: unknown): string | null => {
  let found: string | null = null;
  for (const p of arr(content)) {
    if (!hasBreakpoint(p)) continue;
    found = str(get(p, 'prompt_cache_breakpoint', 'mode')) ?? 'explicit';
  }
  return found;
};

const countMedia = (content: unknown): number => arr(content).filter(isMediaPart).length;

const onlyMedia = (content: unknown): boolean => {
  const parts = arr(content);
  return parts.length > 0 && parts.every(isMediaPart);
};

const parseRequest = (body: unknown, match: EndpointMatch): ParsedRequest => {
  const b = rec(body);
  const responses = match.operation === OP_RESPONSES;
  const segments: RawSegment[] = [];
  const features: RequestFeatures = {
    stream: b.stream === true,
    toolCount: 0,
    toolChoice: toolChoiceOf(b.tool_choice),
    structuredOutput: false,
    reasoning: str(get(b, 'reasoning', 'effort')) ?? str(b.reasoning_effort),
    cacheControlBlocks: 0,
    attachments: 0,
    messageCount: 0,
    systemBlocks: 0,
    cacheOptions: {},
  };

  const pck = str(b.prompt_cache_key);
  if (pck !== null) features.cacheOptions.prompt_cache_key = pck;
  const pcr = str(b.prompt_cache_retention);
  if (pcr !== null) features.cacheOptions.prompt_cache_retention = pcr;
  const pcoMode = str(get(b, 'prompt_cache_options', 'mode'));
  if (pcoMode !== null) features.cacheOptions['prompt_cache_options.mode'] = pcoMode;
  const pcoTtl = str(get(b, 'prompt_cache_options', 'ttl'));
  if (pcoTtl !== null) features.cacheOptions['prompt_cache_options.ttl'] = pcoTtl;

  // 1. tools
  const tools = arr(b.tools);
  features.toolCount = tools.length;
  tools.forEach((t, i) => {
    const desc = str(get(t, 'description')) ?? str(get(t, 'function', 'description'));
    segments.push(
      makeSegment({
        kind: 'tool_definition',
        path: `/tools/${i}`,
        label: toolLabel(t, i),
        node: t,
        plainText: joinText([toolLabel(t, i), desc]),
      }),
    );
  });

  // 2. structured-output schema
  if (responses) {
    const fmt = get(b, 'text', 'format');
    if (str(get(fmt, 'type')) === 'json_schema') {
      features.structuredOutput = true;
      segments.push(
        makeSegment({
          kind: 'schema',
          path: '/text/format',
          label: 'response schema',
          node: fmt,
          plainText: jsonText(get(fmt, 'schema')),
        }),
      );
    }
  } else {
    const rf = b.response_format;
    if (str(get(rf, 'type')) === 'json_schema') {
      features.structuredOutput = true;
      const js = get(rf, 'json_schema');
      segments.push(
        makeSegment({
          kind: 'schema',
          path: js === undefined ? '/response_format' : '/response_format/json_schema',
          label: 'response schema',
          node: js ?? rf,
          plainText: jsonText(get(js, 'schema')),
        }),
      );
    }
  }

  // 3. Responses instructions
  if (responses && typeof b.instructions === 'string') {
    features.systemBlocks++;
    segments.push(
      makeSegment({
        kind: 'system',
        role: 'system',
        path: '/instructions',
        label: 'instructions',
        node: b.instructions,
      }),
    );
  }

  // 4. input / messages
  if (responses) {
    if (typeof b.input === 'string') {
      features.messageCount = 1;
      segments.push(
        makeSegment({
          kind: 'user',
          role: 'user',
          path: '/input',
          label: 'user #0',
          node: b.input,
          messageIndex: 0,
        }),
      );
    } else {
      const items = arr(b.input);
      features.messageCount = items.length;
      items.forEach((item, i) => segments.push(responsesItemSegment(item, i, features)));
    }
  } else {
    const msgs = arr(b.messages);
    features.messageCount = msgs.length;
    msgs.forEach((m, i) => segments.push(...chatMessageSegments(m, i, features)));
  }

  return { model: str(b.model), stream: b.stream === true, features, segments };
};

const responsesItemSegment = (item: unknown, i: number, features: RequestFeatures): RawSegment => {
  const path = `/input/${i}`;
  const type = str(get(item, 'type'));
  if (type === 'function_call' || type === 'custom_tool_call') {
    const name = str(get(item, 'name')) ?? 'tool call';
    return makeSegment({
      kind: 'tool_call',
      role: 'assistant',
      path,
      label: name,
      node: item,
      plainText: joinText([name, str(get(item, 'arguments')) ?? str(get(item, 'input'))]),
      messageIndex: i,
    });
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    const out = get(item, 'output');
    return makeSegment({
      kind: 'tool_result',
      role: 'tool',
      path,
      label: `tool result #${i}`,
      node: item,
      plainText: typeof out === 'string' ? out : contentText(out),
      messageIndex: i,
    });
  }
  const role = str(get(item, 'role'));
  if (role !== null && (type === null || type === 'message')) {
    const content = get(item, 'content');
    if (role === 'system' || role === 'developer') features.systemBlocks++;
    features.attachments += countMedia(content);
    features.cacheControlBlocks += countBreakpoints(content);
    return makeSegment({
      kind: roleKind(role),
      role,
      path,
      label: `${role} #${i}`,
      node: item,
      plainText: contentText(content),
      cacheControl: breakpointOf(content),
      messageIndex: i,
      multimodal: onlyMedia(content),
    });
  }
  if (typeof item === 'string') {
    return makeSegment({
      kind: 'user',
      role: 'user',
      path,
      label: `user #${i}`,
      node: item,
      messageIndex: i,
    });
  }
  return makeSegment({
    kind: 'other',
    path,
    label: type ?? `item #${i}`,
    node: item,
    plainText: type === 'reasoning' ? contentText(get(item, 'summary')) : '',
    messageIndex: i,
  });
};

const chatMessageSegments = (m: unknown, i: number, features: RequestFeatures): RawSegment[] => {
  const role = str(get(m, 'role'));
  const content = get(m, 'content');
  const path = `/messages/${i}`;
  if (role === 'system' || role === 'developer') features.systemBlocks++;
  features.attachments += countMedia(content);
  features.cacheControlBlocks += countBreakpoints(content);
  const toolCalls = arr(get(m, 'tool_calls'));
  if (role === 'assistant' && toolCalls.length > 0) {
    const out: RawSegment[] = [];
    const text = contentText(content);
    if (text.length > 0) {
      out.push(
        makeSegment({
          kind: 'assistant',
          role,
          path: `${path}/content`,
          label: `assistant #${i}`,
          node: content,
          plainText: text,
          messageIndex: i,
        }),
      );
    }
    toolCalls.forEach((tc, j) => {
      const name = str(get(tc, 'function', 'name')) ?? str(get(tc, 'custom', 'name')) ?? 'tool call';
      out.push(
        makeSegment({
          kind: 'tool_call',
          role,
          path: `${path}/tool_calls/${j}`,
          label: name,
          node: tc,
          plainText: joinText([name, str(get(tc, 'function', 'arguments'))]),
          messageIndex: i,
        }),
      );
    });
    return out;
  }
  return [
    makeSegment({
      kind: roleKind(role),
      role,
      path,
      label: `${role ?? 'message'} #${i}`,
      node: m,
      plainText: contentText(content),
      cacheControl: breakpointOf(content),
      messageIndex: i,
      multimodal: onlyMedia(content),
    }),
  ];
};

// ---------------------------------------------------------------------------------------------
// Usage

/** Responses API: input_tokens is TOTAL (includes cached and cache writes). */
export const responsesUsage = (u: unknown): NormalizedUsage => {
  if (!isRecord(u)) return unavailableUsage();
  const total = num(u.input_tokens);
  const cached = num(get(u, 'input_tokens_details', 'cached_tokens'));
  const write = num(get(u, 'input_tokens_details', 'cache_write_tokens'));
  const other: Record<string, number> = {};
  collectOther(other, u.input_tokens_details, {
    audio_tokens: 'inputAudioTokens',
    image_tokens: 'inputImageTokens',
  });
  collectOther(other, u.output_tokens_details, { audio_tokens: 'outputAudioTokens' });
  return {
    totalInputTokens: total,
    // cache_write_tokens is only reported by GPT-5.6+; when absent nothing is subtracted for writes.
    uncachedInputTokens: total !== null && cached !== null ? nonNeg(total - cached - (write ?? 0)) : null,
    cacheReadTokens: cached,
    cacheWriteTokens: write,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(get(u, 'output_tokens_details', 'reasoning_tokens')),
    providerTotalTokens: num(u.total_tokens),
    other,
    source: 'reported',
    complete: true,
    raw: u,
  };
};

/** Chat Completions: prompt_tokens is TOTAL input, completion_tokens includes reasoning. */
export const chatUsage = (u: unknown): NormalizedUsage => {
  if (!isRecord(u)) return unavailableUsage();
  const total = num(u.prompt_tokens);
  const cached = num(get(u, 'prompt_tokens_details', 'cached_tokens'));
  const write = num(get(u, 'prompt_tokens_details', 'cache_write_tokens'));
  const other: Record<string, number> = {};
  collectOther(other, u.prompt_tokens_details, { audio_tokens: 'inputAudioTokens' });
  collectOther(other, u.completion_tokens_details, {
    audio_tokens: 'outputAudioTokens',
    accepted_prediction_tokens: 'acceptedPredictionTokens',
    rejected_prediction_tokens: 'rejectedPredictionTokens',
  });
  return {
    totalInputTokens: total,
    uncachedInputTokens: total !== null && cached !== null ? nonNeg(total - cached - (write ?? 0)) : null,
    cacheReadTokens: cached,
    cacheWriteTokens: write,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    outputTokens: num(u.completion_tokens),
    reasoningTokens: num(get(u, 'completion_tokens_details', 'reasoning_tokens')),
    providerTotalTokens: num(u.total_tokens),
    other,
    source: 'reported',
    complete: true,
    raw: u,
  };
};

const responsesOutputChars = (output: unknown): number | null => {
  const items = arr(output);
  if (items.length === 0) return null;
  let n = 0;
  for (const it of items) {
    for (const c of arr(get(it, 'content')))
      n += (str(get(c, 'text')) ?? str(get(c, 'refusal')) ?? '').length;
    n += (str(get(it, 'arguments')) ?? '').length;
  }
  return n;
};

const responsesFinish = (r: unknown): string | null => {
  const status = str(get(r, 'status'));
  if (status === 'incomplete') return str(get(r, 'incomplete_details', 'reason')) ?? 'incomplete';
  return status;
};

const parseResponse = (body: unknown, match: EndpointMatch): ParsedResponse => {
  const b = rec(body);
  const hasUsage = b.usage !== undefined && b.usage !== null;
  if (match.operation === OP_RESPONSES) {
    return {
      model: str(b.model),
      providerRequestId: str(b.id),
      usage: hasUsage ? responsesUsage(b.usage) : unavailableUsage(),
      finishReason: isRecord(b.error) && b.status === undefined ? 'error' : responsesFinish(b),
      outputChars: responsesOutputChars(b.output),
    };
  }
  const choices = arr(b.choices);
  let chars: number | null = null;
  for (const c of choices) {
    const msg = get(c, 'message');
    const text = (str(get(msg, 'content')) ?? '').length + (str(get(msg, 'refusal')) ?? '').length;
    const args = arr(get(msg, 'tool_calls')).reduce<number>(
      (a, tc) => a + (str(get(tc, 'function', 'arguments')) ?? '').length,
      0,
    );
    chars = (chars ?? 0) + text + args;
  }
  return {
    model: str(b.model),
    providerRequestId: str(b.id),
    usage: hasUsage ? chatUsage(b.usage) : unavailableUsage(),
    finishReason: str(get(choices[0], 'finish_reason')) ?? (isRecord(b.error) ? 'error' : null),
    outputChars: chars,
  };
};

// ---------------------------------------------------------------------------------------------
// Streaming

const NOTHING: StreamEventResult = { meaningfulOutput: false, terminal: false };

class ChatStreamAccumulator implements StreamAccumulator {
  private model: string | null = null;
  private id: string | null = null;
  private usage: unknown = undefined;
  private finishReason: string | null = null;
  private chars = 0;
  private sawOutput = false;

  onEvent(e: SseEvent): StreamEventResult {
    const data = e.data.trim();
    if (data === '[DONE]') return { meaningfulOutput: false, terminal: true };
    const chunk = parseJson(data);
    if (!isRecord(chunk)) return NOTHING;
    if (isRecord(chunk.error)) {
      this.finishReason = 'error';
      return { meaningfulOutput: false, terminal: true };
    }
    this.model = str(chunk.model) ?? this.model;
    this.id = str(chunk.id) ?? this.id;
    if (isRecord(chunk.usage)) this.usage = chunk.usage;
    let meaningful = false;
    for (const c of arr(chunk.choices)) {
      const delta = get(c, 'delta');
      for (const text of [str(get(delta, 'content')), str(get(delta, 'refusal'))]) {
        if (text !== null && text.length > 0) {
          meaningful = true;
          this.chars += text.length;
        }
      }
      const tcs = arr(get(delta, 'tool_calls'));
      if (tcs.length > 0) {
        meaningful = true;
        for (const tc of tcs) this.chars += (str(get(tc, 'function', 'arguments')) ?? '').length;
      }
      this.finishReason = str(get(c, 'finish_reason')) ?? this.finishReason;
    }
    if (meaningful) this.sawOutput = true;
    return { meaningfulOutput: meaningful, terminal: false };
  }

  finish(_completed: boolean): ParsedResponse {
    // Usage only exists when the client asked for stream_options.include_usage. The usage chunk is
    // the final data chunk, so once seen it is complete. Without it: unavailable, all null (never 0).
    const usage = this.usage !== undefined ? chatUsage(this.usage) : unavailableUsage();
    return {
      model: this.model,
      providerRequestId: this.id,
      usage,
      finishReason: this.finishReason,
      outputChars: this.sawOutput ? this.chars : null,
    };
  }
}

const RESPONSES_MEANINGFUL = new Set([
  'response.output_text.delta',
  'response.function_call_arguments.delta',
  'response.refusal.delta',
  'response.reasoning_summary_text.delta',
  'response.custom_tool_call_input.delta',
]);
const RESPONSES_TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed']);

class ResponsesStreamAccumulator implements StreamAccumulator {
  private model: string | null = null;
  private id: string | null = null;
  private usage: unknown = undefined;
  private finishReason: string | null = null;
  private chars = 0;
  private sawOutput = false;

  onEvent(e: SseEvent): StreamEventResult {
    const data = parseJson(e.data);
    if (!isRecord(data)) return NOTHING;
    const type = str(data.type) ?? e.event;
    if (type === null) return NOTHING;
    const resp = data.response;
    if (isRecord(resp)) {
      this.model = str(resp.model) ?? this.model;
      this.id = str(resp.id) ?? this.id;
    }
    if (RESPONSES_TERMINAL.has(type)) {
      if (isRecord(resp) && isRecord(resp.usage)) this.usage = resp.usage;
      this.finishReason = type === 'response.failed' ? 'failed' : (responsesFinish(resp) ?? type.slice(9));
      return { meaningfulOutput: false, terminal: true };
    }
    if (type === 'error') {
      this.finishReason = 'error';
      return { meaningfulOutput: false, terminal: true };
    }
    if (RESPONSES_MEANINGFUL.has(type)) {
      const delta = str(data.delta);
      if (delta !== null) this.chars += delta.length;
      this.sawOutput = true;
      return { meaningfulOutput: true, terminal: false };
    }
    if (type === 'response.output_item.added' && str(get(data, 'item', 'type')) === 'function_call') {
      this.sawOutput = true;
      return { meaningfulOutput: true, terminal: false };
    }
    return NOTHING;
  }

  finish(_completed: boolean): ParsedResponse {
    // Usage only arrives with the terminal event; a stream cut before it has no usage (complete=false, nulls).
    const usage = this.usage !== undefined ? responsesUsage(this.usage) : unavailableUsage();
    return {
      model: this.model,
      providerRequestId: this.id,
      usage,
      finishReason: this.finishReason,
      outputChars: this.sawOutput ? this.chars : null,
    };
  }
}

// ---------------------------------------------------------------------------------------------

const matchEndpoint = (method: string, path: string): EndpointMatch | null => {
  if (method.toUpperCase() !== 'POST') return null;
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const base = {
    provider: 'openai' as const,
    path: p,
    modelFromPath: null,
    streamFromPath: false,
    sse: false,
  };
  if (p === '/v1/responses') return { ...base, operation: OP_RESPONSES };
  if (p === '/v1/chat/completions') return { ...base, operation: OP_CHAT };
  return null;
};

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  displayName: 'OpenAI',
  capabilities: {
    streaming: true,
    reportsCacheRead: true,
    reportsCacheWrite: true,
    reportsCacheTtlBreakdown: false,
    reportsReasoningTokens: true,
    cachingModel: ['implicit', 'explicit'],
    secretQueryParams: [],
    secretHeaders: ['authorization', 'openai-organization', 'openai-project'],
    docs: {
      caching: 'https://developers.openai.com/api/docs/guides/prompt-caching',
      usage: 'https://developers.openai.com/api/reference',
    },
  },
  endpoints: ['POST /v1/responses', 'POST /v1/chat/completions'],
  matchEndpoint: (method, path) => matchEndpoint(method, path),
  parseRequest,
  parseResponse,
  createStreamAccumulator: (match) =>
    match.operation === OP_RESPONSES ? new ResponsesStreamAccumulator() : new ChatStreamAccumulator(),
  requestIdFromHeaders: (headers) => headerValue(headers, 'x-request-id'),
};
