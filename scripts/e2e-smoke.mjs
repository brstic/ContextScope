#!/usr/bin/env node
// End-to-end smoke test against the BUILT packages, no credentials needed:
//  1. starts a local mock upstream that speaks OpenAI / Anthropic / Gemini (JSON + SSE)
//  2. starts ContextScope via the CLI entry (`contextscope start`) pointed at the mock upstreams
//  3. opens the dashboard live feed (/api/events) and sends real requests through the proxy
//  4. checks byte-identical bodies, normalized usage in the API and the live notifications
// Usage: pnpm build && node scripts/e2e-smoke.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);
const check = (cond, good, bad) => {
  if (cond) ok(good);
  else fail(bad);
};

const OPENAI_JSON = JSON.stringify({
  id: 'chatcmpl-e2e',
  object: 'chat.completion',
  model: 'gpt-4.1-mini-2025-04-14',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 40,
    total_tokens: 1240,
    prompt_tokens_details: { cached_tokens: 1024 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
});
const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_e2e","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[],"stop_reason":null,"usage":{"input_tokens":12,"cache_creation_input_tokens":2048,"cache_read_input_tokens":4096,"output_tokens":1}}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Здраво 👋"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');
const GEMINI_JSON = JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: {
    promptTokenCount: 3000,
    cachedContentTokenCount: 2000,
    candidatesTokenCount: 50,
    thoughtsTokenCount: 100,
    totalTokenCount: 3150,
  },
  modelVersion: 'gemini-2.5-flash',
});

const seen = [];
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_e2e_openai' });
      res.end(OPENAI_JSON);
    } else if (req.url.startsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_e2e_anthropic' });
      // Send in awkward byte-sized pieces, splitting the multi-byte characters.
      const buf = Buffer.from(ANTHROPIC_SSE);
      for (let i = 0; i < buf.length; i += 7) {
        res.write(buf.subarray(i, i + 7));
        await new Promise((r) => setTimeout(r, 2));
      }
      res.end();
    } else if (req.url.includes(':generateContent')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(GEMINI_JSON);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
    }
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;

const dataDir = mkdtempSync(join(tmpdir(), 'cs-e2e-'));
const port = 3390 + Math.floor(Math.random() * 500);
const child = spawn(
  process.execPath,
  ['packages/cli/dist/bin.js', 'start', '--port', String(port), '--data-dir', dataDir],
  {
    env: {
      ...process.env,
      CONTEXTSCOPE_OPENAI_UPSTREAM: up,
      CONTEXTSCOPE_ANTHROPIC_UPSTREAM: up,
      CONTEXTSCOPE_GEMINI_UPSTREAM: up,
      CONTEXTSCOPE_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 100));
}

try {
  const health = await (await fetch(`${base}/api/health`)).json();
  check(health.ok, `server up, version ${health.version}`, 'health not ok');

  // Live feed (dashboard SSE) opened BEFORE traffic.
  const events = [];
  const ac = new AbortController();
  const liveRes = await fetch(`${base}/api/events`, { signal: ac.signal });
  (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of liveRes.body) events.push(dec.decode(chunk));
    } catch {
      /* aborted */
    }
  })();

  // 1. OpenAI JSON
  const r1 = await fetch(`${base}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer sk-proj-E2ESECRETE2ESECRETE2ESECRET',
      'x-contextscope-session': 'e2e-session',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello' },
      ],
    }),
  });
  const b1 = await r1.text();
  check(b1 === OPENAI_JSON, 'OpenAI JSON body byte-identical', 'OpenAI body differs');
  check(
    seen[0]?.headers.authorization?.includes('E2ESECRET'),
    'authorization forwarded upstream',
    'auth not forwarded',
  );
  check(
    seen[0]?.headers['x-contextscope-session'] === undefined,
    'integration header stripped upstream',
    'session header leaked upstream',
  );

  // 2. Anthropic SSE
  const r2 = await fetch(`${base}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-E2ESECRETE2ESECRET',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 100,
      stream: true,
      system: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  });
  const b2 = Buffer.from(await r2.arrayBuffer()).toString();
  check(
    b2 === ANTHROPIC_SSE,
    'Anthropic SSE stream byte-identical (split UTF-8)',
    'Anthropic stream differs',
  );

  // 3. Gemini JSON with key in query
  const r3 = await fetch(
    `${base}/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaE2ESECRETE2ESECRETE2ESECRETxx`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    },
  );
  check((await r3.text()) === GEMINI_JSON, 'Gemini JSON body byte-identical', 'Gemini body differs');
  check(
    seen[2]?.url.includes('key=AIzaE2ESECRET'),
    'Gemini query preserved upstream',
    'Gemini query not preserved',
  );

  // Let the pipeline persist.
  let list;
  for (let i = 0; i < 50; i++) {
    list = await (await fetch(`${base}/api/requests?pageSize=10`)).json();
    if (list.total >= 3) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(list.total === 3, '3 requests recorded', `expected 3 requests, got ${list.total}`);
  const byProvider = Object.fromEntries(list.items.map((i) => [i.provider, i]));
  const oa = await (await fetch(`${base}/api/requests/${byProvider.openai.id}`)).json();
  const an = await (await fetch(`${base}/api/requests/${byProvider.anthropic.id}`)).json();
  const ge = await (await fetch(`${base}/api/requests/${byProvider.gemini.id}`)).json();
  check(
    oa.usage.totalInputTokens === 1200 &&
      oa.usage.cacheReadTokens === 1024 &&
      oa.usage.uncachedInputTokens === 176,
    'OpenAI usage normalized (1200 total / 1024 cached / 176 uncached)',
    `OpenAI usage ${JSON.stringify(oa.usage)}`,
  );
  check(oa.sessionId === 'e2e-session', 'session id captured', 'session id missing');
  check(
    an.usage.totalInputTokens === 12 + 2048 + 4096 && an.usage.outputTokens === 25 && an.usage.complete,
    'Anthropic total input includes cache creation + read (6156), output 25',
    `Anthropic usage ${JSON.stringify(an.usage)}`,
  );
  check(
    an.timing.ttftMs !== null && an.timing.ttftMs <= an.timing.durationMs,
    `Anthropic TTFT measured (${an.timing.ttftMs} ms ≤ ${an.timing.durationMs} ms)`,
    'TTFT missing',
  );
  check(
    ge.usage.outputTokens === 150 &&
      ge.usage.reasoningTokens === 100 &&
      ge.usage.cacheReadTokens === 2000 &&
      ge.usage.providerTotalTokens === 3150,
    'Gemini thoughts not double counted (output 150 = 50 + 100), cached 2000',
    `Gemini usage ${JSON.stringify(ge.usage)}`,
  );
  check(
    !ge.endpoint.includes('E2ESECRET'),
    'Gemini key redacted in stored endpoint',
    'Gemini key stored in endpoint!',
  );
  check(
    oa.cost?.totalNanoUsd > 0,
    `OpenAI cost computed (${oa.cost.totalNanoUsd} nano-USD, ${oa.cost.pricingModelKey})`,
    'no cost',
  );

  const live = events.join('');
  const completed = (live.match(/event: request\.completed/g) ?? []).length;
  check(
    completed >= 3,
    `live feed delivered ${completed} request.completed events`,
    `live feed delivered ${completed} events`,
  );
  ac.abort();

  // Secrets must not appear anywhere in API output.
  const dump = JSON.stringify([oa, an, ge]) + (await (await fetch(`${base}/api/export`)).text());
  check(!/E2ESECRET/.test(dump), 'no credential in API responses or export', 'secret found in API output');
} catch (err) {
  fail(String(err?.stack ?? err));
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  const { readFileSync, readdirSync } = await import('node:fs');
  const leaked = readdirSync(dataDir).some((f) =>
    /E2ESECRET/.test(readFileSync(join(dataDir, f)).toString('latin1')),
  );
  check(!leaked, 'no credential in SQLite files after shutdown', 'secret found in data dir files');
  upstream.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (process.exitCode) console.error(out.slice(-2000));
}
