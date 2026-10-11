import type { ContextScopeConfig } from '@contextscope/shared';
import { baseUrl } from './pid.js';

/** Where the CLI writes; injectable for tests. */
export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export const defaultIO = (): CliIO => ({
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  env: process.env,
  cwd: process.cwd(),
});

const color = (code: number) => (s: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${s}\u001b[0m` : s;
export const bold = color(1);
export const dim = color(2);
export const green = color(32);
export const red = color(31);
export const yellow = color(33);

export interface BannerInput {
  version: string;
  host: string;
  port: number;
  config: ContextScopeConfig;
  configFile: string | null;
}

/** Startup banner: dashboard URL, proxy base URLs and SDK snippets. */
export const banner = ({ version, host, port, config, configFile }: BannerInput): string => {
  const base = baseUrl(host, port);
  const openai = `${base}/openai/v1`;
  const anthropic = `${base}/anthropic`;
  const gemini = `${base}/gemini`;
  const lines: string[] = [];
  lines.push('');
  lines.push(`${bold(`ContextScope ${version}`)}${config.demo ? `  ${yellow('[DEMO MODE: synthetic data only]')}` : ''}`);
  lines.push('');
  lines.push(`  Dashboard   ${bold(`${base}/`)}`);
  lines.push(`  Proxy       OpenAI     ${openai}`);
  lines.push(`              Anthropic  ${anthropic}`);
  lines.push(`              Gemini     ${gemini}`);
  for (const p of config.customProviders) lines.push(`              ${p.name.padEnd(10)} ${base}/${p.name}/v1  ${dim(`(custom, ${p.upstream})`)}`);
  lines.push('');
  lines.push(`  Capture     ${config.capture.mode}${config.capture.mode === 'metadata' ? dim(' (no prompt/response text stored)') : yellow(' (deep capture: content is kept)')}`);
  lines.push(`  Data dir    ${config.dataDir}`);
  lines.push(`  Database    ${config.dbPath}`);
  if (configFile) lines.push(`  Config      ${configFile}`);
  if (config.authToken) lines.push(`  Auth        bearer token required for /api (dashboard asks for it)`);
  if (config.demo) {
    lines.push('');
    lines.push(yellow('  Demo mode: the dashboard shows deterministic synthetic traces. Nothing here is real traffic,'));
    lines.push(yellow('  and demo data is kept in its own data dir, apart from real data.'));
  }
  lines.push('');
  lines.push(bold('  Point your SDK at ContextScope (your API key is passed through, never stored):'));
  lines.push(`    OpenAI JS         new OpenAI({ baseURL: '${openai}' })`);
  lines.push(`    OpenAI Python     OpenAI(base_url="${openai}")`);
  lines.push(`    Anthropic JS      new Anthropic({ baseURL: '${anthropic}' })`);
  lines.push(`    Anthropic Python  Anthropic(base_url="${anthropic}")`);
  lines.push(`    Gemini REST       POST ${gemini}/v1beta/models/gemini-2.5-flash:generateContent`);
  lines.push(`    Group requests    header x-contextscope-session: <session-id>`);
  lines.push('');
  lines.push(dim('  Press Ctrl+C to stop.'));
  lines.push('');
  return lines.join('\n');
};
