import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { traceFileSchema } from '@contextscope/shared';

describe('examples/traces/sample-trace.json', () => {
  it('is a valid contextscope.trace v1 file with one trace per provider', () => {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../../../examples/traces/sample-trace.json', import.meta.url), 'utf8'),
    );
    const file = traceFileSchema.parse(raw);
    expect(file.traces).toHaveLength(3);
    expect(file.traces.map((t) => t.provider).sort()).toEqual(['anthropic', 'gemini', 'openai']);
  });
});
