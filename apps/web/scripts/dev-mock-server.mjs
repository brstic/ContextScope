// Dev-only mock of the ContextScope dashboard API (port 3377), shaped exactly like
// packages/shared/src/api.ts. No dependencies: `node scripts/dev-mock-server.mjs`.
// Never imported by src/ — mock data stays out of the app bundle.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 3377);
const NOW = Date.now();
const H = 3600_000;

// Deterministic PRNG so screenshots are stable.
let seed = 42;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => Math.floor(a + rnd() * (b - a + 1));
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');

const MODELS = [
  { provider: 'anthropic', model: 'claude-sonnet-4-5', inP: 3, outP: 15 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', inP: 1, outP: 5 },
  { provider: 'openai', model: 'gpt-5', inP: 1.25, outP: 10 },
  { provider: 'openai', model: 'gpt-5-mini', inP: 0.25, outP: 2 },
  { provider: 'gemini', model: 'gemini-2.5-pro', inP: 1.25, outP: 10 },
];
const SESSIONS = ['agent-refactor-7f2', 'support-bot-19', 'rag-eval-batch', 'cli-chat-a01', 'code-review-3c'];
const ENDPOINTS = { openai: '/v1/responses', anthropic: '/v1/messages', gemini: '/v1beta/models:generateContent' };

/** Builds one captured request (internal shape → DTOs below). */
const makeRequest = (i, at) => {
  const m = MODELS[i % 7 === 0 ? 4 : int(0, 3)];
  const sessionId = rnd() < 0.85 ? SESSIONS[i % SESSIONS.length] : null;
  const noUsage = i % 23 === 5; // stream cut before the final usage event
  const unpriced = i % 31 === 7;
  const failed = i % 19 === 3;
  const total = int(4000, 90000);
  const read = m.provider === 'gemini' && rnd() < 0.5 ? 0 : Math.floor(total * (0.3 + rnd() * 0.6));
  const write = m.provider === 'anthropic' ? Math.floor((total - read) * rnd() * 0.5) : 0;
  const uncached = total - read - write;
  const out = int(80, 3500);
  const reasoning = m.provider === 'anthropic' ? null : Math.floor(out * rnd() * 0.5);
  const nano = (tokens, perM) => Math.round((tokens * perM * 1000) / 1); // µUSD/1M → nano per token = perM*1000
  const cost = {
    uncachedInputNanoUsd: nano(uncached, m.inP),
    cacheReadNanoUsd: nano(read, m.inP * 0.1),
    cacheWriteNanoUsd: nano(write, m.inP * 1.25),
    outputNanoUsd: nano(out, m.outP),
  };
  const totalCost = cost.uncachedInputNanoUsd + cost.cacheReadNanoUsd + cost.cacheWriteNanoUsd + cost.outputNanoUsd;
  const duration = failed ? int(200, 30000) : int(600, 24000);
  const ttft = m.provider === 'gemini' && i % 3 === 0 ? null : int(180, Math.min(duration, 4000));
  return {
    id: `req_${(1000 + i).toString(36)}${hex(6)}`,
    startedAt: new Date(at).toISOString(),
    provider: m.provider,
    model: m.model,
    endpoint: ENDPOINTS[m.provider],
    sessionId,
    state: failed ? pick(['upstream_error', 'client_aborted']) : 'completed',
    httpStatus: failed ? pick([502, 429, null]) : 200,
    stream: rnd() < 0.7,
    noUsage,
    unpriced: unpriced || noUsage,
    usage: { total, uncached, read, write, out, reasoning },
    cost,
    totalCost,
    duration: failed && i % 2 ? null : duration,
    ttft,
    findingCount: 0,
    segments: makeSegments(i, total),
  };
};

const KIND_PLAN = [
  ['tool_definition', 'tool', 'read_file'],
  ['tool_definition', 'tool', 'search_code'],
  ['tool_definition', 'tool', 'run_tests'],
  ['system', 'system', 'system prompt'],
  ['developer', 'developer', 'repository rules'],
  ['user', 'user', 'message 0'],
  ['assistant', 'assistant', 'message 1'],
  ['tool_call', 'assistant', 'search_code call'],
  ['tool_result', 'tool', 'search_code result'],
  ['document', 'user', 'retrieved: README.md'],
  ['assistant', 'assistant', 'message 4'],
  ['user', 'user', 'latest user message'],
];
const makeSegments = (i, total) => {
  const n = 7 + (i % 6);
  const plan = [...KIND_PLAN.slice(0, n - 1), KIND_PLAN[KIND_PLAN.length - 1]];
  const weights = plan.map(([k]) => (k === 'tool_definition' ? 6 : k === 'system' ? 8 : k === 'document' ? 14 : k === 'tool_result' ? 10 : 3) * (0.6 + rnd()));
  const sum = weights.reduce((a, b) => a + b, 0);
  let prefix = hex(32);
  return plan.map(([kind, role, label], idx) => {
    const est = Math.max(8, Math.round((weights[idx] / sum) * total));
    const fp = idx < 5 ? `f${idx}${'0'.repeat(30)}`.slice(0, 32) : hex(32);
    prefix = idx < 5 ? `p${idx}${'a'.repeat(30)}`.slice(0, 32) : hex(32);
    return {
      index: idx,
      kind,
      role,
      path: kind === 'tool_definition' ? `/tools/${idx}` : kind === 'system' ? '/system' : `/messages/${idx - 3}`,
      label,
      byteLength: est * 4,
      charLength: est * 4 - 3,
      estimatedTokens: kind === 'image' ? null : est,
      tokenSource: idx === 0 && i % 2 ? 'exact_local' : 'estimated',
      exactFingerprint: fp,
      normalizedFingerprint: fp,
      prefixFingerprint: prefix,
      cacheControl: idx === 3 ? 'ephemeral' : idx === 4 && i % 2 ? 'ephemeral:1h' : null,
      messageIndex: idx < 5 ? null : idx - 5,
      multimodal: false,
      duplicateCountInRequest: kind === 'document' && i % 3 === 0 ? 1 : 0,
      seenInRequests: idx < 5 ? 40 + i : idx === plan.length - 1 ? 0 : i % 5 === 0 ? null : int(0, 6),
    };
  });
};

const REQUESTS = [];
for (let i = 0; i < 160; i++) REQUESTS.push(makeRequest(i, NOW - i * 9 * 60_000 - int(0, 300_000)));

const summary = (r) => ({
  id: r.id,
  startedAt: r.startedAt,
  provider: r.provider,
  model: r.model,
  endpoint: r.endpoint,
  sessionId: r.sessionId,
  state: r.state,
  httpStatus: r.httpStatus,
  stream: r.stream,
  totalInputTokens: r.noUsage ? null : r.usage.total,
  outputTokens: r.noUsage ? null : r.usage.out,
  cacheReadTokens: r.noUsage ? null : r.usage.read,
  cacheWriteTokens: r.noUsage ? null : r.provider === 'anthropic' ? r.usage.write : null,
  totalNanoUsd: r.unpriced ? null : r.totalCost,
  durationMs: r.duration,
  ttftMs: r.ttft,
  findingCount: r.findingCount,
  demo: true,
});

const FINDING_DEFS = [
  ['unstable_prefix', 'Timestamp in system prompt breaks the cache prefix', 'high', 'caching', 4200],
  ['oversized_tool_schemas', '14 tool definitions use 9.8k tokens per request', 'medium', 'input_volume', 6100],
  ['repeated_retrieval_payload', 'README.md retrieved and resent in 12 consecutive turns', 'medium', 'both', 11800],
  ['low_cache_reuse', 'gemini-2.5-pro requests never hit the implicit cache', 'low', 'caching', null],
  ['expensive_model_usage', 'Short classification calls run on claude-sonnet-4-5', 'low', 'cost', null],
  ['slow_request', 'p95 latency above 20 s for gpt-5 streaming', 'info', 'latency', null],
  ['duplicate_segment', 'Same document attached twice in one request', 'medium', 'input_volume', 2300],
];
const FINDINGS = FINDING_DEFS.map(([type, title, severity, affects, est], k) => {
  const reqs = REQUESTS.filter((_, i) => i % (k + 3) === 0).slice(0, 5);
  reqs.forEach((r) => (r.findingCount += 1));
  return {
    id: `fnd_${k}${hex(5)}`,
    type,
    title,
    severity,
    confidence: pick(['high', 'medium', 'low']),
    description: `${title}. Detected across ${reqs.length} recent requests by comparing segment fingerprints.`,
    evidence: [
      `Segment #3 (system) changed in ${reqs.length} of ${reqs.length + 2} consecutive requests`,
      'First differing bytes at offset 1,204: "Current time: 2026-10-11T09:…"',
    ],
    recommendation: 'Move volatile values (dates, request ids) after the last cache breakpoint.',
    tradeoff: 'The model sees the timestamp later in the context; rarely affects quality.',
    affects,
    requestIds: reqs.map((r) => r.id),
    segmentIndexes: [3],
    estimatedTokenReduction: est,
    docsUrl: k % 2 ? null : 'https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching',
    createdAt: new Date(NOW - k * 2 * H).toISOString(),
    sessionId: reqs[0]?.sessionId ?? null,
  };
});

const usage = (r) => ({
  totalInputTokens: r.noUsage ? null : r.usage.total,
  uncachedInputTokens: r.noUsage ? null : r.usage.uncached,
  cacheReadTokens: r.noUsage ? null : r.usage.read,
  cacheWriteTokens: r.noUsage ? null : r.provider === 'anthropic' ? r.usage.write : null,
  cacheWrite5mTokens: r.provider === 'anthropic' && !r.noUsage ? r.usage.write : null,
  cacheWrite1hTokens: r.provider === 'anthropic' && !r.noUsage ? 0 : null,
  outputTokens: r.noUsage ? null : r.usage.out,
  reasoningTokens: r.noUsage ? null : r.usage.reasoning,
  providerTotalTokens: r.noUsage || r.provider === 'anthropic' ? null : r.usage.total + r.usage.out,
  other: {},
  source: r.noUsage ? 'unavailable' : 'reported',
  complete: !r.noUsage,
  raw: r.noUsage ? null : { input_tokens: r.usage.uncached, output_tokens: r.usage.out },
});

const PRICING = { version: '2026-10-01', source: 'bundled public price lists', effectiveDate: '2026-10-01' };
const DISCLAIMER =
  'Costs are estimates computed from public list prices and provider-reported usage. They are not invoices; discounts, batch pricing and taxes are not included.';

const prevOf = (r) => {
  const idx = REQUESTS.indexOf(r);
  return REQUESTS.slice(idx + 1).find((x) => x.sessionId && x.sessionId === r.sessionId) ?? REQUESTS[idx + 1] ?? null;
};

const detail = (r) => {
  const prev = prevOf(r);
  const firstChanged = prev ? 5 : null;
  return {
    id: r.id,
    providerRequestId: r.provider === 'gemini' ? null : `${r.provider === 'openai' ? 'resp' : 'msg'}_${hex(20)}`,
    traceId: rnd() < 0.5 ? hex(32) : null,
    sessionId: r.sessionId,
    projectId: 'default',
    provider: r.provider,
    model: r.model,
    endpoint: r.endpoint,
    method: 'POST',
    httpStatus: r.httpStatus,
    state: r.state,
    errorMessage: r.state === 'completed' ? null : 'upstream closed the stream before message_stop',
    timing: {
      startedAt: r.startedAt,
      endedAt: r.duration === null ? null : new Date(Date.parse(r.startedAt) + r.duration).toISOString(),
      durationMs: r.duration,
      ttfbMs: r.duration === null ? null : Math.min(r.duration, 140 + (r.ttft ?? 200) / 3),
      ttftMs: r.ttft,
      connectMs: r.provider === 'gemini' ? null : 38,
    },
    requestBytes: r.usage.total * 4,
    responseBytes: r.state === 'completed' ? r.usage.out * 5 : null,
    stream: r.stream,
    streamCompleted: r.stream ? r.state === 'completed' : null,
    usage: usage(r),
    cost: r.unpriced
      ? r.noUsage
        ? null
        : {
            currency: 'USD',
            uncachedInputNanoUsd: null,
            cacheReadNanoUsd: null,
            cacheWriteNanoUsd: null,
            outputNanoUsd: null,
            totalNanoUsd: null,
            actualCacheSavingsNanoUsd: null,
            pricingModelKey: null,
            pricingSource: null,
            pricingVersion: PRICING.version,
            confidence: null,
            notes: ['Pricing unavailable for this model'],
          }
      : {
          currency: 'USD',
          ...r.cost,
          totalNanoUsd: r.totalCost,
          actualCacheSavingsNanoUsd: Math.round(r.cost.cacheReadNanoUsd * 9),
          pricingModelKey: `${r.provider}/${r.model}`,
          pricingSource: PRICING.source,
          pricingVersion: PRICING.version,
          confidence: 'high',
          notes: r.usage.total > 200000 ? ['long-context tier applied'] : [],
        },
    features: {
      stream: r.stream,
      toolCount: 3,
      toolChoice: r.provider === 'openai' ? 'auto' : null,
      structuredOutput: r.provider === 'openai',
      reasoning: r.provider === 'anthropic' ? null : 'medium',
      cacheControlBlocks: r.provider === 'anthropic' ? 2 : 0,
      attachments: 0,
      messageCount: r.segments.length - 4,
      systemBlocks: 1,
      cacheOptions: r.provider === 'openai' ? { prompt_cache_key: 'agent-v3' } : {},
    },
    demo: true,
    origin: 'demo',
    previousRequestId: prev?.id ?? null,
    prefix: prev
      ? {
          againstRequestId: prev.id,
          sharedSegments: 5,
          sharedEstimatedTokens: r.segments.slice(0, 5).reduce((a, s) => a + (s.estimatedTokens ?? 0), 0),
          firstChangedSegmentIndex: firstChanged,
          firstChangedKind: r.segments[5]?.kind ?? null,
          firstChangedLabel: r.segments[5]?.label ?? null,
          totalSegments: r.segments.length,
          note: 'Tools, system and developer segments are byte-identical to the previous request; the conversation diverges at message 0.',
        }
      : null,
    contentAvailable: hasContent(r),
  };
};
const hasContent = (r) => REQUESTS.indexOf(r) % 2 === 0;

const content = (r) => ({
  requestId: r.id,
  request: {
    model: r.model,
    max_tokens: 4096,
    system: [{ type: 'text', text: 'You are a careful coding agent.', cache_control: { type: 'ephemeral' } }],
    messages: r.segments.filter((s) => s.messageIndex !== null).map((s) => ({ role: s.role, content: `(${s.label}) …` })),
  },
  response: { id: `msg_${hex(12)}`, content: [{ type: 'text', text: 'Here is the refactored function…' }], usage: usage(r).raw },
  segments: r.segments.map((s) => (s.kind === 'image' ? null : `${s.label}: lorem ipsum dolor sit amet `.repeat(4))),
  expiresAt: new Date(NOW + 20 * H).toISOString(),
  storage: 'memory',
});

// ---------- aggregates ----------
const inRange = (r, q) =>
  (!q.from || r.startedAt >= q.from) &&
  (!q.to || r.startedAt <= q.to) &&
  (!q.provider || r.provider === q.provider) &&
  (!q.model || r.model === q.model);

const hitRateOf = (rows) => {
  const rep = rows.filter((r) => !r.noUsage);
  const tot = rep.reduce((a, r) => a + r.usage.total, 0);
  return tot ? rep.reduce((a, r) => a + r.usage.read, 0) / tot : null;
};
const sumU = (rows, k) => rows.filter((r) => !r.noUsage).reduce((a, r) => a + r.usage[k], 0);
const sumCost = (rows, k) => rows.filter((r) => !r.unpriced).reduce((a, r) => a + (k ? r.cost[k] : r.totalCost), 0);
const avgDur = (rows) => {
  const d = rows.map((r) => r.duration).filter((x) => x !== null);
  return d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null;
};
const savings = (rows) => sumCost(rows, 'cacheReadNanoUsd') * 9;

const buckets = (rows, bucket) => {
  const size = bucket === 'day' ? 24 * H : H;
  const map = new Map();
  for (const r of rows) {
    const t = Math.floor(Date.parse(r.startedAt) / size) * size;
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(r);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, rs]) => ({
      t: new Date(t).toISOString(),
      requests: rs.length,
      errors: rs.filter((r) => r.state !== 'completed').length,
      inputTokens: sumU(rs, 'total'),
      outputTokens: sumU(rs, 'out'),
      cacheReadTokens: sumU(rs, 'read'),
      cacheWriteTokens: sumU(rs, 'write'),
      uncachedInputTokens: sumU(rs, 'uncached'),
      totalNanoUsd: sumCost(rs),
      cacheReadNanoUsd: sumCost(rs, 'cacheReadNanoUsd'),
      uncachedInputNanoUsd: sumCost(rs, 'uncachedInputNanoUsd'),
      cacheWriteNanoUsd: sumCost(rs, 'cacheWriteNanoUsd'),
      outputNanoUsd: sumCost(rs, 'outputNanoUsd'),
      avgDurationMs: avgDur(rs),
    }));
};

const byModel = (rows) =>
  MODELS.map(({ provider, model }) => {
    const rs = rows.filter((r) => r.model === model);
    return {
      provider,
      model,
      requests: rs.length,
      inputTokens: sumU(rs, 'total'),
      outputTokens: sumU(rs, 'out'),
      cacheReadTokens: sumU(rs, 'read'),
      cacheWriteTokens: sumU(rs, 'write'),
      totalNanoUsd: sumCost(rs),
      unpriced: rs.filter((r) => r.unpriced).length,
      cacheHitRate: hitRateOf(rs),
      avgDurationMs: avgDur(rs),
      actualSavingsNanoUsd: savings(rs),
    };
  }).filter((m) => m.requests > 0);

const byProvider = (rows) =>
  ['anthropic', 'openai', 'gemini']
    .map((provider) => {
      const rs = rows.filter((r) => r.provider === provider);
      return { provider, rs };
    })
    .filter((p) => p.rs.length);

const sessionSummary = (id) => {
  const rs = REQUESTS.filter((r) => r.sessionId === id);
  return {
    id,
    firstSeen: rs[rs.length - 1].startedAt,
    lastSeen: rs[0].startedAt,
    requests: rs.length,
    inputTokens: sumU(rs, 'total'),
    outputTokens: sumU(rs, 'out'),
    cacheReadTokens: sumU(rs, 'read'),
    totalNanoUsd: sumCost(rs),
    cacheHitRate: id === 'rag-eval-batch' ? null : hitRateOf(rs),
    avgDurationMs: avgDur(rs),
    models: [...new Set(rs.map((r) => r.model))],
    findingCount: FINDINGS.filter((f) => f.sessionId === id).length,
  };
};

// ---------- routes ----------
const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, version: '1.0.0-dev', uptimeS: Math.round((Date.now() - NOW) / 1000) + 5321, demo: true, queue: { depth: 2, dropped: 0, capacity: 10000 } })],
  ['GET', /^\/api\/filters$/, () => ({
    providers: ['anthropic', 'openai', 'gemini'],
    models: MODELS.map(({ provider, model }) => ({ provider, model })),
    sessions: SESSIONS.length,
    states: ['pending', 'completed', 'client_aborted', 'upstream_error', 'rejected'],
  })],
  ['GET', /^\/api\/overview$/, (_m, q) => {
    const rows = REQUESTS.filter((r) => inRange(r, q));
    const span = q.from && q.to ? Date.parse(q.to) - Date.parse(q.from) : 30 * 24 * H;
    const durs = rows.map((r) => r.duration).filter((x) => x !== null).sort((a, b) => a - b);
    return {
      range: { from: q.from ?? new Date(NOW - 30 * 24 * H).toISOString(), to: q.to ?? new Date(NOW).toISOString() },
      totals: {
        requests: rows.length,
        errors: rows.filter((r) => r.state !== 'completed').length,
        inputTokens: sumU(rows, 'total'),
        outputTokens: sumU(rows, 'out'),
        cacheReadTokens: sumU(rows, 'read'),
        cacheWriteTokens: sumU(rows, 'write'),
        cacheHitRate: hitRateOf(rows),
        totalNanoUsd: sumCost(rows),
        unpricedRequests: rows.filter((r) => r.unpriced).length,
        avgDurationMs: avgDur(rows),
        p95DurationMs: durs.length ? durs[Math.floor(durs.length * 0.95)] : null,
        openFindings: FINDINGS.length,
        requestsWithoutUsage: rows.filter((r) => r.noUsage).length,
      },
      series: buckets(rows, span <= 48 * H ? 'hour' : 'day'),
      byModel: byModel(rows),
      byProvider: byProvider(rows).map(({ provider, rs }) => ({ provider, requests: rs.length, totalNanoUsd: sumCost(rs), inputTokens: sumU(rs, 'total') })),
      topSessions: SESSIONS.map(sessionSummary).sort((a, b) => b.totalNanoUsd - a.totalNanoUsd),
      topRequests: [...rows].filter((r) => !r.unpriced).sort((a, b) => b.totalCost - a.totalCost).slice(0, 10).map(summary),
      recentFindings: FINDINGS.slice(0, 6),
      demo: true,
    };
  }],
  ['GET', /^\/api\/requests$/, (_m, q) => {
    let rows = REQUESTS.filter((r) => inRange(r, q));
    if (q.state) rows = rows.filter((r) => r.state === q.state);
    if (q.session) rows = rows.filter((r) => r.sessionId === q.session);
    if (q.q) rows = rows.filter((r) => [r.id, r.model, r.sessionId, r.endpoint].some((v) => v && v.includes(q.q)));
    const key = { cost: (r) => r.totalCost, duration: (r) => r.duration ?? -1, inputTokens: (r) => r.usage.total }[q.sort] ?? ((r) => Date.parse(r.startedAt));
    rows = [...rows].sort((a, b) => (q.dir === 'asc' ? key(a) - key(b) : key(b) - key(a)));
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50)));
    return { items: rows.slice((page - 1) * pageSize, page * pageSize).map(summary), total: rows.length, page, pageSize };
  }],
  ['GET', /^\/api\/requests\/([^/]+)$/, ([, id]) => withReq(id, detail)],
  ['GET', /^\/api\/requests\/([^/]+)\/context$/, ([, id]) => withReq(id, (r) => ({
    requestId: r.id,
    segments: hasContent(r) ? r.segments.map((s) => ({ ...s, content: `${s.label}: lorem ipsum dolor sit amet ` })) : r.segments,
    contentAvailable: hasContent(r),
    captureMode: hasContent(r) ? 'deep_memory' : 'metadata',
  }))],
  ['GET', /^\/api\/requests\/([^/]+)\/findings$/, ([, id]) => withReq(id, (r) => FINDINGS.filter((f) => f.requestIds.includes(r.id)))],
  ['GET', /^\/api\/requests\/([^/]+)\/content$/, ([, id]) => withReq(id, (r) =>
    hasContent(r) ? content(r) : { status: 404, body: { error: { code: 'content_unavailable', message: 'Content was not captured (capture mode: metadata).' } } },
  )],
  ['GET', /^\/api\/sessions$/, (_m, q) => {
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Number(q.pageSize ?? 50);
    const items = SESSIONS.map(sessionSummary);
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }],
  ['GET', /^\/api\/sessions\/([^/]+)$/, ([, id]) => {
    if (!SESSIONS.includes(id)) return notFound();
    const rs = REQUESTS.filter((r) => r.sessionId === id).reverse();
    return {
      ...sessionSummary(id),
      turns: rs.map((r, i) => ({
        requestId: r.id,
        startedAt: r.startedAt,
        model: r.model,
        totalInputTokens: r.noUsage ? null : r.usage.total,
        uncachedInputTokens: r.noUsage ? null : r.usage.uncached,
        cacheReadTokens: r.noUsage ? null : r.usage.read,
        cacheWriteTokens: r.noUsage ? null : r.usage.write,
        outputTokens: r.noUsage ? null : r.usage.out,
        totalNanoUsd: r.unpriced ? null : r.totalCost,
        durationMs: r.duration,
        segmentCount: r.segments.length,
        firstChangedSegmentIndex: i === 0 ? null : 5,
      })),
      findings: FINDINGS.filter((f) => f.sessionId === id),
    };
  }],
  ['GET', /^\/api\/cache\/summary$/, () => ({
    totals: {
      inputTokens: sumU(REQUESTS, 'total'),
      cacheReadTokens: sumU(REQUESTS, 'read'),
      cacheWriteTokens: sumU(REQUESTS, 'write'),
      cacheHitRate: hitRateOf(REQUESTS),
      actualSavingsNanoUsd: savings(REQUESTS),
      requestsWithCacheRead: REQUESTS.filter((r) => !r.noUsage && r.usage.read > 0).length,
      requestsWithCacheWrite: REQUESTS.filter((r) => !r.noUsage && r.usage.write > 0).length,
      requestsReportingUsage: REQUESTS.filter((r) => !r.noUsage).length,
    },
    byProvider: byProvider(REQUESTS).map(({ provider, rs }) => ({
      provider,
      inputTokens: sumU(rs, 'total'),
      cacheReadTokens: sumU(rs, 'read'),
      cacheWriteTokens: sumU(rs, 'write'),
      cacheHitRate: hitRateOf(rs),
      actualSavingsNanoUsd: savings(rs),
    })),
    byModel: byModel(REQUESTS),
    prefixStability: {
      comparisons: REQUESTS.length - 5,
      avgSharedSegmentRatio: 0.62,
      firstChangeByKind: [
        { kind: 'user', count: 88 },
        { kind: 'system', count: 31 },
        { kind: 'tool_definition', count: 12 },
        { kind: 'document', count: 9 },
        { kind: 'developer', count: 3 },
      ],
    },
    findings: FINDINGS.filter((f) => f.affects === 'caching' || f.affects === 'both'),
  })],
  ['GET', /^\/api\/cache\/trends$/, (_m, q) => buckets(REQUESTS, q.bucket === 'day' ? 'day' : 'hour')],
  ['GET', /^\/api\/costs\/summary$/, () => ({
    totals: {
      totalNanoUsd: sumCost(REQUESTS),
      uncachedInputNanoUsd: sumCost(REQUESTS, 'uncachedInputNanoUsd'),
      cacheReadNanoUsd: sumCost(REQUESTS, 'cacheReadNanoUsd'),
      cacheWriteNanoUsd: sumCost(REQUESTS, 'cacheWriteNanoUsd'),
      outputNanoUsd: sumCost(REQUESTS, 'outputNanoUsd'),
      actualSavingsNanoUsd: savings(REQUESTS),
      unpricedRequests: REQUESTS.filter((r) => r.unpriced).length,
    },
    byProvider: byProvider(REQUESTS).map(({ provider, rs }) => ({ provider, totalNanoUsd: sumCost(rs), requests: rs.length })),
    byModel: byModel(REQUESTS),
    bySession: SESSIONS.map(sessionSummary),
    topRequests: [...REQUESTS].filter((r) => !r.unpriced).sort((a, b) => b.totalCost - a.totalCost).slice(0, 10).map(summary),
    pricing: PRICING,
    disclaimer: DISCLAIMER,
  })],
  ['GET', /^\/api\/costs\/trends$/, (_m, q) => buckets(REQUESTS, q.bucket === 'day' ? 'day' : 'hour')],
  ['GET', /^\/api\/optimizations$/, (_m, q) => FINDINGS.filter((f) => (!q.severity || f.severity === q.severity) && (!q.type || f.type === q.type))],
  ['GET', /^\/api\/compare$/, (_m, q) => {
    const a = REQUESTS.find((r) => r.id === q.a);
    const b = REQUESTS.find((r) => r.id === q.b);
    if (!a || !b) return notFound();
    const n = Math.max(a.segments.length, b.segments.length);
    const alignment = Array.from({ length: n }, (_, i) => {
      const sa = a.segments[i];
      const sb = b.segments[i];
      if (!sa) return { status: 'added', aIndex: null, bIndex: i };
      if (!sb) return { status: 'removed', aIndex: i, bIndex: null };
      return { status: sa.exactFingerprint === sb.exactFingerprint ? 'same' : 'changed', aIndex: i, bIndex: i };
    });
    const first = alignment.findIndex((x) => x.status !== 'same');
    const seg = first >= 0 ? (b.segments[first] ?? a.segments[first]) : null;
    return {
      a: detail(a),
      b: detail(b),
      segmentsA: a.segments,
      segmentsB: b.segments,
      alignment,
      firstCacheRelevantDifference: {
        segmentIndex: first >= 0 ? first : null,
        kind: seg?.kind ?? null,
        label: seg?.label ?? null,
        explanation:
          first >= 0
            ? `Segments 0–${first - 1} are byte-identical; segment ${first} (${seg.label}) differs, so a provider prefix cache cannot be reused past it. This is structural evidence, not proof of a provider cache miss.`
            : 'Both requests are structurally identical.',
      },
      contentAvailable: hasContent(a) && hasContent(b),
    };
  }],
  ['GET', /^\/api\/providers$/, () => [
    { id: 'openai', protocol: 'openai', upstream: 'https://api.openai.com', routePrefix: '/openai', endpoints: ['/v1/chat/completions', '/v1/responses'], custom: false },
    { id: 'anthropic', protocol: 'anthropic', upstream: 'https://api.anthropic.com', routePrefix: '/anthropic', endpoints: ['/v1/messages'], custom: false },
    { id: 'gemini', protocol: 'gemini', upstream: 'https://generativelanguage.googleapis.com', routePrefix: '/gemini', endpoints: ['/v1beta/models/{model}:generateContent'], custom: false },
    { id: 'openrouter', protocol: 'openai', upstream: 'https://openrouter.ai/api', routePrefix: '/openrouter', endpoints: ['/v1/chat/completions'], custom: true },
  ]],
  ['GET', /^\/api\/settings$/, () => settings],
  ['PUT', /^\/api\/settings$/, (_m, _q, body, req) => {
    if (req.headers['x-contextscope-csrf'] !== '1') return { status: 403, body: { error: { code: 'csrf', message: 'Missing CSRF header' } } };
    if (body.captureMode && !['metadata', 'deep_memory', 'deep_persistent'].includes(body.captureMode))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'captureMode must be metadata, deep_memory or deep_persistent' } } };
    if (body.pricingOverrides && !body.pricingOverrides.every((o) => o && typeof o.model === 'string'))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'pricingOverrides[0].model: required string' } } };
    Object.assign(settings, Object.fromEntries(Object.entries(body).filter(([k]) => k in settings)));
    return settings;
  }],
];

const settings = {
  captureMode: 'metadata',
  contentRetentionHours: 24,
  metadataRetentionDays: 30,
  pricingOverrides: [],
  pricingVersion: PRICING.version,
  host: '127.0.0.1',
  port: 3377,
  demo: true,
  stats: { droppedEvents: 0, queueDepth: 2, dbBytes: 18_874_368, storedRequests: REQUESTS.length },
};

const notFound = () => ({ status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
const withReq = (id, fn) => {
  const r = REQUESTS.find((x) => x.id === decodeURIComponent(id));
  return r ? fn(r) : notFound();
};

// ---------- SSE ----------
const clients = new Set();
let liveIdx = 1000;
setInterval(() => {
  const r = makeRequest(liveIdx++, Date.now());
  REQUESTS.unshift(r);
  const send = (type, data) => clients.forEach((res) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  send('request.started', { type: 'request.started', id: r.id, provider: r.provider, model: r.model, at: r.startedAt });
  send('request.completed', { type: 'request.completed', request: summary(r) });
  send('stats', { type: 'stats', queueDepth: int(0, 4), dropped: 0 });
}, 2000);
setInterval(() => {
  clients.forEach((res) => res.write(`event: heartbeat\ndata: ${JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() })}\n\n`));
}, 5000);

// ---------- server ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!route) return json(404, { error: { code: 'not_found', message: `No route ${req.method} ${url.pathname}` } });
  const q = Object.fromEntries(url.searchParams);
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(400, { error: { code: 'invalid_json', message: 'Body is not JSON' } });
    }
    const out = route[2](url.pathname.match(route[1]), q, body, req);
    if (out && typeof out === 'object' && 'status' in out && 'body' in out) return json(out.status, out.body);
    json(200, out);
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock API on http://127.0.0.1:${PORT} (${REQUESTS.length} requests)`));
