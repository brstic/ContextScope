// npm install openai && OPENAI_API_KEY=sk-... node index.mjs
// See ../README.md. baseURL includes /v1: the SDK appends /chat/completions, /responses, ...
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.CONTEXTSCOPE_OPENAI_URL ?? 'http://127.0.0.1:3377/openai/v1',
  // Optional: group requests into a session in the dashboard (stripped before forwarding).
  defaultHeaders: { 'x-contextscope-session': 'example-openai-node' },
});

const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

const chat = await client.chat.completions.create({
  model,
  messages: [
    { role: 'system', content: 'You are a concise assistant.' },
    { role: 'user', content: 'Name one benefit of prompt caching.' },
  ],
});
console.log('chat:', chat.choices[0]?.message.content);

const response = await client.responses.create({ model, input: 'Say hello in five words.' });
console.log('responses:', response.output_text);

// Streamed chat reports usage only when the client asks for it.
const stream = await client.chat.completions.create({
  model,
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
});
process.stdout.write('stream: ');
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
process.stdout.write('\n');
