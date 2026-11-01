import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CommitSchema, TaskIdSchema, WorktreeSchema, type Worktree } from '@adw/contracts';
import { git, gitRaw } from './command.js';
import { currentBranch, resolveBaseCommit } from './base-commit.js';
export function safeTaskId(value: string): string {
 TaskIdSchema.parse(value);
 if (!/^task_[A-Za-z0-9_-]+$/.test(value)) throw new Error('Unsafe task ID');
 return value;
}
function inside(parent: string, child: string) {
 const rel = relative(parent, child);
 return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export class GitWorktreeManager {
 readonly repoPath: string;
 readonly dataDir: string;
 constructor(repoPath: string, dataDir?: string) {
  this.repoPath = realpathSync(repoPath);
  if (!existsSync(join(this.repoPath, '.git'))) throw new Error('Expected repository root with .git metadata');
  const top = this.repoPath;
  const requested = resolve(dataDir ?? join(dirname(top), `${basename(top)}.adw`));
  // Worktrees and evidence must not dirty or overwrite the primary checkout.
  if (inside(top, requested)) throw new Error('Data directory must be outside the main repository');
  mkdirSync(requested, { recursive: true });
  this.dataDir = realpathSync(requested);
  if (inside(top, this.dataDir)) throw new Error('Data directory resolves inside main repository');
 }
 taskPath(taskId: string): string { return join(this.dataDir, 'worktrees', safeTaskId(taskId)); }
 acceptancePath(taskId: string): string { return join(this.dataDir, 'accepted', safeTaskId(taskId)); }
 async createTaskWorktree(input: { taskId: string; baseBranch?: string }): Promise<Worktree> {
  const top = realpathSync(await git(this.repoPath, ['rev-parse', '--show-toplevel']));
  if (top !== this.repoPath) throw new Error('Expected repository root');
  const baseCommit = await resolveBaseCommit(this.repoPath, input.baseBranch ?? await currentBranch(this.repoPath));
  const path = this.taskPath(input.taskId);
  mkdirSync(dirname(path), { recursive: true });
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error('Symlinked worktree directory');
  await git(this.repoPath, ['worktree', 'add', '--detach', path, baseCommit]);
  return WorktreeSchema.parse({ taskId: input.taskId, path, baseCommit });
 }
 async list(): Promise<{ path: string; head: string; branch?: string }[]> {
  const records = (await git(this.repoPath, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  return records.filter(Boolean).map(record => {
   const fields = record.split('\0');
   const path = fields.find(f => f.startsWith('worktree '))?.slice(9);
   const head = fields.find(f => f.startsWith('HEAD '))?.slice(5);
   const branch = fields.find(f => f.startsWith('branch '))?.slice(7);
   if (!path || !head) throw new Error('Invalid git worktree output');
   return { path, head, ...(branch ? { branch } : {}) };
  });
 }
 async assertManaged(worktree: Worktree): Promise<void> {
  CommitSchema.parse(worktree.baseCommit);
  const expected = this.taskPath(worktree.taskId);
  if (resolve(worktree.path) !== expected || realpathSync(worktree.path) !== expected) throw new Error('Unmanaged worktree path');
  if (!(await this.list()).some(w => w.path === expected)) throw new Error('Worktree is not registered');
  await git(expected, ['merge-base', '--is-ancestor', worktree.baseCommit, 'HEAD']);
 }
 async remove(worktree: Worktree): Promise<void> {
  await this.assertManaged(worktree);
  // Force is only used for this manager-owned task checkout, including rejected edits.
  await git(this.repoPath, ['worktree', 'remove', '--force', worktree.path]);
 }
 async diff(worktree: Worktree): Promise<string> {
  await this.assertManaged(worktree);
  // Includes committed and tracked uncommitted changes; untracked files must be staged.
  return gitRaw(worktree.path, ['diff', '--binary', worktree.baseCommit, '--']);
 }
}
