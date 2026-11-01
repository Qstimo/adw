import { git } from './command.js';
import { resolveBaseCommit } from './base-commit.js';
export async function detectBaseDrift(repoPath: string, baseBranch: string, baseCommit: string) {
 const current = await resolveBaseCommit(repoPath, baseBranch);
 return { drifted: current !== baseCommit, old: baseCommit, new: current };
}
export async function assertSafeToAccept(repoPath: string, baseBranch: string, baseCommit: string): Promise<void> {
 if (await git(repoPath, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Main working tree is dirty');
 if ((await detectBaseDrift(repoPath, baseBranch, baseCommit)).drifted) throw new Error('Base branch has drifted');
}
