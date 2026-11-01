import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { GitWorktreeManager, acceptPatch } from '@adw/git';
import { EvidenceStore, VerifierRunner } from '@adw/verifier';
import { openDb, migrate } from '../src/db/client.js';
import { GitVerifierFacade } from '../src/services/git-verifier-facade.js';
let dir: string, repo: string, db: Database.Database, facade: GitVerifierFacade;
const git = (cwd: string, ...args: string[]): Promise<string> => new Promise((resolve,reject) => { execFile('git',args,{cwd,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout.trim())); });
beforeEach(async () => {
 dir=mkdtempSync(join(tmpdir(),'adw-facade-'));repo=join(dir,'repo');mkdirSync(repo);
 cpSync(fileURLToPath(new URL('../../../fixtures/demo-repo/src',import.meta.url)),join(repo,'src'),{recursive:true});
 writeFileSync(join(repo,'check.cjs'),'const assert=require("node:assert/strict");assert.notEqual(process.env.FAIL_UNIT,"1");console.log("checked");');
 await git(repo,'init','-b','main');await git(repo,'config','user.email','adw@test');await git(repo,'config','user.name','ADW');await git(repo,'add','.');await git(repo,'commit','-m','fixture');
 const base=await git(repo,'rev-parse','HEAD');db=openDb(join(dir,'adw.sqlite'));migrate(db);
 db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_1',repo,'main','now');
 db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_1','proj_1','Verify fixture','["unit passes"]','[]','main',base,'locked','now','now');
 facade=new GitVerifierFacade(db,new GitWorktreeManager(repo,join(dir,'data')),new VerifierRunner(new EvidenceStore(join(dir,'evidence'))));
});
afterEach(() => {vi.restoreAllMocks();if(db?.open)db.close();rmSync(dir,{recursive:true,force:true});});
it('persists checks/evidence/audit for an isolated worktree without declaring review complete', async () => {
 const before=readFileSync(join(repo,'src/add.ts'),'utf8');
 const run=await facade.verifyTask({taskId:'task_1',checks:[{name:'unit',command:`"${process.execPath}" check.cjs`,blocking:true}]});
 expect(run.readyForReview).toBe(true);expect(run.worktree.path).not.toBe(repo);
 expect(run.verifiedSnapshot).toMatchObject({taskId:'task_1',baseCommit:run.worktree.baseCommit,headCommit:run.worktree.baseCommit});
 expect(db.prepare('SELECT id,status FROM verification_runs').get()).toEqual({id:run.runId,status:'passed'});
 expect(db.prepare('SELECT verification_run_id FROM check_results').get()).toEqual({verification_run_id:run.runId});
 expect(db.prepare('SELECT exit_code,blocking,base_commit FROM check_results').get()).toEqual({exit_code:0,blocking:1,base_commit:run.worktree.baseCommit});
 expect(db.prepare('SELECT status FROM tasks').get()).toEqual({status:'verifying'});
 const audit=db.prepare('SELECT action,payload_json FROM audit_events ORDER BY at').all() as {action:string;payload_json:string}[];
 expect(audit.map(a=>a.action)).toEqual(['verification_started','verification_worktree_created','verification_finished']);
 expect(audit.every(a=>JSON.parse(a.payload_json).runId===run.runId)).toBe(true);
 const persisted=db.prepare('SELECT snapshot_json FROM verification_runs WHERE id=?').get(run.runId) as {snapshot_json:string};
 expect(JSON.parse(persisted.snapshot_json)).toEqual(run.verifiedSnapshot);
 const finish=JSON.parse(audit[2]!.payload_json);expect(facade.verifier.evidenceStore.get(finish.diffRef).toString()).toBe('');
 expect(readFileSync(join(repo,'src/add.ts'),'utf8')).toBe(before);expect(await git(repo,'status','--porcelain')).toBe('');
});
it('records a failed required check and blocks readiness', async () => {
 const run=await facade.verifyTask({taskId:'task_1',env:{FAIL_UNIT:'1'},checks:[{name:'unit',command:`"${process.execPath}" check.cjs`,blocking:true}]});
 expect(run.readyForReview).toBe(false);expect(db.prepare('SELECT status FROM tasks').get()).toEqual({status:'failed'});
 expect(run.verifiedSnapshot).toBeUndefined();
 expect(db.prepare('SELECT id,status FROM verification_runs').get()).toEqual({id:run.runId,status:'failed'});
 expect(db.prepare('SELECT exit_code FROM check_results').get()).toEqual({exit_code:1});
});
it('refuses unlocked tasks and drift before spawning or creating a worktree', async () => {
 db.prepare('UPDATE tasks SET status=?').run('draft');
 await expect(facade.verifyTask({taskId:'task_1',checks:[]})).rejects.toThrow('locked');
 db.prepare('UPDATE tasks SET status=?').run('locked');
 writeFileSync(join(repo,'advance'),'drift');await git(repo,'add','.');await git(repo,'commit','-m','advance');
 await expect(facade.verifyTask({taskId:'task_1',checks:[]})).rejects.toThrow('drifted');
 expect((await facade.manager.list())).toHaveLength(1);
});

it('claims a task atomically across two facade instances and database connections', async () => {
 const otherDb=openDb(join(dir,'adw.sqlite'));
 try {
  const other=new GitVerifierFacade(otherDb,new GitWorktreeManager(repo,join(dir,'other-data')),new VerifierRunner(new EvidenceStore(join(dir,'other-evidence'))));
  const input={taskId:'task_1',checks:[{name:'unit',command:`"${process.execPath}" check.cjs`,blocking:true}]};
  const outcomes=await Promise.allSettled([facade.verifyTask(input),other.verifyTask(input)]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(db.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({n:1});
  expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='verification_failed'").get()).toEqual({n:0});
 } finally {otherDb.close();}
});

it('does not accept a patch changed after the successful verification run', async () => {
 const run=await facade.verifyTask({taskId:'task_1',checks:[{name:'unit',command:`"${process.execPath}" check.cjs`,blocking:true}]});
 expect(run.verifiedSnapshot).toBeDefined();
 writeFileSync(join(run.worktree.path,'src/add.ts'),'export const add = () => 0;');
 await git(run.worktree.path,'add','.');await git(run.worktree.path,'commit','-m','unchecked');
 await expect(acceptPatch(facade.manager,{worktree:run.worktree,baseBranch:'main',expectedSnapshot:run.verifiedSnapshot!})).rejects.toThrow('snapshot');
 expect(await git(repo,'branch','--list','adw/accept/*')).toBe('');
});
it('invalidates green exit codes if checks modified the worktree snapshot', async () => {
 writeFileSync(join(repo,'check.cjs'),'require("node:fs").appendFileSync("src/add.ts","\\n// changed by check");');
 await git(repo,'add','.');await git(repo,'commit','-m','mutating check');
 db.prepare('UPDATE tasks SET base_commit=?').run(await git(repo,'rev-parse','HEAD'));
 const run=await facade.verifyTask({taskId:'task_1',checks:[{name:'unit',command:`"${process.execPath}" check.cjs`,blocking:true}]});
 expect(run.results[0]).toMatchObject({exitCode:0,notVerified:true});
 expect(run.readyForReview).toBe(false);expect(run.verifiedSnapshot).toBeUndefined();
 expect(run.warnings.join(' ')).toContain('snapshot changed');
 expect(db.prepare('SELECT status FROM tasks').get()).toEqual({status:'failed'});
 expect(db.prepare('SELECT status FROM verification_runs').get()).toEqual({status:'failed'});
});
it('fences a stale run completion after its ownership was replaced', async () => {
 vi.spyOn(facade.verifier,'run').mockImplementationOnce(async () => {
  db.transaction(() => {
   db.prepare("UPDATE verification_runs SET status='failed',ended_at='now',error='superseded' WHERE status='running'").run();
   db.prepare("INSERT INTO verification_runs (id,task_id,status,started_at) VALUES ('replacement','task_1','running','now')").run();
  })();
  return {results:[],readyForReview:true,warnings:[]};
 });
 await expect(facade.verifyTask({taskId:'task_1',checks:[{name:'unit',command:'unused',blocking:true}]})).rejects.toThrow('no longer owns');
 expect(db.prepare('SELECT status FROM tasks').get()).toEqual({status:'verifying'});
 expect(db.prepare("SELECT status FROM verification_runs WHERE id='replacement'").get()).toEqual({status:'running'});
 expect(db.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({n:0});
 expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='verification_failed'").get()).toEqual({n:0});
 expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='verification_discarded'").get()).toEqual({n:1});
});
it('releases its own obsolete lease without overwriting an externally cancelled task', async () => {
 vi.spyOn(facade.verifier,'run').mockImplementationOnce(async () => {
  db.prepare("UPDATE tasks SET status='cancelled'").run();
  return {results:[],readyForReview:true,warnings:[]};
 });
 await expect(facade.verifyTask({taskId:'task_1',checks:[{name:'unit',command:'unused',blocking:true}]})).rejects.toThrow('no longer owns');
 expect(db.prepare('SELECT status FROM tasks').get()).toEqual({status:'cancelled'});
 expect(db.prepare("SELECT count(*) AS n FROM verification_runs WHERE status='running'").get()).toEqual({n:0});
 expect(db.prepare('SELECT count(*) AS n FROM check_results').get()).toEqual({n:0});
});
