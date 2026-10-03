// Text backend: any server with the OpenAI Chat Completions API (/v1/chat/completions):
// llama.cpp, vLLM, Ollama, LM Studio, LocalAI, OpenRouter, LiteLLM, OpenAI, ...
// The API has no server-side conversations, so a conversation's messages are kept on disk
// (convoDir/<id>.json) and sent with every request; `convo` is "oc:<id>".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const type = 'openai-chat';

export const meta = {
  label: 'OpenAI-compatible chat API', kind: 'text',
  help: 'Any /v1/chat/completions server: llama.cpp, vLLM, Ollama, LM Studio, OpenRouter, OpenAI…',
  fields: [
    { key: 'baseUrl', label: 'Base URL', kind: 'text', default: 'http://localhost:8000/v1', hint: 'Up to and including /v1' },
    { key: 'model', label: 'Model', kind: 'text', hint: 'As the server names it (GET /v1/models)' },
    { key: 'apiKey', label: 'API key', kind: 'secret', hint: 'Leave empty for servers without one' },
    { key: 'json', label: 'JSON mode', kind: 'select', options: ['on', 'off'], default: 'on', hint: 'Asks the server for valid JSON (response_format)' },
    { key: 'thinking', label: 'Thinking', kind: 'select', options: ['off', 'on', 'server default'], default: 'off', hint: 'For reasoning models (Qwen 3 etc.): off is much faster' },
    { key: 'maxTokens', label: 'Max reply tokens', kind: 'number', default: 16000 },
    { key: 'timeout', label: 'Timeout (seconds)', kind: 'number', default: 600 },
  ],
};

// settings: as in meta, plus convoDir (where conversations are stored).
export function create({ baseUrl = 'http://localhost:8000/v1', model, apiKey, json = 'on', thinking = 'off', maxTokens = 16000, timeout = 600, convoDir }) {
  if (!model) throw new Error('openai-chat needs a model name');
  fs.mkdirSync(convoDir, { recursive: true });
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const file = convo => path.join(convoDir, `${String(convo).replace(/^oc:/, '').replace(/[^a-z0-9-]/gi, '')}.json`);
  const readConvo = convo => {
    try { return JSON.parse(fs.readFileSync(file(convo), 'utf8')); }
    catch { throw Object.assign(new Error('Conversation not found for this backend'), { status: 410 }); }
  };
  const saveConvo = (messages, convo = `oc:${crypto.randomUUID()}`) => {
    fs.writeFileSync(file(convo), JSON.stringify(messages));
    return convo;
  };

  async function chat(system, messages) {
    const body = {
      model, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
      ...(json === 'on' ? { response_format: { type: 'json_object' } } : {}),
      // Qwen 3-style templates read enable_thinking; servers that don't know it ignore it.
      ...(thinking !== 'server default' ? { chat_template_kwargs: { enable_thinking: thinking === 'on' } } : {}),
    };
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout * 1000),
      });
    } catch (e) {
      throw Object.assign(new Error(`Can't reach ${new URL(url).host}: ${e.cause?.code || e.message}`), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || data?.message || `${res.status} from ${new URL(url).host}`), { status: res.status });
    const msg = data.choices?.[0]?.message || {};
    // Some servers inline the model's reasoning as <think>…</think>; keep only the answer.
    return String(msg.content || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  }

  return {
    type,
    capabilities: { conversations: true, json: json === 'on' },
    describe: () => `${model} @ ${new URL(url).host}`,
    async start({ system, prompt }) {
      const messages = [{ role: 'user', content: prompt }];
      const text = await chat(system, messages);
      return { convo: saveConvo([...messages, { role: 'assistant', content: text }]), text };
    },
    async continue({ convo, system, prompt }) {
      const messages = [...readConvo(convo), { role: 'user', content: prompt }];
      const text = await chat(system, messages);
      saveConvo([...messages, { role: 'assistant', content: text }], convo);
      return { convo, text };
    },
    async fork({ convo, system, prompt }) {
      const messages = [...readConvo(convo), { role: 'user', content: prompt }];
      const text = await chat(system, messages);
      return { convo: saveConvo([...messages, { role: 'assistant', content: text }]), text };
    },
    once: ({ system, prompt }) => chat(system, [{ role: 'user', content: prompt }]),
  };
}
