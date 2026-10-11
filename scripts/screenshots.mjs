#!/usr/bin/env node
// Full-page screenshots of every dashboard page against a running ContextScope (demo mode),
// at desktop and phone width, dark and light. Reports console errors, failed requests and
// horizontal overflow. Usage: node scripts/screenshots.mjs http://127.0.0.1:3377 shots
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:3377';
const outDir = process.argv[3] ?? 'shots';
const themes = (process.env.THEMES ?? 'dark,light').split(',');
mkdirSync(outDir, { recursive: true });

const reqs = await (await fetch(`${base}/api/requests?pageSize=200`)).json();
const sessions = await (await fetch(`${base}/api/sessions?pageSize=50`)).json();
const withPrev = [];
for (const r of reqs.items.slice(0, 60)) {
  const d = await (await fetch(`${base}/api/requests/${r.id}`)).json();
  if (d.previousRequestId && d.segmentCount !== 0) withPrev.push(d);
  if (withPrev.length > 3) break;
}
const detail = withPrev[0] ?? reqs.items[0];
const routes = [
  ['overview', '/'],
  ['requests', '/requests'],
  ['request', `/requests/${detail.id}`],
  ['sessions', '/sessions'],
  ['session', `/sessions/${encodeURIComponent(sessions.items[0]?.id ?? '')}`],
  ['context', `/context?id=${detail.id}`],
  ['cache', '/cache'],
  ['costs', '/costs'],
  ['optimizations', '/optimizations'],
  ['compare', `/compare?a=${detail.previousRequestId ?? reqs.items[1].id}&b=${detail.id}`],
  ['settings', '/settings'],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
let problems = 0;
for (const theme of themes) {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
    await ctx.addInitScript((t) => localStorage.setItem('cs.theme', t), theme);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('requestfailed', (r) => !r.url().includes('/api/events') && errors.push(`failed ${r.url()}`));
    for (const [name, path] of routes) {
      errors.length = 0;
      await page.goto(base + path, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1800);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await page.screenshot({ path: `${outDir}/${name}-${w}-${theme}.png`, fullPage: true });
      const bad = overflow > 1 || errors.length > 0;
      if (bad) problems++;
      console.log(
        `${bad ? '✗' : '✓'} ${name} ${w} ${theme}${overflow > 1 ? ` overflow ${overflow}px` : ''}${errors.length ? ` errors: ${errors.slice(0, 3).join(' | ')}` : ''}`,
      );
    }
    await ctx.close();
  }
}
await browser.close();
console.log(problems ? `${problems} problem(s)` : 'all clean');
process.exitCode = problems ? 1 : 0;
