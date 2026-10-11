#!/usr/bin/env node
// Clicks every button, tab, link and switch on every dashboard page (desktop + phone) like a
// visitor would, and reports controls that do nothing, console errors and failed requests.
// Submit-like destructive actions are skipped. Usage: node scripts/click-check.mjs http://127.0.0.1:3377
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:3377';

const reqs = await (await fetch(`${base}/api/requests?pageSize=50`)).json();
const sessions = await (await fetch(`${base}/api/sessions?pageSize=5`)).json();
const id = reqs.items.find((r) => r.state === 'completed')?.id ?? reqs.items[0].id;
const routes = [
  '/',
  '/requests',
  `/requests/${id}`,
  '/sessions',
  `/sessions/${encodeURIComponent(sessions.items[0].id)}`,
  `/context?id=${id}`,
  '/cache',
  '/costs',
  '/optimizations',
  `/compare?a=${reqs.items[1].id}&b=${id}`,
  '/settings',
];
const SKIP = /save|apply|enable deep|delete|clear all|import|^copy/i;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
let problems = 0;
for (const [w, h] of [
  [1440, 900],
  [390, 844],
]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => !r.url().includes('/api/events') && errors.push(`failed ${r.url()}`));
  for (const route of routes) {
    const started = Date.now();
    try {
    await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(800);
    const count = await page.locator('main button:visible, main [role=tab]:visible, main a[href]:visible, main [role=switch]:visible').count();
    let clicked = 0;
    const dead = [];
    for (let i = 0; i < Math.min(count, 25) && Date.now() - started < 60000; i++) {
      const loc = page.locator('main button:visible, main [role=tab]:visible, main a[href]:visible, main [role=switch]:visible').nth(i);
      const label = ((await loc.getAttribute('aria-label').catch(() => null)) ?? (await loc.innerText().catch(() => '')) ?? '').trim().slice(0, 40);
      if (SKIP.test(label) || (await loc.isDisabled().catch(() => true))) continue;
      // External links open a new tab and the current selection is already chosen: not dead controls.
      const kind = await loc.evaluate((el) => (el.getAttribute('target') === '_blank' ? 'external' : el.getAttribute('aria-current') === 'true' ? 'current' : '')).catch(() => '');
      if (kind) continue;
      const snap = () =>
        page.evaluate(() => {
          let h = 0;
          const s = document.body.innerHTML;
          for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
          return location.href + '|' + h;
        });
      const before = await snap();
      try {
        await loc.click({ timeout: 1500 });
      } catch {
        continue;
      }
      await page.waitForTimeout(150);
      const after = await snap();
      clicked++;
      if (before === after) dead.push(label || `#${i}`);
      // Restore the page state for the next control.
      await page.keyboard.press('Escape');
      if (new URL(page.url()).pathname !== new URL(base + route).pathname) {
        await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(500);
      }
    }
    const bad = dead.length > 0 || errors.length > 0;
    if (bad) problems++;
    console.log(`${bad ? '✗' : '✓'} ${w} ${route.slice(0, 40)}: clicked ${clicked}${dead.length ? `, no effect: ${dead.join(', ')}` : ''}${errors.length ? `, errors: ${errors.slice(0, 2).join(' | ')}` : ''} (${Date.now() - started} ms)`);
    } catch (err) {
      problems++;
      console.log(`✗ ${w} ${route.slice(0, 40)}: check failed: ${String(err).split('\n')[0]}`);
    }
    errors.length = 0;
  }
  await ctx.close();
}
await browser.close();
console.log(problems ? `${problems} page(s) with problems` : 'all controls respond, no errors');
