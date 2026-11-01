import { createHash } from 'node:crypto';
import { PatchAcceptanceSchema, PatchSnapshotSchema, type PatchAcceptance, type PatchSnapshot, type Worktree } from '@adw/contracts';
import { dirname } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { git, gitRaw } from './command.js';
import { assertSafeToAccept } from './drift.js';
import { GitWorktreeManager, safeTaskId } from './worktree-manager.js';
import { capturePatchSnapshot, samePatchSnapshot } from './snapshot.js';

export async function acceptPatch(manager: GitWorktreeManager, input: {
  worktree: Worktree; baseBranch: string; expectedSnapshot: PatchSnapshot;
}): Promise<PatchAcceptance> {
  const { worktree, baseBranch } = input;
  const expected = PatchSnapshotSchema.parse(input.expectedSnapshot);
  await manager.assertManaged(worktree);
  await assertSafeToAccept(manager.repoPath, baseBranch, worktree.baseCommit);
  if (!samePatchSnapshot(expected, await capturePatchSnapshot(manager, worktree))) throw new Error('Task snapshot differs from the verified snapshot');
  const patch = await gitRaw(worktree.path, ['diff', '--binary', worktree.baseCommit, expected.headCommit, '--']);
  if (createHash('sha256').update(patch).digest('hex') !== expected.patchHash) throw new Error('Patch hash differs from the verified snapshot');
  if (!patch) throw new Error('No changes to accept');
  const branch = `adw/accept/${safeTaskId(worktree.taskId)}`;
  const ref = `refs/heads/${branch}`;
  const path = manager.acceptancePath(worktree.taskId);
  mkdirSync(dirname(path), { recursive: true });
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error('Symlinked acceptance directory');
  let branchCreated = false, worktreeCreated = false;
  let ownedTip = worktree.baseCommit;
  try {
    // Create-if-absent distinguishes our ref from an existing user's branch.
    await git(manager.repoPath, ['update-ref', ref, worktree.baseCommit, '0'.repeat(40)]);
    branchCreated = true;
    await git(manager.repoPath, ['worktree', 'add', path, branch]);
    worktreeCreated = true;
    await git(path, ['apply', '--index', '--binary', '-'], patch);
    const tree = await git(path, ['write-tree']);
    if (tree !== await git(worktree.path, ['rev-parse', `${expected.headCommit}^{tree}`])) throw new Error('Applied tree differs from the verified snapshot');
    await assertSafeToAccept(manager.repoPath, baseBranch, worktree.baseCommit);
    if (!samePatchSnapshot(expected, await capturePatchSnapshot(manager, worktree))) throw new Error('Task snapshot changed during acceptance');
    // Know the commit before moving the ref, so rollback can also compare its tip.
    const commit = await git(path, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', worktree.baseCommit], `Accept ${worktree.taskId}\n`);
    await git(manager.repoPath, ['update-ref', '-m', `Accept ${worktree.taskId}`, ref, commit, ownedTip]);
    ownedTip = commit;
    return PatchAcceptanceSchema.parse({ taskId: worktree.taskId, status: 'accepted', branch, commit });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (worktreeCreated) {
      try { await git(manager.repoPath, ['worktree', 'remove', '--force', path]); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (branchCreated && cleanupErrors.length === 0) {
      // Keep refs moved by another writer, or still used by an unremoved checkout.
      try {
        if ((await manager.list()).some(worktree => worktree.branch === ref)) throw new Error('Acceptance branch is still in use by a worktree');
        await git(manager.repoPath, ['update-ref', '-d', ref, ownedTip]);
      }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'Acceptance failed; cleanup incomplete');
    throw error;
  }
}

export async function rejectPatch(manager: GitWorktreeManager, worktree: Worktree, reason: string): Promise<PatchAcceptance> {
  const result = PatchAcceptanceSchema.parse({ taskId: worktree.taskId, status: 'rejected', reason });
  await manager.remove(worktree);
  return result;
}
