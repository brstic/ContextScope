// npm install @anthropic-ai/sdk && ANTHROPIC_API_KEY=sk-ant-... node index.mjs
// baseURL has NO /v1: the Anthropic SDK appends /v1/messages itself.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: process.env.CONTEXTSCOPE_ANTHROPIC_URL ?? 'http://127.0.0.1:3377/anthropic',
  defaultHeaders: { 'x-contextscope-session': 'example-anthropic-node' },
});
const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';

// A long, stable system prompt with a cache breakpoint: run twice within 5 minutes to see cache reads.
const system = [{ type: 'text', text: 'You are a concise assistant. '.repeat(200), cache_control: { type: 'ephemeral' } }];

const msg = await client.messages.create({
  model,
  max_tokens: 200,
  system,
  messages: [{ role: 'user', content: 'Name one benefit of prompt caching.' }],
});
console.log('message:', msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
console.log('usage:', msg.usage);

const stream = client.messages.stream({
  model,
  max_tokens: 200,
  system,
  messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
});
stream.on('text', (t) => process.stdout.write(t));
await stream.finalMessage();
process.stdout.write('\n');
