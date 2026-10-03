// Text backend: the `claude` CLI (Claude Code in print mode). No API key: it uses the account the CLI
// is signed in with. A conversation is a Claude Code session; `convo` is its session id.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

export const type = 'claude-cli';

// settings: { model, cwd }. cwd should be outside any repo so sessions don't load its CLAUDE.md.
export function create({ model = 'opus', cwd }) {
  fs.mkdirSync(cwd, { recursive: true });

  const run = args => new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--output-format', 'json', '--tools', '', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => {
      try {
        const r = JSON.parse(out);
        if (r.is_error) return reject(new Error(r.result || 'claude error'));
        resolve({ convo: r.session_id, text: r.result || '' });
      } catch {
        reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 500)}`));
      }
    });
  });
  const base = (system, m) => ['--model', m || model, '--system-prompt', system];

  return {
    type,
    capabilities: { conversations: true, json: false },
    describe: () => `claude -p --model ${model}`,
    // `name` labels the session in Claude Code's /resume list. `model` overrides per call.
    start: ({ system, prompt, name, model: m }) =>
      run([...base(system, m), '--session-id', crypto.randomUUID(), ...(name ? ['-n', name] : []), prompt]),
    continue: ({ convo, system, prompt, model: m }) => run([...base(system, m), '--resume', convo, prompt]),
    fork: ({ convo, system, prompt, model: m }) => run([...base(system, m), '--resume', convo, '--fork-session', prompt]),
    once: async ({ system, prompt, model: m }) => (await run([...base(system, m), '--no-session-persistence', prompt])).text,
  };
}
