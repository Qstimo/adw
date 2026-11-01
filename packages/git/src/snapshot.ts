import { createHash } from 'node:crypto';
import { CommitSchema, PatchSnapshotSchema, type PatchSnapshot, type Worktree } from '@adw/contracts';
import { git, gitRaw } from './command.js';
import type { GitWorktreeManager } from './worktree-manager.js';

export function samePatchSnapshot(left: PatchSnapshot, right: PatchSnapshot): boolean {
  return left.taskId === right.taskId && left.baseCommit === right.baseCommit && left.headCommit === right.headCommit && left.patchHash === right.patchHash;
}

export async function capturePatchSnapshot(manager: GitWorktreeManager, worktree: Worktree): Promise<PatchSnapshot> {
  await manager.assertManaged(worktree);
  const headCommit = CommitSchema.parse(await git(worktree.path, ['rev-parse', 'HEAD']));
  const assertUnchanged = async () => {
    if (await git(worktree.path, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Commit task changes before capturing a snapshot');
    if (await git(worktree.path, ['rev-parse', 'HEAD']) !== headCommit) throw new Error('Task snapshot changed while being captured');
  };
  await assertUnchanged();
  const patch = await gitRaw(worktree.path, ['diff', '--binary', worktree.baseCommit, headCommit, '--']);
  await assertUnchanged();
  return PatchSnapshotSchema.parse({ taskId: worktree.taskId, baseCommit: worktree.baseCommit, headCommit, patchHash: createHash('sha256').update(patch).digest('hex') });
}
