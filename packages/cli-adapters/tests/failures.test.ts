import { afterEach, expect, it } from 'vitest';
import { rmSync, statSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, collect } from './helpers.js';
import { CodexAdapter } from '../src/index.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const id of ['codex', 'claude-code'] as const) {
  for (const [scenario, code] of [['nonzero','exit_code'], ['slow-close','exit_code'], ['partial','protocol_error'], ['malformed','protocol_error'], ['provider-error','provider_error'], ['signal','signal']] as const) {
    it(`${id}: ${scenario} never emits completed`, async () => {
      const f = fixture(id, { env: { FAKE_SCENARIO: scenario } }); roots.push(f.root);
      const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 5000 }));
      expect(events.filter(event => event.type === 'completed')).toEqual([]);
      expect(events.filter(event => event.type === 'failed')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'failed', code });
    });
  }
  it(`${id}: bounds output and preserves a failed terminal event`, async () => {
    const f = fixture(id, { env: { FAKE_SCENARIO: 'flood' }, maxOutputBytes: 2048 }); roots.push(f.root);
    const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 5000 }));
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'output_limit' });
    const dir = join(f.root, 'logs', events[0]!.sessionId);
    expect(statSync(join(dir,'stdout.log')).size + statSync(join(dir,'stderr.log')).size).toBeLessThanOrEqual(2048);
  });
}
it('surfaces Claude permission denials even with an otherwise successful result', async () => {
  const f = fixture('claude-code', { env: { FAKE_SCENARIO: 'denied' } }); roots.push(f.root);
  const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 5000 }));
  expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'permission_denied' });
});
it('reports a missing binary without replacing it with a PATH candidate', async () => {
  const adapter = new CodexAdapter({ binaryPath: '/tmp/adw-this-binary-does-not-exist' });
  const events = await collect(adapter.startSession({ worktreePath: '/tmp', prompt: 'x', timeoutMs: 5000 }));
  expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'discovery_failed' });
});
for (const variable of ['FAKE_SLOW_VERSION', 'FAKE_SLOW_HELP']) {
  it.skipIf(process.platform !== 'linux')(`includes ${variable} preflight and descendants in the session timeout`, async () => {
    const probeRoot = mkdtempSync(join(tmpdir(),'adw-probe-')); roots.push(probeRoot);
    const pidPath = join(probeRoot,'child.pid');
    const f = fixture('codex', { env: { [variable]: '1', FAKE_PROBE_PID_PATH: pidPath } }); roots.push(f.root);
    const events = await collect(f.adapter.startSession({worktreePath:f.worktreePath,prompt:'x',timeoutMs:300}));
    expect(events.at(-1)).toMatchObject({type:'failed',code:'timeout'});
    expect(events.filter(event => event.type === 'session_started')).toHaveLength(0);
    const pid = Number(readFileSync(pidPath,'utf8'));
    try { expect(readFileSync(`/proc/${pid}/status`,'utf8')).toMatch(/State:\s+Z/); }
    catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  });
}
