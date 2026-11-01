import { afterEach, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.js';
import { Supervisor } from '../src/index.js';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(() => f?.close());
it('runs a locked DAG serially, attaches real bundles and verifies committed edits independently', async () => {
    f = await fixture();
    const locked = f.confirm();
    f.input.nodes = [{ id: 'a', instruction: 'first', dependsOn: [] }, { id: 'b', instruction: 'second', dependsOn: [] }, { id: 'c', instruction: 'third', dependsOn: ['a', 'b'] }];
    const result = await f.supervisor.run(f.input);
    expect(result.state,JSON.stringify(result.review)).toBe('ready_for_human_review');
    expect(result.nodes.map(node => node.status)).toEqual(['passed', 'passed', 'passed']);
    expect(result.verifiedSnapshot?.taskId).toBe('task_test');
    expect(f.db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'ready_for_review' });
    expect(f.db.prepare("SELECT count(*) AS n FROM verification_runs WHERE status='passed'").get()).toEqual({ n: 3 });
    expect(await git(f.repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('base');
    expect(JSON.parse(readFileSync(f.adapter.calls[0]!.bundlePath!, 'utf8')).acceptance).toEqual(locked.acceptance);
    expect(f.db.prepare("SELECT payload_json FROM audit_events WHERE action='dag_scheduled' ORDER BY rowid LIMIT 1").get()).toEqual({ payload_json: expect.stringContaining('"wouldParallelize":true') });
    expect(f.db.prepare('SELECT active FROM supervisor_runs').get()).toEqual({ active: 0 });
}, 20000);
it('runs a fix with exact structured feedback after a red independent check', async () => {
    f = await fixture('retry');
    f.confirm();
    const result = await f.supervisor.run(f.input);
    expect(result.state,JSON.stringify(result.review)).toBe('ready_for_human_review');
    expect(f.adapter.calls).toHaveLength(2);
    expect(f.adapter.calls[1]!.prompt).toContain('verification_feedback');
    expect(f.adapter.calls[1]!.prompt).toContain('artifactRefs');
    expect(f.adapter.calls[1]!.prompt).toContain('\"content\":\"bad\"');
    expect(f.adapter.calls[1]!.prompt).toContain('evidencePath');
    expect(result.tokens).toBe(20);
    expect(f.db.prepare('SELECT status FROM verification_runs ORDER BY started_at').all()).toEqual([{ status: 'failed' }, { status: 'passed' }]);
});
it('ignores agent self-reported success and stops an identical red result after two attempts', async () => {
    f = await fixture('repeat');
    f.confirm();
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('needs_human');
    expect(result.reason).toContain('Identical');
    expect(result.verifiedSnapshot).toBeUndefined();
    expect(f.adapter.calls).toHaveLength(2);
});
it('caps distinct red failures at three fixes following the initial attempt', async () => {
    f = await fixture('different_failures');
    f.confirm();
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('needs_human');
    expect(result.reason).toContain('limit');
    expect(f.adapter.calls).toHaveLength(4);
});
it('stops exhausted usage budget and cancels before verification or another attempt', async () => {
    f = await fixture('budget');
    f.confirm();
    f.input.limits.maxTokens = 100;
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('failed');
    expect(result.reason).toContain('budget');
    expect(f.adapter.cancelled.length).toBeGreaterThan(0);
    expect(f.db.prepare('SELECT count(*) AS n FROM verification_runs').get()).toEqual({ n: 0 });
});
it('does not certify a bounded run whose agent omits required telemetry', async () => {
    f = await fixture('missing_usage');
    f.confirm();
    f.input.limits.maxCost = 1;
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('failed');
    expect(result.reason).toContain('telemetry');
    expect(result.verifiedSnapshot).toBeUndefined();
});
it('times out a stalled session, closes its lease and never verifies it', async () => {
    f = await fixture('hang');
    f.confirm();
    f.input.limits.sessionTimeoutMs = 150;
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('failed');
    expect(result.reason).toContain('timed out');
    expect(f.adapter.cancelled.length).toBeGreaterThan(0);
    expect(f.db.prepare('SELECT active FROM supervisor_runs').get()).toEqual({ active: 0 });
});
it('cancels on caller signal during agent execution and rejects a concurrent run', async () => {
    f = await fixture('hang');
    f.confirm();
    const controller = new AbortController();
    f.input.signal = controller.signal;
    const running = f.supervisor.run(f.input);
    // Wait for the session itself, not a fixed startup duration.
    while (!f.adapter.calls.length)
        await new Promise(resolve => setTimeout(resolve, 5));
    await expect(f.supervisor.run(f.input)).rejects.toThrow('already running');
    controller.abort();
    expect((await running).state).toBe('cancelled');
});
it('fences another supervisor instance before it can create a worktree', async () => {
    f = await fixture('hang');
    f.confirm();
    const controller = new AbortController();
    const running = f.supervisor.run({ ...f.input, signal: controller.signal });
    const second = new Supervisor({ db: f.db, manager: f.manager, verifier: f.verifier, adapters: [f.adapter], createContext: async () => { throw new Error('must not run'); } });
    await expect(second.run(f.input)).rejects.toThrow('not available');
    controller.abort();
    await running;
});
it('kills a verification command at the overall deadline and starts no following checks', async () => {
    f = await fixture();
    f.confirm();
    const hang = join(f.root, 'hang.cjs'), later = join(f.root, 'later.cjs'), marker = join(f.root, 'later');
    writeFileSync(hang, 'setInterval(()=>{},1000)');
    writeFileSync(later, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`);
    f.input.checks = [{ name: 'hang', command: `"${process.execPath}" "${hang}"`, blocking: true }, { name: 'later', command: `"${process.execPath}" "${later}"`, blocking: true }];
    f.input.limits.wallTimeMs = 2500;
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('failed');
    expect(result.reason).toContain('wall time');
    expect(existsSync(marker)).toBe(false);
    expect(f.db.prepare('SELECT name,not_verified FROM check_results').all()).toEqual([{ name: 'hang', not_verified: 1 }]);
    expect(f.db.prepare("SELECT count(*) AS n FROM verification_runs WHERE status='running'").get()).toEqual({ n: 0 });
}, 10000);
it('rejects a green check that changes the committed patch snapshot', async () => {
    f = await fixture();
    f.confirm();
    f.input.limits.maxFixCycles = 0;
    const mutate = join(f.root, 'mutate.cjs');
    writeFileSync(mutate, 'require("node:fs").writeFileSync("value.txt","changed by check")');
    f.input.checks = [{ name: 'mutate', command: `"${process.execPath}" "${mutate}"`, blocking: true }];
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('needs_human');
    expect(result.verifiedSnapshot).toBeUndefined();
    expect(f.db.prepare('SELECT not_verified FROM check_results').get()).toEqual({ not_verified: 1 });
});
it.each(['no_terminal', 'failed_after_complete'] as const)('does not verify an invalid adapter lifecycle: %s', async (mode) => {
    f = await fixture(mode);
    f.confirm();
    expect((await f.supervisor.run(f.input)).state).toBe('failed');
    expect(f.db.prepare('SELECT count(*) AS n FROM verification_runs').get()).toEqual({ n: 0 });
});
it('treats a per-check timeout as a forced stop without retry or subsequent commands', async () => {
    f = await fixture();
    f.confirm();
    const hang = join(f.root, 'hang.cjs');
    writeFileSync(hang, 'setInterval(()=>{},1000)');
    f.input.checks = [{ name: 'timeout', command: `"${process.execPath}" "${hang}"`, blocking: true, timeoutMs: 100 }, { name: 'must-not-run', command: 'true', blocking: true }];
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('failed');
    expect(result.reason).toContain('timed out');
    expect(f.adapter.calls).toHaveLength(1);
    expect(f.db.prepare('SELECT name FROM check_results').all()).toEqual([{ name: 'timeout' }]);
});
it('does not overwrite another owner after a persisted lease is revoked', async () => {
    f = await fixture();
    f.confirm();
    const original = f.adapter.startSession.bind(f.adapter);
    f.adapter.startSession = async function* (input) { for await (const event of original(input)) {
        if (event.type === 'completed') {
            f.db.prepare('UPDATE supervisor_runs SET active=0').run();
            f.db.prepare("UPDATE tasks SET status='cancelled'").run();
        }
        yield event;
    } };
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('failed');
    expect(f.db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'cancelled' });
    expect(f.db.prepare('SELECT count(*) AS n FROM verification_runs').get()).toEqual({ n: 0 });
});

it('records an optional-check timeout as failed rather than a passed verification run', async () => {
    f = await fixture(); f.confirm();
    const hang = join(f.root, 'optional-hang.cjs'); writeFileSync(hang, 'setInterval(()=>{},1000)');
    f.input.checks = [{name:'required',command:'true',blocking:true}, {name:'optional',command:`"${process.execPath}" "${hang}"`,blocking:false,timeoutMs:100}];
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('failed');
    expect(f.db.prepare('SELECT status FROM verification_runs').get()).toEqual({status:'failed'});
    expect(f.adapter.calls).toHaveLength(1);
});
