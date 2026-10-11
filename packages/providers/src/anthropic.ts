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
  get,
  headerValue,
  isRecord,
  joinText,
  jsonText,
  makeSegment,
  nonEmpty,
  num,
  parseJson,
  rec,
  str,
  unavailableUsage,
} from './util.js';

/*
 * Anthropic Messages API (POST /v1/messages). Cache prefix order: tools → system → messages.
 * Usage rules: see docs/ARCHITECTURE.md ("Anthropic Messages").
 */

const OP_MESSAGES = 'anthropic.messages';
const MEDIA_BLOCKS = new Set(['image', 'document', 'file', 'container_upload', 'search_result']);

/** cache_control marker → "ephemeral" | "ephemeral:1h" | null. */
const cacheControlOf = (node: unknown): string | null => {
  const cc = get(node, 'cache_control');
  if (!isRecord(cc)) return null;
  const type = str(cc.type) ?? 'ephemeral';
  const ttl = str(cc.ttl);
  return ttl !== null && ttl !== '5m' ? `${type}:${ttl}` : type;
};

/** Last cache marker among a list of blocks (the breakpoint that matters for the message). */
const lastCacheControl = (blocks: unknown[]): string | null => {
  let found: string | null = null;
  for (const b of blocks) found = cacheControlOf(b) ?? found;
  return found;
};

const blockText = (b: unknown): string | null => {
  if (typeof b === 'string') return b;
  const type = str(get(b, 'type'));
  switch (type) {
    case 'text':
      return str(get(b, 'text'));
    case 'thinking':
      return str(get(b, 'thinking'));
    case 'tool_use':
    case 'server_tool_use':
      return joinText([str(get(b, 'name')), jsonText(get(b, 'input'))]);
    case 'tool_result': {
      const c = get(b, 'content');
      return typeof c === 'string' ? c : joinText(arr(c).map(blockText));
    }
    case 'document': {
      const src = get(b, 'source');
      const st = str(get(src, 'type'));
      if (st === 'text') return joinText([str(get(b, 'title')), str(get(src, 'data'))]);
      if (st === 'content') {
        const c = get(src, 'content');
        return joinText([str(get(b, 'title')), typeof c === 'string' ? c : joinText(arr(c).map(blockText))]);
      }
      return str(get(b, 'title'));
    }
    default:
      return null;
  }
};

/** True when a document block carries only binary data (pdf base64 / file id / url). */
const isBinaryDocument = (b: unknown): boolean => {
  const st = str(get(b, 'source', 'type'));
  return st !== 'text' && st !== 'content';
};

const roleKind = (role: string | null): SegmentKind =>
  role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'other';

const parseRequest = (body: unknown, _match: EndpointMatch): ParsedRequest => {
  const b = rec(body);
  const segments: RawSegment[] = [];
  const thinkingType = str(get(b, 'thinking', 'type'));
  const budget = num(get(b, 'thinking', 'budget_tokens'));
  const effort = str(get(b, 'output_config', 'effort'));
  const features: RequestFeatures = {
    stream: b.stream === true,
    toolCount: 0,
    toolChoice: ((): string | null => {
      const tc = b.tool_choice;
      if (!isRecord(tc)) return null;
      const type = str(tc.type);
      const name = str(tc.name);
      return type !== null && name !== null ? `${type}:${name}` : type;
    })(),
    structuredOutput: false,
    reasoning:
      thinkingType !== null && thinkingType !== 'disabled'
        ? budget !== null
          ? `${thinkingType}:${budget}`
          : thinkingType
        : effort,
    cacheControlBlocks: 0,
    attachments: 0,
    messageCount: 0,
    systemBlocks: 0,
    cacheOptions: {},
  };

  // Top-level cache_control = automatic caching (the API places the breakpoint itself).
  const auto = cacheControlOf(b);
  if (auto !== null) {
    features.cacheOptions.automatic = auto;
    features.cacheControlBlocks++;
  }

  // 1. tools
  const tools = arr(b.tools);
  features.toolCount = tools.length;
  tools.forEach((t, i) => {
    const cc = cacheControlOf(t);
    if (cc !== null) features.cacheControlBlocks++;
    const name = nonEmpty(get(t, 'name')) ?? nonEmpty(get(t, 'type')) ?? `tool ${i}`;
    segments.push(
      makeSegment({
        kind: 'tool_definition',
        path: `/tools/${i}`,
        label: name,
        node: t,
        plainText: joinText([name, str(get(t, 'description'))]),
        cacheControl: cc,
      }),
    );
  });

  // Structured outputs (output_config.format / legacy output_format json_schema)
  const fmt = get(b, 'output_config', 'format') ?? b.output_format;
  if (str(get(fmt, 'type')) === 'json_schema') {
    features.structuredOutput = true;
    segments.push(
      makeSegment({
        kind: 'schema',
        path: get(b, 'output_config', 'format') !== undefined ? '/output_config/format' : '/output_format',
        label: 'response schema',
        node: fmt,
        plainText: jsonText(get(fmt, 'schema')),
      }),
    );
  }

  // 2. system
  if (typeof b.system === 'string') {
    features.systemBlocks = 1;
    segments.push(
      makeSegment({
        kind: 'system',
        role: 'system',
        path: '/system',
        label: 'system prompt',
        node: b.system,
      }),
    );
  } else if (Array.isArray(b.system)) {
    b.system.forEach((blk, i) => {
      features.systemBlocks++;
      const cc = cacheControlOf(blk);
      if (cc !== null) features.cacheControlBlocks++;
      segments.push(
        makeSegment({
          kind: 'system',
          role: 'system',
          path: `/system/${i}`,
          label: `system block ${i}`,
          node: blk,
          plainText: blockText(blk) ?? '',
          cacheControl: cc,
        }),
      );
    });
  }

  // 3. messages
  const msgs = arr(b.messages);
  features.messageCount = msgs.length;
  msgs.forEach((m, i) => {
    const role = str(get(m, 'role'));
    const content = get(m, 'content');
    const path = `/messages/${i}`;
    if (typeof content === 'string') {
      segments.push(
        makeSegment({
          kind: roleKind(role),
          role,
          path,
          label: `${role ?? 'message'} #${i}`,
          node: m,
          plainText: content,
          messageIndex: i,
        }),
      );
      return;
    }
    const blocks = arr(content);
    for (const blk of blocks) {
      if (cacheControlOf(blk) !== null) features.cacheControlBlocks++;
      if (MEDIA_BLOCKS.has(str(get(blk, 'type')) ?? '')) features.attachments++;
    }
    const docs: { blk: unknown; j: number }[] = [];
    const rest: { blk: unknown; j: number }[] = [];
    blocks.forEach((blk, j) => (str(get(blk, 'type')) === 'document' ? docs : rest).push({ blk, j }));

    if (rest.length > 0 || docs.length === 0) {
      const restBlocks = rest.map((r) => r.blk);
      const onlyToolResults =
        restBlocks.length > 0 && restBlocks.every((x) => str(get(x, 'type')) === 'tool_result');
      const onlyToolUse =
        role === 'assistant' &&
        restBlocks.length > 0 &&
        restBlocks.every((x) => str(get(x, 'type')) === 'tool_use');
      const allMedia =
        restBlocks.length > 0 && restBlocks.every((x) => MEDIA_BLOCKS.has(str(get(x, 'type')) ?? ''));
      const kind: SegmentKind =
        role === 'user' && onlyToolResults ? 'tool_result' : onlyToolUse ? 'tool_call' : roleKind(role);
      // When documents are split out, the message segment covers only the remaining blocks.
      const node = docs.length === 0 ? m : { role, content: restBlocks };
      segments.push(
        makeSegment({
          kind,
          role,
          path,
          label:
            kind === 'tool_call'
              ? joinText(restBlocks.map((x) => str(get(x, 'name')))) || `tool call #${i}`
              : `${role ?? 'message'} #${i}`,
          node,
          plainText: joinText(restBlocks.map(blockText)),
          cacheControl: lastCacheControl(restBlocks),
          messageIndex: i,
          multimodal: allMedia,
        }),
      );
    }
    for (const { blk, j } of docs) {
      segments.push(
        makeSegment({
          kind: 'document',
          role,
          path: `${path}/content/${j}`,
          label: nonEmpty(get(blk, 'title')) ?? `document #${i}.${j}`,
          node: blk,
          plainText: blockText(blk) ?? '',
          cacheControl: cacheControlOf(blk),
          messageIndex: i,
          multimodal: isBinaryDocument(blk),
        }),
      );
    }
  });

  return { model: str(b.model), stream: b.stream === true, features, segments };
};

// ---------------------------------------------------------------------------------------------
// Usage

/**
 * Anthropic usage. `input_tokens` is only the uncached part after the last cache breakpoint;
 * total = input + cache_creation + cache_read.
 *
 * ASSUMPTION: when a usage object has a numeric `input_tokens` but omits
 * `cache_creation_input_tokens` / `cache_read_input_tokens` (older API versions or requests
 * without caching), the absent cache counters are treated as 0 — the API only omits them when
 * nothing was read from or written to the cache.
 */
export const anthropicUsage = (u: unknown): NormalizedUsage => {
  if (!isRecord(u)) return unavailableUsage();
  const input = num(u.input_tokens);
  const zeroIfAbsent = (v: unknown): number | null => {
    const n = num(v);
    if (n !== null) return n;
    return input !== null && (v === undefined || v === null) ? 0 : null;
  };
  const write = zeroIfAbsent(u.cache_creation_input_tokens);
  const read = zeroIfAbsent(u.cache_read_input_tokens);
  const cc = u.cache_creation;
  const w5 = num(get(cc, 'ephemeral_5m_input_tokens'));
  const w1 = num(get(cc, 'ephemeral_1h_input_tokens'));
  const other: Record<string, number> = {};
  const web = num(get(u, 'server_tool_use', 'web_search_requests'));
  if (web !== null) other.webSearchRequests = web;
  const fetches = num(get(u, 'server_tool_use', 'web_fetch_requests'));
  if (fetches !== null) other.webFetchRequests = fetches;
  return {
    totalInputTokens: input !== null && write !== null && read !== null ? input + write + read : null,
    uncachedInputTokens: input,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheWrite5mTokens: isRecord(cc) ? (w5 ?? 0) : null,
    cacheWrite1hTokens: isRecord(cc) ? (w1 ?? 0) : null,
    outputTokens: num(u.output_tokens),
    // Anthropic does not report thinking tokens separately (they are billed inside output_tokens).
    reasoningTokens: null,
    providerTotalTokens: null,
    other,
    source: 'reported',
    complete: true,
    raw: u,
  };
};

const outputChars = (content: unknown): number | null => {
  const blocks = arr(content);
  if (blocks.length === 0) return null;
  let n = 0;
  for (const blk of blocks) {
    const t = str(get(blk, 'type'));
    if (t === 'text') n += (str(get(blk, 'text')) ?? '').length;
    else if (t === 'thinking') n += (str(get(blk, 'thinking')) ?? '').length;
    else if (t === 'tool_use') n += jsonText(get(blk, 'input')).length;
  }
  return n;
};

const parseResponse = (body: unknown, _match: EndpointMatch): ParsedResponse => {
  const b = rec(body);
  const isError = str(b.type) === 'error';
  return {
    model: str(b.model),
    providerRequestId: str(b.id) ?? str(b.request_id),
    usage: b.usage === undefined || b.usage === null ? unavailableUsage() : anthropicUsage(b.usage),
    finishReason: str(b.stop_reason) ?? (isError ? 'error' : null),
    outputChars: outputChars(b.content),
  };
};

// ---------------------------------------------------------------------------------------------
// Streaming

const MEANINGFUL_DELTAS = new Set(['text_delta', 'input_json_delta', 'thinking_delta']);
const NOTHING: StreamEventResult = { meaningfulOutput: false, terminal: false };

class AnthropicStreamAccumulator implements StreamAccumulator {
  private model: string | null = null;
  private id: string | null = null;
  /** Merged usage: message_start usage, then later non-null message_delta fields override. */
  private usage: Record<string, unknown> | null = null;
  private finishReason: string | null = null;
  private chars = 0;
  private sawOutput = false;
  private stopped = false;

  private mergeUsage(u: unknown): void {
    if (!isRecord(u)) return;
    const merged: Record<string, unknown> = { ...(this.usage ?? {}) };
    for (const [k, v] of Object.entries(u)) if (v !== null && v !== undefined) merged[k] = v;
    this.usage = merged;
  }

  onEvent(e: SseEvent): StreamEventResult {
    const data = parseJson(e.data);
    const type = (isRecord(data) ? str(data.type) : null) ?? e.event;
    switch (type) {
      case 'message_start': {
        const msg = get(data, 'message');
        this.model = str(get(msg, 'model')) ?? this.model;
        this.id = str(get(msg, 'id')) ?? this.id;
        this.mergeUsage(get(msg, 'usage'));
        return NOTHING;
      }
      case 'content_block_delta': {
        const delta = get(data, 'delta');
        const dt = str(get(delta, 'type')) ?? '';
        if (!MEANINGFUL_DELTAS.has(dt)) return NOTHING;
        const piece =
          str(get(delta, 'text')) ?? str(get(delta, 'partial_json')) ?? str(get(delta, 'thinking')) ?? '';
        this.chars += piece.length;
        this.sawOutput = true;
        return { meaningfulOutput: true, terminal: false };
      }
      case 'message_delta':
        this.finishReason = str(get(data, 'delta', 'stop_reason')) ?? this.finishReason;
        this.mergeUsage(get(data, 'usage'));
        return NOTHING;
      case 'message_stop':
        this.stopped = true;
        return { meaningfulOutput: false, terminal: true };
      case 'error':
        this.finishReason = 'error';
        return { meaningfulOutput: false, terminal: true };
      default:
        return NOTHING; // ping, content_block_start/stop, unknown
    }
  }

  finish(_completed: boolean): ParsedResponse {
    let usage: NormalizedUsage;
    if (this.usage === null) usage = unavailableUsage();
    else {
      usage = anthropicUsage(this.usage);
      // Output tokens are only final once message_stop arrived.
      usage.complete = this.stopped;
    }
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

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  displayName: 'Anthropic',
  capabilities: {
    streaming: true,
    reportsCacheRead: true,
    reportsCacheWrite: true,
    reportsCacheTtlBreakdown: true,
    reportsReasoningTokens: false,
    cachingModel: ['explicit', 'implicit'],
    secretQueryParams: [],
    secretHeaders: ['x-api-key', 'authorization'],
    docs: {
      caching: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
      usage: 'https://platform.claude.com/docs/en/api/messages',
    },
  },
  endpoints: ['POST /v1/messages'],
  matchEndpoint: (method, path) => {
    if (method.toUpperCase() !== 'POST') return null;
    const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    if (p !== '/v1/messages') return null;
    return {
      provider: 'anthropic',
      operation: OP_MESSAGES,
      path: p,
      modelFromPath: null,
      streamFromPath: false,
      sse: false,
    };
  },
  parseRequest,
  parseResponse,
  createStreamAccumulator: () => new AnthropicStreamAccumulator(),
  requestIdFromHeaders: (headers) =>
    headerValue(headers, 'request-id') ?? headerValue(headers, 'x-request-id'),
};
