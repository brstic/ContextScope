#!/usr/bin/env node
// Remove build output: every workspace package's dist/ and stray *.tsbuildinfo files.
import { readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const removed = [];

for (const group of ['apps', 'packages']) {
  const base = join(root, group);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkg = join(base, entry.name);
    for (const name of readdirSync(pkg)) {
      if (name === 'dist' || name.endsWith('.tsbuildinfo')) {
        rmSync(join(pkg, name), { recursive: true, force: true });
        removed.push(join(group, entry.name, name));
      }
    }
  }
}
for (const name of readdirSync(root)) {
  if (name.endsWith('.tsbuildinfo')) {
    rmSync(join(root, name), { force: true });
    removed.push(name);
  }
}
console.log(removed.length ? `Removed:\n  ${removed.join('\n  ')}` : 'Nothing to clean.');
