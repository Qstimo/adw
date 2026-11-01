import { afterEach, expect, it } from 'vitest';
import { fixture } from './helpers.js';
import { confirmSpec, readSpec, specHash, getLockedSpec } from '../src/index.js';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(() => f?.close());
it('locks exactly the previewed criteria, freezes copies and protects stored spec fields', async () => {
    f = await fixture();
    const expected = readSpec(f.db, 'task_test'), locked = f.confirm();
    expect(locked.acceptance).toEqual(expected.acceptance);
    expect(Object.isFrozen(locked.acceptance)).toBe(true);
    expect(() => { (locked.acceptance as string[]).push('changed'); }).toThrow();
    expect(() => f.db.prepare("UPDATE tasks SET acceptance_json='[\"changed\"]'").run()).toThrow('immutable');
    expect(() => f.db.prepare("UPDATE tasks SET base_commit=?").run('b'.repeat(40))).toThrow('immutable');
    expect(() => f.db.prepare('DELETE FROM supervisor_specs').run()).toThrow('immutable');
    expect(f.confirm()).toEqual(locked);
    expect(getLockedSpec(f.db, 'task_test')).toEqual(locked);
    expect(f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='spec_locked'").get()).toEqual({ n: 1 });
});
it('refuses stale previews or missing user approval and cannot execute an unlocked task', async () => {
    f = await fixture();
    const hash = specHash(readSpec(f.db, 'task_test'));
    f.db.prepare("UPDATE tasks SET intent='changed'").run();
    expect(() => confirmSpec(f.db, { taskId: 'task_test', expectedSpecHash: hash, approvedBy: 'user' })).toThrow('changed');
    expect(() => confirmSpec(f.db, { taskId: 'task_test', expectedSpecHash: specHash(readSpec(f.db, 'task_test')), approvedBy: '' })).toThrow('actor');
    await expect(f.supervisor.run(f.input)).rejects.toThrow('approved');
    expect(f.adapter.calls).toHaveLength(0);
});
