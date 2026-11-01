import { CommitSchema } from '@adw/contracts';
import { git } from './command.js';
export async function resolveBaseCommit(repoPath: string, baseBranch: string): Promise<string> {
 await git(repoPath, ['check-ref-format', '--branch', baseBranch]);
 return CommitSchema.parse(await git(repoPath, ['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`]));
}
export async function currentBranch(repoPath: string): Promise<string> {
 return await git(repoPath, ['symbolic-ref', '--short', 'HEAD']);
}
