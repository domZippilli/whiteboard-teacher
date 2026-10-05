// Text backend: the `claude` CLI (Claude Code in print mode). No API key: it uses the account the CLI
// is signed in with. A conversation is a Claude Code session; `convo` is its session id.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

export const type = 'claude-cli';

// Shown in Admin › Backends.
export const meta = {
  label: 'Claude Code CLI (claude -p)', kind: 'text',
  help: 'Uses the Claude account the claude CLI is signed in with. No key needed.',
  fields: [
    { key: 'model', label: 'Model', kind: 'text', default: 'opus', hint: 'opus, sonnet, haiku, or a full model id' },
    { key: 'research', label: 'Research before planning', kind: 'select', options: ['search', 'search+read', 'off'], default: 'search',
      hint: 'Web search while planning a lesson, when the topic needs it. "read" also opens pages (slower; more web text reaches the writer)' },
  ],
};

// Tools for a research step, by setting. Everything else always runs with no tools at all.
const RESEARCH_TOOLS = { search: 'WebSearch', 'search+read': 'WebSearch,WebFetch' };

// settings: { model, cwd, research }. cwd should be outside any repo so sessions don't load its CLAUDE.md.
export function create({ model = 'opus', cwd, research = 'search' }) {
  fs.mkdirSync(cwd, { recursive: true });

  // tools: '' (none) or a comma list, which are then allowed without asking (print mode can't ask).
  const run = (args, tools = '') => new Promise((resolve, reject) => {
    const toolArgs = tools ? ['--tools', tools, '--allowedTools', tools] : ['--tools', ''];
    const p = spawn('claude', ['-p', '--output-format', 'json', ...toolArgs, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => {
      try {
        const r = JSON.parse(out);
        if (r.is_error) return reject(new Error(r.result || 'claude error'));
        const searches = r.usage?.server_tool_use?.web_search_requests || 0;
        resolve({ convo: r.session_id, text: r.result || '', turns: r.num_turns, ...(tools ? { researched: r.num_turns > 1 || searches > 0 } : {}) });
      } catch {
        reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 500)}`));
      }
    });
  });
  const base = (system, m) => ['--model', m || model, '--system-prompt', system];

  return {
    type,
    capabilities: { conversations: true, json: false, research: !!RESEARCH_TOOLS[research] },
    describe: () => `claude -p --model ${model}${RESEARCH_TOOLS[research] ? ` (+${research})` : ''}`,
    // `name` labels the session in Claude Code's /resume list. `model` overrides per call.
    // `research`: this turn may use the web tools (planning a lesson).
    start: ({ system, prompt, name, model: m, research: r }) =>
      run([...base(system, m), '--session-id', crypto.randomUUID(), ...(name ? ['-n', name] : []), prompt], r ? RESEARCH_TOOLS[research] : ''),
    continue: ({ convo, system, prompt, model: m }) => run([...base(system, m), '--resume', convo, prompt]),
    fork: ({ convo, system, prompt, model: m }) => run([...base(system, m), '--resume', convo, '--fork-session', prompt]),
    once: async ({ system, prompt, model: m }) => (await run([...base(system, m), '--no-session-persistence', prompt])).text,
  };
}
