import type {
  EndpointMatch,
  ParsedRequest,
  ParsedResponse,
  ProviderAdapter,
  SseEvent,
  StreamAccumulator,
  StreamEventResult,
} from '@contextscope/core';
import type { NormalizedUsage, RawSegment, RequestFeatures } from '@contextscope/shared';
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
 * Gemini API: POST /{v1beta|v1|v1alpha}/models/{model}:generateContent | :streamGenerateContent.
 * Usage rules: see docs/ARCHITECTURE.md ("Gemini").
 */

const PATH_RE = /^\/(v1beta|v1|v1alpha)\/models\/([A-Za-z0-9._-]+):(generateContent|streamGenerateContent)$/;

const partText = (p: unknown): string | null => {
  if (!isRecord(p)) return null;
  if (typeof p.text === 'string') return p.text;
  if (isRecord(p.functionCall)) return joinText([str(p.functionCall.name), jsonText(p.functionCall.args)]);
  if (isRecord(p.functionResponse))
    return joinText([str(p.functionResponse.name), jsonText(p.functionResponse.response)]);
  if (isRecord(p.executableCode)) return str(p.executableCode.code);
  if (isRecord(p.codeExecutionResult)) return str(p.codeExecutionResult.output);
  return null;
};

const isMediaPart = (p: unknown): boolean => isRecord(p) && (isRecord(p.inlineData) || isRecord(p.fileData));

const parseRequest = (body: unknown, match: EndpointMatch): ParsedRequest => {
  const b = rec(body);
  const segments: RawSegment[] = [];
  const gc = rec(b.generationConfig);
  const tc = rec(gc.thinkingConfig);
  const level = str(tc.thinkingLevel);
  const budget = typeof tc.thinkingBudget === 'number' ? tc.thinkingBudget : null;
  const fcMode = str(get(b, 'toolConfig', 'functionCallingConfig', 'mode'));
  const features: RequestFeatures = {
    stream: match.streamFromPath,
    toolCount: 0,
    toolChoice: fcMode,
    structuredOutput: false,
    reasoning: level ?? (budget !== null ? `budget:${budget}` : null),
    cacheControlBlocks: 0,
    attachments: 0,
    messageCount: 0,
    systemBlocks: 0,
    cacheOptions: {},
  };

  // 1. systemInstruction
  const si = b.systemInstruction ?? b.system_instruction;
  if (si !== undefined && si !== null) {
    features.systemBlocks = 1;
    const parts = typeof si === 'string' ? [] : arr(get(si, 'parts'));
    segments.push(
      makeSegment({
        kind: 'system',
        role: 'system',
        path: b.systemInstruction !== undefined ? '/systemInstruction' : '/system_instruction',
        label: 'system instruction',
        node: si,
        plainText: typeof si === 'string' ? si : joinText(parts.map(partText)),
      }),
    );
  }

  // 2. tools (one segment per function declaration; other tools such as googleSearch as one each)
  arr(b.tools).forEach((tool, i) => {
    const decls = arr(get(tool, 'functionDeclarations') ?? get(tool, 'function_declarations'));
    if (decls.length > 0) {
      decls.forEach((d, j) => {
        features.toolCount++;
        const name = nonEmpty(get(d, 'name')) ?? `function ${i}.${j}`;
        segments.push(
          makeSegment({
            kind: 'tool_definition',
            path: `/tools/${i}/functionDeclarations/${j}`,
            label: name,
            node: d,
            plainText: joinText([name, str(get(d, 'description'))]),
          }),
        );
      });
    } else if (isRecord(tool)) {
      features.toolCount++;
      segments.push(
        makeSegment({
          kind: 'tool_definition',
          path: `/tools/${i}`,
          label: Object.keys(tool)[0] ?? `tool ${i}`,
          node: tool,
          plainText: '',
        }),
      );
    }
  });

  // Response schema
  const schemaKey =
    gc.responseJsonSchema !== undefined
      ? 'responseJsonSchema'
      : gc.responseSchema !== undefined
        ? 'responseSchema'
        : null;
  if (schemaKey !== null) {
    features.structuredOutput = true;
    segments.push(
      makeSegment({
        kind: 'schema',
        path: `/generationConfig/${schemaKey}`,
        label: 'response schema',
        node: gc[schemaKey],
        plainText: jsonText(gc[schemaKey]),
      }),
    );
  }

  // Explicit cache reference
  const cached = str(b.cachedContent) ?? str(b.cached_content);
  if (cached !== null) {
    features.cacheOptions.cachedContent = cached;
    features.cacheControlBlocks++;
    segments.push(
      makeSegment({
        kind: 'cached_content_ref',
        path: '/cachedContent',
        label: 'cached content',
        node: cached,
        plainText: '',
        cacheControl: 'explicit',
      }),
    );
  }

  // 3. contents
  const contents =
    typeof b.contents === 'string' ? [{ role: 'user', parts: [{ text: b.contents }] }] : arr(b.contents);
  features.messageCount = contents.length;
  contents.forEach((c, i) => {
    const role = str(get(c, 'role'));
    const parts = arr(get(c, 'parts'));
    features.attachments += parts.filter(isMediaPart).length;
    const allMedia = parts.length > 0 && parts.every(isMediaPart);
    const onlyCalls = parts.length > 0 && parts.every((p) => isRecord(get(p, 'functionCall')));
    const onlyResponses = parts.length > 0 && parts.every((p) => isRecord(get(p, 'functionResponse')));
    const onlyFiles = allMedia && parts.every((p) => isRecord(get(p, 'fileData')));
    const kind = onlyCalls
      ? 'tool_call'
      : onlyResponses
        ? 'tool_result'
        : onlyFiles
          ? 'file'
          : allMedia
            ? (str(get(parts[0], 'inlineData', 'mimeType')) ?? '').startsWith('audio/')
              ? 'audio'
              : 'image'
            : role === 'model'
              ? 'assistant'
              : role === 'user' || role === null
                ? 'user'
                : 'other';
    const label =
      kind === 'tool_call' || kind === 'tool_result'
        ? joinText(
            parts.map((p) => str(get(p, kind === 'tool_call' ? 'functionCall' : 'functionResponse', 'name'))),
          ) || `${kind} #${i}`
        : `${role ?? 'user'} #${i}`;
    segments.push(
      makeSegment({
        kind,
        role,
        path: `/contents/${i}`,
        label,
        node: c,
        plainText: joinText(parts.map(partText)),
        messageIndex: i,
        multimodal: allMedia,
      }),
    );
  });

  return { model: match.modelFromPath ?? str(b.model), stream: match.streamFromPath, features, segments };
};

// ---------------------------------------------------------------------------------------------
// Usage

/**
 * promptTokenCount is the TOTAL prompt including cachedContentTokenCount. candidatesTokenCount
 * excludes thoughtsTokenCount, so output = candidates + thoughts and reasoning = thoughts.
 * Gemini reports no cache writes → cacheWriteTokens null.
 */
export const geminiUsage = (u: unknown): NormalizedUsage => {
  if (!isRecord(u)) return unavailableUsage();
  const prompt = num(u.promptTokenCount);
  const cachedRaw = num(u.cachedContentTokenCount);
  // No cachedContentTokenCount with a reported prompt count means nothing was served from cache.
  const cached = cachedRaw ?? (prompt !== null ? 0 : null);
  const candidates = num(u.candidatesTokenCount);
  const thoughts = num(u.thoughtsTokenCount);
  const other: Record<string, number> = {};
  collectOther(other, u, { toolUsePromptTokenCount: 'toolUsePromptTokens' });
  let output: number | null = null;
  if (candidates !== null || thoughts !== null) output = (candidates ?? 0) + (thoughts ?? 0);
  return {
    totalInputTokens: prompt,
    uncachedInputTokens: prompt !== null && cached !== null ? nonNeg(prompt - cached) : null,
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    outputTokens: output,
    reasoningTokens: thoughts ?? (output !== null ? 0 : null),
    providerTotalTokens: num(u.totalTokenCount),
    other,
    source: 'reported',
    complete: true,
    raw: u,
  };
};

/** Meaningful output: a non-empty text part (thought parts included) or a functionCall. */
const chunkOutput = (chunk: unknown): { meaningful: boolean; chars: number } => {
  let meaningful = false;
  let chars = 0;
  for (const cand of arr(get(chunk, 'candidates'))) {
    for (const p of arr(get(cand, 'content', 'parts'))) {
      const t = str(get(p, 'text'));
      if (t !== null && t.length > 0) {
        meaningful = true;
        chars += t.length;
      }
      if (isRecord(get(p, 'functionCall'))) {
        meaningful = true;
        chars += jsonText(get(p, 'functionCall', 'args')).length;
      }
    }
  }
  return { meaningful, chars };
};

class GeminiAccumulator implements StreamAccumulator {
  private model: string | null;
  private id: string | null = null;
  private usage: unknown = undefined;
  private finishReason: string | null = null;
  private chars = 0;
  private sawOutput = false;
  private errored = false;

  constructor(modelFromPath: string | null) {
    this.model = modelFromPath;
  }

  /** Feed one parsed chunk object; returns whether it carried output. */
  addChunk(chunk: unknown): StreamEventResult {
    if (!isRecord(chunk)) return { meaningfulOutput: false, terminal: false };
    if (isRecord(chunk.error)) {
      this.errored = true;
      this.finishReason = 'error';
      return { meaningfulOutput: false, terminal: true };
    }
    this.model = str(chunk.modelVersion) ?? this.model;
    this.id = str(chunk.responseId) ?? this.id;
    // usageMetadata is repeated cumulatively; the last one wins.
    if (isRecord(chunk.usageMetadata)) this.usage = chunk.usageMetadata;
    for (const cand of arr(chunk.candidates))
      this.finishReason = str(get(cand, 'finishReason')) ?? this.finishReason;
    if (this.finishReason === null) this.finishReason = str(get(chunk, 'promptFeedback', 'blockReason'));
    const out = chunkOutput(chunk);
    this.chars += out.chars;
    if (out.meaningful) this.sawOutput = true;
    return { meaningfulOutput: out.meaningful, terminal: false };
  }

  onEvent(e: SseEvent): StreamEventResult {
    return this.addChunk(parseJson(e.data));
  }

  finish(completed: boolean): ParsedResponse {
    let usage: NormalizedUsage;
    if (this.usage === undefined) usage = unavailableUsage();
    else {
      usage = geminiUsage(this.usage);
      // Gemini has no terminal event: the final chunk carries finishReason. Usage is final only
      // when the transport completed and a finish reason was seen.
      usage.complete = completed && this.finishReason !== null && !this.errored;
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

const parseResponse = (body: unknown, match: EndpointMatch): ParsedResponse => {
  const acc = new GeminiAccumulator(match.modelFromPath);
  const chunks = Array.isArray(body) ? body : [body];
  for (const c of chunks) acc.addChunk(c);
  const res = acc.finish(true);
  // A complete JSON body is final even if it carries no finishReason (e.g. prompt blocked).
  if (res.usage.source === 'reported') res.usage.complete = true;
  return res;
};

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  displayName: 'Google Gemini',
  capabilities: {
    streaming: true,
    reportsCacheRead: true,
    reportsCacheWrite: false,
    reportsCacheTtlBreakdown: false,
    reportsReasoningTokens: true,
    cachingModel: ['implicit', 'explicit'],
    secretQueryParams: ['key'],
    secretHeaders: ['x-goog-api-key', 'authorization'],
    docs: {
      caching: 'https://ai.google.dev/gemini-api/docs/caching',
      usage: 'https://ai.google.dev/api/generate-content#UsageMetadata',
    },
  },
  endpoints: [
    'POST /v1beta/models/{model}:generateContent',
    'POST /v1beta/models/{model}:streamGenerateContent',
    'POST /v1/models/{model}:generateContent',
    'POST /v1/models/{model}:streamGenerateContent',
  ],
  matchEndpoint: (method, path, query) => {
    if (method.toUpperCase() !== 'POST') return null;
    const m = PATH_RE.exec(path);
    if (!m) return null;
    const op = m[3] as string;
    const stream = op === 'streamGenerateContent';
    return {
      provider: 'gemini',
      operation: `gemini.${op}`,
      path,
      modelFromPath: m[2] ?? null,
      streamFromPath: stream,
      sse: stream && query.get('alt') === 'sse',
    };
  },
  parseRequest,
  parseResponse,
  createStreamAccumulator: (match) => new GeminiAccumulator(match.modelFromPath),
  requestIdFromHeaders: (headers) => headerValue(headers, 'x-request-id'),
};
