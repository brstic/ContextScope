#!/usr/bin/env node
// Usage: node scripts/subpath-check.mjs http://127.0.0.1:3555/app/test/  (a preview-server.mjs instance)
// Opens every dashboard route under a path prefix (direct URL and via the sidebar) and reports console errors,
// failed requests and requests that escaped the prefix.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const base = process.argv[2]; // e.g. http://127.0.0.1:3555/app/test/
const origin = new URL(base).origin;
const prefix = new URL(base).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => !r.url().includes('/api/live') && problems.push(`failed: ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.origin === origin && !u.pathname.startsWith(prefix)) problems.push(`outside prefix: ${u.pathname}`);
});

const api = async (p) => (await page.request.get(base + p)).json();
await page.goto(base, { waitUntil: 'load' });
const reqs = await api('api/requests?pageSize=1');
const sess = await api('api/sessions?pageSize=1');
const reqId = reqs.items?.[0]?.id;
const sessId = (sess.items ?? sess.sessions ?? sess)?.[0]?.id;
const routes = ['', 'requests', `requests/${reqId}`, 'sessions', `sessions/${sessId}`, 'context', 'cache', 'costs',
  'optimizations', 'compare', 'settings'];

const settle = async () => {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
};
const textOk = async () => {
  const t = await page.locator('main').innerText().catch(() => '');
  return t.length > 40 && !/page not found|404/i.test(t.slice(0, 200));
};

let bad = 0;
for (const r of routes) {
  problems = [];
  await page.goto(base + r, { waitUntil: 'load' });
  await settle();
  const ok = await textOk();
  const url = new URL(page.url()).pathname;
  const status = ok && problems.length === 0 && url.startsWith(prefix) ? '✓' : '✗';
  if (status === '✗') bad++;
  console.log(`${status} direct /${r}  (url ${url})${problems.length ? '\n    ' + problems.join('\n    ') : ''}${ok ? '' : '\n    no content'}`);
}

// navigation: click each sidebar link from the overview
await page.goto(base, { waitUntil: 'load' });
await settle();
const links = await page.locator('nav a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
for (const href of [...new Set(links)]) {
  problems = [];
  await page.locator(`nav a[href="${href}"]`).first().click();
  await settle();
  const ok = await textOk();
  const url = new URL(page.url()).pathname;
  const status = ok && problems.length === 0 && `${url}/`.startsWith(prefix) ? '✓' : '✗';
  if (status === '✗') bad++;
  console.log(`${status} nav ${href} → ${url}${problems.length ? '\n    ' + problems.join('\n    ') : ''}`);
}

// a request row → inspector, and a session row → detail
for (const [from, sel] of [['requests', 'tbody tr'], ['sessions', 'tbody a[href*="/sessions/"]']]) {
  problems = [];
  await page.goto(base + from, { waitUntil: 'load' });
  await settle();
  await page.locator(sel).first().click().catch(() => problems.push('no row to click'));
  await settle();
  const url = new URL(page.url()).pathname;
  const ok = url.startsWith(prefix + from + '/') && (await textOk());
  if (!ok || problems.length) bad++;
  console.log(`${ok && !problems.length ? '✓' : '✗'} row click on /${from} → ${url}${problems.length ? '\n    ' + problems.join('\n    ') : ''}`);
}
await browser.close();
console.log(bad ? `${bad} problem(s)` : 'all routes OK under ' + prefix);
process.exit(bad ? 1 : 0);
