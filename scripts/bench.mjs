#!/usr/bin/env node
// Proxy overhead benchmark. Run with: pnpm build && pnpm bench
// Starts a deterministic local mock upstream and ContextScope (built server package, in its own child
// process so it doesn't share a CPU core with the load generator) pointed at it, then measures direct vs
// proxied latency (sequential, fixed rate, saturated), SSE throughput and the proxy's RSS/CPU.
// Nothing leaves this machine.
import { createServer, request as httpRequest, Agent } from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 2000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 20);
const RATE = Number(process.env.BENCH_RATE ?? 100); // req/s for the fixed-rate run
const SSE_CHUNKS = Number(process.env.BENCH_SSE_CHUNKS ?? 2000);

// --- child: the ContextScope server --------------------------------------------------------
if (process.argv[2] === '--child') {
  const [, , , upstreamUrl, dir] = process.argv;
  const { startServer } = await import('../apps/server/dist/index.js');
  const { configSchema } = await import('../packages/shared/dist/index.js');
  const cfg = configSchema.parse({
    port: 0,
    dataDir: dir,
    dbPath: join(dir, 'bench.db'),
    logLevel: 'silent',
    upstreams: { openai: upstreamUrl },
  });
  const rss0 = process.memoryUsage().rss;
  const cs = await startServer(cfg, { quiet: true });
  process.send({ port: cs.port, rss: rss0 });
  process.on('message', async (m) => {
    if (m === 'stats') process.send({ rss: process.memoryUsage().rss, cpu: process.cpuUsage() });
    if (m === 'close') {
      await cs.close();
      process.exit(0);
    }
  });
  await new Promise(() => {});
}

const CHAT_RESPONSE = JSON.stringify({
  id: 'chatcmpl-bench',
  object: 'chat.completion',
  created: 1790000000,
  model: 'gpt-4.1-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 1,
    total_tokens: 21,
    prompt_tokens_details: { cached_tokens: 0 },
  },
});
const chunk = (i) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: `token${i} ` } }] })}\n\n`;

const upstream = createServer((req, res) => {
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const parsed = JSON.parse(Buffer.concat(body).toString() || '{}');
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < SSE_CHUNKS; i++) res.write(chunk(i));
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(CHAT_RESPONSE);
    }
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

const dataDir = mkdtempSync(join(tmpdir(), 'contextscope-bench-'));
const child = fork(fileURLToPath(import.meta.url), ['--child', upstreamOrigin, dataDir], { stdio: 'inherit' });
const nextMessage = () =>
  new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`server exited (${code}); run \`pnpm build\` first`)));
  });
const ready = await nextMessage().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
const rssBefore = ready.rss;
const stats = async () => {
  const p = nextMessage();
  child.send('stats');
  return p;
};
const proxyBase = `http://127.0.0.1:${ready.port}/openai`;
const agent = new Agent({ keepAlive: true, maxSockets: CONCURRENCY });
const payload = JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'ping' }] });

const post = (url, body) =>
  new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = httpRequest(
      url,
      {
        method: 'POST',
        agent,
        headers: { 'content-type': 'application/json', authorization: 'Bearer bench' },
      },
      (res) => {
        let bytes = 0;
        res.on('data', (c) => (bytes += c.length));
        res.on('end', () =>
          resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes, status: res.statusCode }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });

const run = async (base) => {
  const times = [];
  let next = 0;
  const worker = async () => {
    while (next < REQUESTS) {
      next++;
      const r = await post(`${base}/v1/chat/completions`, payload);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      times.push(r.ms);
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wall = performance.now() - t0;
  times.sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
  return { p50: pct(50), p95: pct(95), rps: (times.length / wall) * 1000 };
};

const stat = (times) => {
  times.sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
  return { p50: pct(50), p95: pct(95), p99: pct(99) };
};

/** One request at a time: pure per-request overhead. */
const sequential = async (base, n = 500) => {
  const times = [];
  for (let i = 0; i < n; i++) times.push((await post(`${base}/v1/chat/completions`, payload)).ms);
  return stat(times);
};

/** Open loop at a fixed arrival rate (like real traffic): latency is not inflated by queueing in the client. */
const fixedRate = async (base, rate = RATE, seconds = 5) => {
  const n = rate * seconds;
  const gap = 1000 / rate;
  const t0 = performance.now();
  const all = [];
  for (let i = 0; i < n; i++) {
    const due = t0 + i * gap;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    all.push(post(`${base}/v1/chat/completions`, payload).then((r) => r.ms));
  }
  return stat(await Promise.all(all));
};

const sse = async (base) => {
  const r = await post(
    `${base}/v1/chat/completions`,
    JSON.stringify({ model: 'gpt-4.1-mini', stream: true, messages: [] }),
  );
  return { ms: r.ms, mbps: r.bytes / 1024 / 1024 / (r.ms / 1000) };
};

await run(upstreamOrigin); // warm-up
await sequential(proxyBase, 200); // warm-up (JIT, prepared statements)
const seqDirect = await sequential(upstreamOrigin);
const seqProxied = await sequential(proxyBase);
const rateDirect = await fixedRate(upstreamOrigin);
const rateProxied = await fixedRate(proxyBase);
const cpu0 = (await stats()).cpu;
const direct = await run(upstreamOrigin);
const proxied = await run(proxyBase);
await new Promise((r) => setTimeout(r, 500)); // let the persistence queue drain
const cpu1 = (await stats()).cpu;
const cpuPerReqMs = (cpu1.user + cpu1.system - cpu0.user - cpu0.system) / 1000 / REQUESTS;
const sseDirect = await sse(upstreamOrigin);
const sseProxied = await sse(proxyBase);
const rssAfter = (await stats()).rss;

const f = (n) => n.toFixed(2);
console.log(`\n### ContextScope proxy benchmark\n`);
console.log(
  `Sequential: 500 requests; fixed rate: ${RATE} req/s for 5 s; saturated: ${REQUESTS} requests, concurrency ${CONCURRENCY}; SSE: ${SSE_CHUNKS} chunks; Node ${process.version}\n`,
);
console.log('| Metric | Direct | Via ContextScope | Overhead |');
console.log('|---|---:|---:|---:|');
const row = (name, d, p) => console.log(`| ${name} | ${f(d)} | ${f(p)} | ${f(p - d)} |`);
row('Sequential p50 (ms)', seqDirect.p50, seqProxied.p50);
row('Sequential p95 (ms)', seqDirect.p95, seqProxied.p95);
row(`${RATE} req/s p50 (ms)`, rateDirect.p50, rateProxied.p50);
row(`${RATE} req/s p95 (ms)`, rateDirect.p95, rateProxied.p95);
row(`${RATE} req/s p99 (ms)`, rateDirect.p99, rateProxied.p99);
row(`Saturated (c=${CONCURRENCY}) p50 (ms)`, direct.p50, proxied.p50);
row(`Saturated (c=${CONCURRENCY}) p95 (ms)`, direct.p95, proxied.p95);
console.log(
  `| Throughput (req/s) | ${f(direct.rps)} | ${f(proxied.rps)} | ${f(((direct.rps - proxied.rps) / direct.rps) * 100)} % |`,
);
console.log(
  `| SSE stream (ms) | ${f(sseDirect.ms)} | ${f(sseProxied.ms)} | ${f(sseProxied.ms - sseDirect.ms)} |`,
);
console.log(`| SSE throughput (MiB/s) | ${f(sseDirect.mbps)} | ${f(sseProxied.mbps)} | |`);
console.log(`| Proxy CPU per request incl. analysis (ms) | | ${f(cpuPerReqMs)} | |`);
console.log(
  `| Proxy RSS (MiB) start / end | ${f(rssBefore / 1048576)} | ${f(rssAfter / 1048576)} | ${f((rssAfter - rssBefore) / 1048576)} |`,
);
console.log(
  '\nThe proxy runs in its own process; the mock upstream and the load generator share another. Saturated' +
    ' latency is concurrency ÷ throughput (a closed loop at full CPU), not per-request overhead.',
);

agent.destroy();
const closed = new Promise((r) => child.once('exit', r));
child.send('close');
await closed;
upstream.close();
rmSync(dataDir, { recursive: true, force: true });
