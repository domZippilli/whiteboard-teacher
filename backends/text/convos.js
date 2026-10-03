// Conversation storage for text APIs that have no server-side conversations (openai-chat,
// anthropic-messages): each conversation's messages live in convoDir/<id>.json, `convo` is "<prefix>:<id>".
// Gives a backend start/continue/fork on top of a stateless `chat(system, messages)`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function storedConversations({ convoDir, prefix, chat }) {
  fs.mkdirSync(convoDir, { recursive: true });
  const file = convo => path.join(convoDir, `${String(convo).replace(/^[a-z]+:/, '').replace(/[^a-z0-9-]/gi, '')}.json`);
  const read = convo => {
    try { return JSON.parse(fs.readFileSync(file(convo), 'utf8')); }
    catch { throw Object.assign(new Error('Conversation not found for this backend'), { status: 410 }); }
  };
  const save = (messages, convo = `${prefix}:${crypto.randomUUID()}`) => {
    fs.writeFileSync(file(convo), JSON.stringify(messages));
    return convo;
  };
  return {
    async start({ system, prompt }) {
      const messages = [{ role: 'user', content: prompt }];
      const text = await chat(system, messages);
      return { convo: save([...messages, { role: 'assistant', content: text }]), text };
    },
    async continue({ convo, system, prompt }) {
      const messages = [...read(convo), { role: 'user', content: prompt }];
      const text = await chat(system, messages);
      save([...messages, { role: 'assistant', content: text }], convo);
      return { convo, text };
    },
    async fork({ convo, system, prompt }) {
      const messages = [...read(convo), { role: 'user', content: prompt }];
      const text = await chat(system, messages);
      return { convo: save([...messages, { role: 'assistant', content: text }]), text };
    },
    once: ({ system, prompt }) => chat(system, [{ role: 'user', content: prompt }]),
  };
}

// fetch with a timeout; network failures become { status: 0 } errors naming the host.
export async function post(url, { headers, body, timeout }) {
  try {
    return await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (e) {
    throw Object.assign(new Error(`Can't reach ${new URL(url).host}: ${e.cause?.code || e.message}`), { status: 0 });
  }
}
