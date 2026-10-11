"""pip install anthropic && ANTHROPIC_API_KEY=sk-ant-... python main.py"""
import os

import anthropic

# No /v1 here: the SDK appends /v1/messages itself.
client = anthropic.Anthropic(
    base_url=os.environ.get("CONTEXTSCOPE_ANTHROPIC_URL", "http://127.0.0.1:3377/anthropic"),
    default_headers={"x-contextscope-session": "example-anthropic-python"},
)
model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")
system = [{"type": "text", "text": "You are a concise assistant. " * 200, "cache_control": {"type": "ephemeral"}}]

msg = client.messages.create(
    model=model,
    max_tokens=200,
    system=system,
    messages=[{"role": "user", "content": "Name one benefit of prompt caching."}],
)
print("message:", "".join(b.text for b in msg.content if b.type == "text"))
print("usage:", msg.usage)

with client.messages.stream(
    model=model,
    max_tokens=200,
    system=system,
    messages=[{"role": "user", "content": "Count from 1 to 5."}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
print()
