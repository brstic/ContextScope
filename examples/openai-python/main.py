"""pip install openai && OPENAI_API_KEY=sk-... python main.py"""
import os

from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("CONTEXTSCOPE_OPENAI_URL", "http://127.0.0.1:3377/openai/v1"),
    default_headers={"x-contextscope-session": "example-openai-python"},
)
model = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")

chat = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "Name one benefit of prompt caching."}],
)
print("chat:", chat.choices[0].message.content)

response = client.responses.create(model=model, input="Say hello in five words.")
print("responses:", response.output_text)

stream = client.chat.completions.create(
    model=model,
    stream=True,
    stream_options={"include_usage": True},
    messages=[{"role": "user", "content": "Count from 1 to 5."}],
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
