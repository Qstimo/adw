import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeManager, acceptPatch, rejectPatch, detectBaseDrift, assertSafeToAccept, capturePatchSnapshot } from '../src/index.js';
let dir: string, repo: string, manager: GitWorktreeManager;
const acceptCurrent = async (wt: Parameters<typeof capturePatchSnapshot>[1]) => acceptPatch(manager,{worktree:wt,baseBranch:'main',expectedSnapshot:await capturePatchSnapshot(manager,wt)});
const git = (cwd: string, ...args: string[]): Promise<string> => new Promise((resolve,reject) => { execFile('git', args, {cwd,encoding:'utf8'}, (error,stdout) => error ? reject(error) : resolve(stdout.trim())); });
beforeEach(async () => {
 dir = mkdtempSync(join(tmpdir(), 'adw git ')); repo = join(dir, 'repo');
 await git(dir,'init','-b','main',repo);
 await git(repo,'config','user.email','adw@test'); await git(repo,'config','user.name','ADW');
 writeFileSync(join(repo,'README.md'),'base\n'); await git(repo,'add','.'); await git(repo,'commit','-m','base');
 manager = new GitWorktreeManager(repo, join(dir,'data'));
});
afterEach(() => rmSync(dir,{recursive:true,force:true}));
it('pins the base SHA and isolates edits from main, including paths with spaces', async () => {
 const wt = await manager.createTaskWorktree({taskId:'task_1'});
 expect(wt.baseCommit).toBe(await git(repo,'rev-parse','HEAD'));
 expect((await manager.list()).map(w => w.path)).toContain(wt.path);
 writeFileSync(join(wt.path,'README.md'),'changed\n');
 expect(await manager.diff(wt)).toContain('+changed');
 expect(readFileSync(join(repo,'README.md'),'utf8')).toBe('base\n');
 expect(await git(repo,'status','--porcelain')).toBe('');
 await manager.remove(wt); expect(existsSync(wt.path)).toBe(false);
});
it('guards against dirty main and base branch drift', async () => {
 const wt = await manager.createTaskWorktree({taskId:'task_1',baseBranch:'main'});
 writeFileSync(join(repo,'untracked'),'dirty');
 await expect(assertSafeToAccept(repo,'main',wt.baseCommit)).rejects.toThrow('dirty');
 await git(repo,'add','.');await git(repo,'commit','-m','advance');
 expect((await detectBaseDrift(repo,'main',wt.baseCommit)).drifted).toBe(true);
 await expect(assertSafeToAccept(repo,'main',wt.baseCommit)).rejects.toThrow('drifted');
});
it('accepts committed changes onto a new branch without moving main', async () => {
 const wt = await manager.createTaskWorktree({taskId:'task_1'});
 writeFileSync(join(wt.path,'README.md'),'accepted\n');
 writeFileSync(join(wt.path,'binary.dat'),Buffer.from([0,1,2,255]));
 await git(wt.path,'add','.');await git(wt.path,'commit','-m','task');
 const result = await acceptCurrent(wt);
 expect(result.status).toBe('accepted');
 expect(await git(repo,'rev-parse','main')).toBe(wt.baseCommit);
 expect(await git(repo,'symbolic-ref','--short','HEAD')).toBe('main');
 expect(await git(repo,'show','adw/accept/task_1:README.md')).toBe('accepted');
 expect(readFileSync(join(manager.acceptancePath(wt.taskId),'binary.dat'))).toEqual(Buffer.from([0,1,2,255]));
 expect(await git(repo,'status','--porcelain')).toBe('');
});
it('rejects uncommitted acceptance and removes only the rejected task worktree', async () => {
 const wt = await manager.createTaskWorktree({taskId:'task_1'});
 writeFileSync(join(wt.path,'README.md'),'rejected');
 await expect(acceptCurrent(wt)).rejects.toThrow('Commit');
 const record = await rejectPatch(manager,wt,'Does not meet acceptance');
 expect(record.status).toBe('rejected'); expect(existsSync(wt.path)).toBe(false);
 expect(readFileSync(join(repo,'README.md'),'utf8')).toBe('base\n');
});
it('blocks drifted acceptance and leaves no acceptance branch', async () => {
 const wt = await manager.createTaskWorktree({taskId:'task_1'});
 writeFileSync(join(wt.path,'README.md'),'task');await git(wt.path,'add','.');await git(wt.path,'commit','-m','task');
 writeFileSync(join(repo,'new'),'advance');await git(repo,'add','.');await git(repo,'commit','-m','advance');
 await expect(acceptCurrent(wt)).rejects.toThrow('drifted');
 expect(await git(repo,'branch','--list','adw/accept/*')).toBe('');
});
it('does not overwrite existing acceptance branches', async () => {
 const wt = await manager.createTaskWorktree({taskId:'task_1'});
 writeFileSync(join(wt.path,'README.md'),'task');await git(wt.path,'add','.');await git(wt.path,'commit','-m','task');
 await git(repo,'branch','adw/accept/task_1');
 await expect(acceptCurrent(wt)).rejects.toThrow();
 expect(await git(repo,'rev-parse','adw/accept/task_1')).toBe(wt.baseCommit);
});
it('rejects unsafe task IDs, branch arguments, data directories and unmanaged paths', async () => {
 await expect(manager.createTaskWorktree({taskId:'task_../../repo'})).rejects.toThrow();
 await expect(manager.createTaskWorktree({taskId:'task_1',baseBranch:'--help'})).rejects.toThrow();
 expect(() => new GitWorktreeManager(repo,join(repo,'.adw'))).toThrow('outside');
 const wt = await manager.createTaskWorktree({taskId:'task_1'});
 await expect(manager.remove({...wt,path:repo})).rejects.toThrow('Unmanaged');
 expect(existsSync(repo)).toBe(true);
});

it('rolls back the new acceptance worktree and branch when commit creation fails', async () => {
 const wt=await manager.createTaskWorktree({taskId:'task_1'});
 writeFileSync(join(wt.path,'README.md'),'task\n');await git(wt.path,'add','.');await git(wt.path,'commit','-m','task');
 await git(repo,'config','user.name','');
 await expect(acceptCurrent(wt)).rejects.toThrow();
 expect(existsSync(manager.acceptancePath('task_1'))).toBe(false);
 expect(await git(repo,'branch','--list','adw/accept/task_1')).toBe('');
 expect(await git(repo,'rev-parse','main')).toBe(wt.baseCommit);
});

it('rejects a changed patch after the verification snapshot was captured', async () => {
 const wt=await manager.createTaskWorktree({taskId:'task_1'});
 writeFileSync(join(wt.path,'README.md'),'checked');await git(wt.path,'add','.');await git(wt.path,'commit','-m','checked');
 const expectedSnapshot={taskId:wt.taskId,baseCommit:wt.baseCommit,headCommit:await git(wt.path,'rev-parse','HEAD'),patchHash:createHash('sha256').update(await manager.diff(wt)).digest('hex')};
 writeFileSync(join(wt.path,'README.md'),'unchecked');await git(wt.path,'add','.');await git(wt.path,'commit','-m','unchecked');
 await expect(acceptPatch(manager,{worktree:wt,baseBranch:'main',expectedSnapshot})).rejects.toThrow('snapshot');
 expect(await git(repo,'branch','--list','adw/accept/task_1')).toBe('');
});
it('cleans its acceptance branch when the target path is occupied and permits retry', async () => {
 const wt=await manager.createTaskWorktree({taskId:'task_1'});
 writeFileSync(join(wt.path,'README.md'),'checked');await git(wt.path,'add','.');await git(wt.path,'commit','-m','checked');
 const expectedSnapshot={taskId:wt.taskId,baseCommit:wt.baseCommit,headCommit:await git(wt.path,'rev-parse','HEAD'),patchHash:createHash('sha256').update(await manager.diff(wt)).digest('hex')};
 const target=manager.acceptancePath('task_1');mkdirSync(target,{recursive:true});writeFileSync(join(target,'user-file'),'keep');
 await expect(acceptPatch(manager,{worktree:wt,baseBranch:'main',expectedSnapshot})).rejects.toThrow();
 expect(readFileSync(join(target,'user-file'),'utf8')).toBe('keep');
 expect(await git(repo,'branch','--list','adw/accept/task_1')).toBe('');
 rmSync(target,{recursive:true});
 expect((await acceptPatch(manager,{worktree:wt,baseBranch:'main',expectedSnapshot})).status).toBe('accepted');
});

it('requires the exact snapshot hash and rejects calls without a snapshot', async () => {
 const wt=await manager.createTaskWorktree({taskId:'task_1'});
 writeFileSync(join(wt.path,'README.md'),'checked');await git(wt.path,'add','.');await git(wt.path,'commit','-m','checked');
 const expectedSnapshot=await capturePatchSnapshot(manager,wt);
 await expect(acceptPatch(manager,{worktree:wt,baseBranch:'main',expectedSnapshot:{...expectedSnapshot,patchHash:'0'.repeat(64)}})).rejects.toThrow('snapshot');
 // @ts-expect-error JavaScript callers must also be rejected at runtime.
 await expect(acceptPatch(manager,{worktree:wt,baseBranch:'main'})).rejects.toThrow();
 expect(await git(repo,'branch','--list','adw/accept/task_1')).toBe('');
});
