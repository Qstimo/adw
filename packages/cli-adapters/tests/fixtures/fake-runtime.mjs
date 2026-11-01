import { writeSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const out = value => writeSync(1, value);
const send = value => out(JSON.stringify(value) + '\n');
async function slowProbe() {
  if (process.env.FAKE_PROBE_PID_PATH) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fake-child.mjs', import.meta.url))], { stdio: 'ignore' });
    writeFileSync(process.env.FAKE_PROBE_PID_PATH, String(child.pid));
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
}
export async function main(id) {
  const args = process.argv.slice(2);
  const version = process.env.FAKE_VERSION || (id === 'codex' ? '0.166.0' : '2.1.236');
  if (args.includes('--version')) {
    if (process.env.FAKE_SLOW_VERSION) await slowProbe();
    out(id === 'codex' ? `codex-cli ${version}\n` : `${version} (Claude Code)\n`);
    return;
  }
  if (args.includes('--help')) {
    if (process.env.FAKE_SLOW_HELP) await slowProbe();
    out(process.env.FAKE_HELP_BAD ? 'obsolete flags\n' : '--json --sandbox read-only SESSION_ID --print --output-format stream-json --verbose --resume --tools --strict-mcp-config --mcp-config --disable-slash-commands\n');
    return;
  }
  const prompt = readFileSync(0, 'utf8');
  writeFileSync('invocation.json', JSON.stringify({ args, prompt, cwd: process.cwd() }));
  const resume = args.indexOf(id === 'codex' ? 'resume' : '--resume');
  const sid = resume >= 0 ? args[resume + 1] : '11111111-1111-4111-8111-111111111111';
  const mode = process.env.FAKE_SCENARIO || 'normal';
  const start = () => send(id === 'codex' ? { type: 'thread.started', thread_id: sid } : { type: 'system', subtype: 'init', session_id: sid });
  start();
  writeSync(2, 'diagnostic\n');
  if (mode === 'hang') {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fake-child.mjs', import.meta.url))], { stdio: 'ignore' });
    writeFileSync('child.pid', String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'malformed') { out('{bad-json\n'); return; }
  if (mode === 'partial') return;
  if (mode === 'signal') { process.kill(process.pid, 'SIGTERM'); return; }
  if (mode === 'flood') { for (let i = 0; i < 10000; i++) send({ type: 'extension', text: 'x'.repeat(1000) }); return; }
  if (mode === 'queue') { for (let i = 0; i < 100; i++) send({ type: 'extension', text: 'x' }); }
  if (mode === 'provider-error') {
    if (id === 'codex') send({ type: 'turn.failed', error: { message: 'quota_exceeded: retry later' } });
    else send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, errors: ['quota_exceeded: retry later'] });
    process.exitCode = 1;
    return;
  }
  if (id === 'codex') {
    send({ type: 'item.started', item: { id: 'tool_1', type: 'command_execution', command: 'echo test', status: 'in_progress' } });
    send({ type: 'item.completed', item: { id: 'tool_1', type: 'command_execution', command: 'echo test', aggregated_output: 'test', exit_code: 0, status: 'completed' } });
    send({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: 'Привет 🌍' } });
    send({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 } });
  } else {
    send({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'Привет 🌍' }, { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'README.md' } }] } });
    send({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'contents' }] } });
    send({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'Привет 🌍', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001, permission_denials: mode === 'denied' ? [{ tool_name: 'Read' }] : [] });
  }
  if (mode === 'nonzero') process.exitCode = 7;
  if (mode === 'slow-close') {
    await new Promise(resolve => setTimeout(resolve, 300));
    process.exitCode = 7;
  }
}
