// Visual/DOM check of the built dashboard. Starts nothing itself: expects
// `vite preview --port 4173` (proxying /api) and scripts/dev-mock-server.mjs to be running.
// Usage: node scripts/check.mjs [baseUrl]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(path.join(process.env.NODE_PATH ?? '/usr/lib/node_modules', 'playwright'));
}
const { chromium } = playwright;

const BASE = process.argv[2] ?? 'http://127.0.0.1:4173';
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../shots');
mkdirSync(SHOTS, { recursive: true });

const getJson = async (p) => {
  const res = await fetch(`${BASE}${p}`);
  if (!res.ok) throw new Error(`${p} → ${res.status}`);
  return res.json();
};

const list = await getJson('/api/requests?pageSize=5');
const sessions = await getJson('/api/sessions?pageSize=5');
const ids = list.items.map((r) => r.id);
if (ids.length < 2) throw new Error('mock server returned fewer than 2 requests');

const ROUTES = [
  ['overview', '/'],
  ['requests', '/requests'],
  ['request', `/requests/${ids[0]}`],
  ['sessions', '/sessions'],
  ['session', `/sessions/${encodeURIComponent(sessions.items[0].id)}`],
  ['context', '/context'],
  ['cache', '/cache'],
  ['costs', '/costs'],
  ['optimizations', '/optimizations'],
  ['compare', `/compare?a=${ids[1]}&b=${ids[0]}`],
  ['settings', '/settings'],
];
const WIDTHS = [
  [1440, 900],
  [390, 844],
];
const THEMES = ['dark', 'light'];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
const problems = [];
const rows = [];

for (const theme of THEMES) {
  for (const [w, h] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
    await ctx.addInitScript((t) => localStorage.setItem('cs.theme', t), theme);
    for (const [name, route] of ROUTES) {
      const page = await ctx.newPage();
      const errs = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errs.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
      page.on('requestfailed', (r) => {
        // EventSource is torn down when the page closes; that abort is expected.
        if (r.url().includes('/api/events')) return;
        errs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`);
      });
      page.on('response', (r) => {
        if (r.status() >= 400 && !r.url().endsWith('/content')) errs.push(`http ${r.status()}: ${r.url()}`);
      });
      await page.goto(`${BASE}${route}`, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
      await page.waitForTimeout(700);
      const info = await page.evaluate(() => {
        const sw = document.documentElement.scrollWidth;
        const iw = window.innerWidth;
        const charts = document.querySelectorAll('.recharts-surface').length;
        const emptyCharts = [...document.querySelectorAll('.recharts-wrapper')].filter(
          (w) => !w.querySelector('path, rect.recharts-rectangle, .recharts-bar-rectangle'),
        ).length;
        const skeletons = document.querySelectorAll('[data-skeleton], .animate-pulse').length;
        const errorStates = [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent?.slice(0, 120));
        // Elements wider than the viewport (to locate overflow culprits).
        const wide = [];
        if (sw > iw + 1) {
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.right > iw + 1 && getComputedStyle(el).position !== 'fixed') {
              let p = el.parentElement;
              let clipped = false;
              while (p) {
                const ox = getComputedStyle(p).overflowX;
                if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') {
                  clipped = true;
                  break;
                }
                p = p.parentElement;
              }
              if (!clipped) wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} → ${Math.round(r.right)}`);
            }
            if (wide.length > 5) break;
          }
        }
        const empties = [...document.querySelectorAll('main p, main td, main div')]
          .filter((e) => e.children.length === 0 && /^No (data|requests|findings|sessions|segments)\b/.test(e.textContent ?? ''))
          .map((e) => e.textContent?.slice(0, 60));
        return { sw, iw, charts, emptyCharts, skeletons, errorStates, wide, empties, theme: document.documentElement.className };
      });
      const file = path.join(SHOTS, `${name}-${w}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const issues = [...errs];
      if (info.sw > info.iw + 1) issues.push(`overflow: scrollWidth ${info.sw} > ${info.iw} ${info.wide.join(' | ')}`);
      if (info.emptyCharts) issues.push(`${info.emptyCharts} empty chart(s)`);
      if (info.errorStates.length) issues.push(`alert: ${info.errorStates.join(' / ')}`);
      if (!info.theme.includes(theme)) issues.push(`theme class is "${info.theme}"`);
      rows.push({ route: name, w, theme, charts: info.charts, skeletons: info.skeletons, empty: info.empties.join(' | ').slice(0, 50), issues: issues.length });
      if (issues.length) problems.push({ route: name, w, theme, issues });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();

console.log(`\nChecked ${ROUTES.length} pages × ${WIDTHS.length} widths × ${THEMES.length} themes = ${rows.length} views`);
console.table(rows);
if (problems.length) {
  console.log('\nPROBLEMS:');
  for (const p of problems) {
    console.log(`- ${p.route} @${p.w} ${p.theme}`);
    for (const i of p.issues) console.log(`    ${i}`);
  }
  console.log(`\nScreenshots: ${SHOTS}`);
  process.exit(1);
}
console.log(`\nAll clean. Screenshots: ${SHOTS}`);
