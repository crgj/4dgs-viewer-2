// Lightweight GLM (官方) client for Node/browser environments.
// Usage: set ZHIPU_API_KEY and optionally ZHIPU_API_URL and ZHIPU_MODEL in your environment.

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY || process.env.ZHIPU_API_KEY;
const ZHIPU_API_URL = process.env.ZHIPU_API_URL || 'https://api.bigmodel.cn';
const ZHIPU_MODEL = process.env.ZHIPU_MODEL || 'glm-5.1';

if (!ZHIPU_API_KEY) {
  // do not throw at import time in browser builds; callers should ensure the key is set.
}

export async function glmChat(messages: Message[], opts?: { model?: string; apiUrl?: string; apiKey?: string }) {
  const apiKey = opts?.apiKey || ZHIPU_API_KEY;
  const apiUrl = opts?.apiUrl || ZHIPU_API_URL;
  const model = opts?.model || ZHIPU_MODEL;

  if (!apiKey) throw new Error('ZHIPU_API_KEY is not set in environment nor passed to glmChat()');

  const url = `${apiUrl.replace(/\/$/, '')}/v1/chat/completions`;

  const body = {
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    // you can extend with temperature, max_tokens, streaming, etc.
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GLM request failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data;
}

export async function simpleChat(prompt: string) {
  return glmChat([{ role: 'user', content: prompt }]);
}

export default { glmChat, simpleChat };
