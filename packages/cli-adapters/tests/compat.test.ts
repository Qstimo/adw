import { afterEach, expect, it } from 'vitest';
import { readdirSync, rmSync } from 'node:fs';
import { fixture, collect } from './helpers.js';
import { loadCompatibility } from '../src/index.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const id of ['codex', 'claude-code'] as const) {
  it(`${id}: loads a conservative default for an unknown version and refuses execution`, async () => {
    const f = fixture(id, { env: { FAKE_VERSION: '999.0.0' } }); roots.push(f.root);
    const caps = await f.adapter.probeCapabilities('999.0.0');
    expect(caps.execution.headless).toBe('unknown'); expect(caps.output.format).toBe('unknown');
    const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 5000 }));
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'unsupported_version' });
    expect(readdirSync(f.worktreePath)).toEqual([]);
  });
  it(`${id}: detects stale compatibility flags and rejects a changed version`, async () => {
    const f = fixture(id, { env: { FAKE_HELP_BAD: '1' } }); roots.push(f.root);
    const version = id === 'codex' ? '0.166.0' : '2.1.236';
    await expect(f.adapter.probeCapabilities(version)).rejects.toThrow('differs');
    await expect(f.adapter.probeCapabilities('0.0.1')).rejects.toThrow('changed');
    const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 5000 }));
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'capability_mismatch' });
  });
}
it('rejects version path traversal before reading matrix files', async () => {
  await expect(loadCompatibility('codex', '../../fake')).rejects.toThrow('Invalid');
});
