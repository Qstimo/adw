import { afterEach, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from '../../supervisor/tests/helpers.js';
import { acceptReviewedPatch } from '../src/services/review-acceptance.js';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(() => f?.close());
it('accepts the exact independently approved snapshot only after explicit human action, leaving main untouched', async () => {
    f = await fixture();
    f.confirm();
    const result = await f.supervisor.run(f.input);
    expect(result.review?.status).toBe('approved');
    const input = { db: f.db, manager: f.manager, evidenceStore: f.verifier.evidenceStore, taskId: 'task_test', reviewId: result.review!.id, approvedBy: 'human-fixture', worktree: result.worktree! };
    await expect(acceptReviewedPatch({ ...input, approvedBy: '' })).rejects.toThrow('human');
    const accepted = await acceptReviewedPatch(input);
    expect(accepted.status).toBe('accepted');
    expect(await acceptReviewedPatch(input)).toEqual(accepted);
    expect(f.db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'accepted' });
    expect(await git(f.repo, 'status', '--porcelain')).toBe('');
    expect(await git(f.repo, 'rev-parse', 'HEAD')).toBe(result.worktree!.baseCommit);
});
it.each(['blocking', 'malformed'] as const)('refuses human acceptance of a %s review', async (mode) => {
    f = await fixture();
    f.confirm();
    f.adapter.reviewMode = mode;
    const result = await f.supervisor.run(f.input);
    await expect(acceptReviewedPatch({ db: f.db, manager: f.manager, evidenceStore: f.verifier.evidenceStore, taskId: 'task_test', reviewId: result.review!.id, approvedBy: 'human', worktree: result.worktree! })).rejects.toThrow('approved');
    expect((await f.manager.list()).some(tree => tree.branch?.includes('adw/accept/'))).toBe(false);
});
it('rejects stale reviewed snapshots and releases only the failed acceptance claim', async () => {
    f = await fixture();
    f.confirm();
    const result = await f.supervisor.run(f.input);
    writeFileSync(join(result.worktree!.path, 'value.txt'), 'changed after review');
    await expect(acceptReviewedPatch({ db: f.db, manager: f.manager, evidenceStore: f.verifier.evidenceStore, taskId: 'task_test', reviewId: result.review!.id, approvedBy: 'human', worktree: result.worktree! })).rejects.toThrow();
    expect(f.db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'ready_for_review' });
    expect(f.db.prepare('SELECT status FROM review_acceptances').get()).toEqual({ status: 'failed' });
    expect((await f.manager.list()).some(tree => tree.branch?.includes('adw/accept/'))).toBe(false);
});
it('fences obsolete acceptance cleanup after its claim has been replaced',async()=>{
 f=await fixture();f.confirm();const result=await f.supervisor.run(f.input);
 f.manager.assertManaged=async()=>{f.db.prepare("UPDATE review_acceptances SET id='replacement-claim' WHERE task_id='task_test'").run();f.db.prepare("UPDATE tasks SET status='cancelled' WHERE id='task_test'").run();throw new Error('claim replaced during Git operation');};
 await expect(acceptReviewedPatch({db:f.db,manager:f.manager,evidenceStore:f.verifier.evidenceStore,taskId:'task_test',reviewId:result.review!.id,approvedBy:'human',worktree:result.worktree!})).rejects.toThrow('replaced');
 expect(f.db.prepare('SELECT status FROM tasks').get()).toEqual({status:'cancelled'});expect(f.db.prepare('SELECT id,status FROM review_acceptances').get()).toEqual({id:'replacement-claim',status:'running'});
});
