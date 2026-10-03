// Text backend: the Anthropic Messages API (/v1/messages): Anthropic itself, or a server with an
// Anthropic-compatible endpoint. Conversations are kept on disk like openai-chat's (convos.js);
// `convo` is "am:<id>". The system prompt (persona + policy + SCRIPT_API.md) is the same on every
// call, so it is marked for prompt caching: later calls in a lesson read it from the cache.
import { storedConversations, post } from './convos.js';

export const type = 'anthropic-messages';

export const meta = {
  label: 'Anthropic API', kind: 'text',
  help: 'Claude with an API key (paid per token), or any Anthropic-compatible /v1/messages server.',
  fields: [
    { key: 'apiKey', label: 'API key', kind: 'secret', hint: 'From console.anthropic.com' },
    { key: 'model', label: 'Model', kind: 'text', default: 'claude-opus-5-5', hint: 'e.g. claude-opus-5-5, claude-sonnet-5-5, claude-haiku-4-5' },
    { key: 'baseUrl', label: 'Base URL', kind: 'text', default: 'https://api.anthropic.com', hint: 'Change only for a compatible server or proxy' },
    { key: 'maxTokens', label: 'Max reply tokens', kind: 'number', default: 16000 },
    { key: 'timeout', label: 'Timeout (seconds)', kind: 'number', default: 600 },
  ],
};

// settings: as in meta, plus convoDir (where conversations are stored).
export function create({ apiKey, model = 'claude-opus-5-5', baseUrl = 'https://api.anthropic.com', maxTokens = 16000, timeout = 600, convoDir }) {
  if (!apiKey) throw new Error('anthropic-messages needs an API key');
  const url = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/messages';

  async function chat(system, messages) {
    const body = {
      model, max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    };
    for (let attempt = 0; ; attempt++) {
      const res = await post(url, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body, timeout });
      const data = await res.json().catch(() => ({}));
      // Rate limited or overloaded: wait as asked (a few seconds at most) and try again.
      if ((res.status === 429 || res.status === 529) && attempt < 2) {
        await new Promise(r => setTimeout(r, Math.min(+res.headers.get('retry-after') || 2, 10) * 1000));
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(data?.error?.message || `${res.status} from ${new URL(url).host}`), { status: res.status });
      return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    }
  }

  return {
    type,
    capabilities: { conversations: true, json: false },
    describe: () => `${model} via ${new URL(url).host}`,
    ...storedConversations({ convoDir, prefix: 'am', chat }),
  };
}
