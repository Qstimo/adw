import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { TaskSpecSchema, type TaskSpec } from '@adw/contracts';
import { stableJson } from '@adw/context';
export type LockedSpec = Readonly<Omit<TaskSpec, 'status' | 'acceptance' | 'outOfScope'> & {
    readonly acceptance: readonly string[];
    readonly outOfScope: readonly string[];
}>;
export function readSpec(db: Database.Database, taskId: string): Omit<TaskSpec, 'status'> {
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as {
        id: string;
        project_id: string;
        intent: string;
        acceptance_json: string;
        out_of_scope_json: string;
        base_branch: string;
        base_commit: string;
        status: TaskSpec['status'];
    } | undefined;
    if (!row)
        throw new Error('Task not found');
    const spec = { id: row.id, projectId: row.project_id, intent: row.intent, acceptance: JSON.parse(row.acceptance_json) as string[], outOfScope: JSON.parse(row.out_of_scope_json) as string[], baseBranch: row.base_branch, baseCommit: row.base_commit };
    const validated = TaskSpecSchema.parse({ ...spec, status: row.status });
    return { ...spec, id: validated.id, projectId: validated.projectId };
}
export const specHash = (spec: Omit<TaskSpec, 'status'> | LockedSpec): string => createHash('sha256').update(stableJson(spec)).digest('hex');
const freeze = (spec: Omit<TaskSpec, 'status'>): LockedSpec => Object.freeze({ ...spec, acceptance: Object.freeze([...spec.acceptance]), outOfScope: Object.freeze([...spec.outOfScope]) });
export function getLockedSpec(db: Database.Database, taskId: string): LockedSpec {
    const row = db.prepare('SELECT spec_json,spec_hash FROM supervisor_specs WHERE task_id=?').get(taskId) as {
        spec_json: string;
        spec_hash: string;
    } | undefined;
    if (!row)
        throw new Error('User-approved spec required');
    const spec = readSpec(db, taskId);
    if (specHash(spec) !== row.spec_hash || stableJson(spec) !== row.spec_json)
        throw new Error('Approved spec differs from task');
    return freeze(spec);
}
export function confirmSpec(db: Database.Database, input: {
    taskId: string;
    expectedSpecHash: string;
    approvedBy: string;
}): LockedSpec {
    if (!input.approvedBy.trim())
        throw new Error('Approval actor required');
    return db.transaction(() => {
        const spec = readSpec(db, input.taskId), hash = specHash(spec);
        if (hash !== input.expectedSpecHash)
            throw new Error('Spec changed since approval preview');
        if (db.prepare('SELECT 1 FROM supervisor_specs WHERE task_id=?').get(input.taskId))
            return getLockedSpec(db, input.taskId);
        const now = new Date().toISOString();
        if (db.prepare("UPDATE tasks SET status='locked',updated_at=? WHERE id=? AND status='draft'").run(now, input.taskId).changes !== 1)
            throw new Error('Only a draft spec can be confirmed');
        db.prepare('INSERT INTO supervisor_specs VALUES (?,?,?,?,?)').run(input.taskId, stableJson(spec), hash, input.approvedBy, now);
        db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(), now, input.approvedBy, 'spec_locked', JSON.stringify({ taskId: input.taskId, specHash: hash }));
        return freeze(spec);
    }).immediate();
}
