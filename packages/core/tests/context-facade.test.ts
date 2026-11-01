import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type Database from 'better-sqlite3';
import {ProjectIndexer} from '@adw/context';
import {EvidenceStore} from '@adw/verifier';
import {openDb,migrate} from '../src/db/client.js';
import {ContextFacade} from '../src/services/context-facade.js';
let root:string,repo:string,db:Database.Database,index:ProjectIndexer,facade:ContextFacade,evidence:EvidenceStore;
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'adw-context-core-'));repo=join(root,'repo');mkdirSync(repo);writeFileSync(join(repo,'app.ts'),'export const add=(a:number,b:number)=>a+b;');
 db=openDb(join(root,'core.sqlite'));migrate(db);db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_test',repo,'main','now');
 db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_1','proj_test','Keep add correct','["full acceptance"]','[]','main','a'.repeat(40),'locked','now','now');
 index=await ProjectIndexer.build({projectId:'proj_test',repoPath:repo,baseCommit:'a'.repeat(40),dbPath:join(root,'index.sqlite')});evidence=new EvidenceStore(join(root,'verification-evidence'));
 facade=new ContextFacade(db,index,{dataDir:join(root,'context'),evidenceStore:evidence});
});
afterEach(()=>{index?.close();if(db?.open)db.close();rmSync(root,{recursive:true,force:true});});
it('refreshes before bundle builds and preserves acceptance with scoped artifacts',async()=>{
 const api=facade.forTask('task_1'),map=api.read.getProjectMap();const artifact=api.write.publishArtifact({kind:'decision',content:'Use add',sourcePaths:['app.ts'],sourceHashes:{'app.ts':map.files[0]!.contentHash},producerAgent:'codex',confidence:'inferred',visibility:'task'});
 const before=await api.read.buildBundle({agentId:'codex',tokenBudget:3000});expect(before.bundle.selectedArtifacts).toContain(artifact.id);
 writeFileSync(join(repo,'app.ts'),'export const changed=1;');const after=await api.read.buildBundle({agentId:'codex',tokenBudget:3000});expect(after.bundle.acceptance).toEqual(['full acceptance']);expect(after.bundle.selectedArtifacts).not.toContain(artifact.id);expect(api.read.getArtifact(artifact.id)?.freshness.fresh).toBe(false);expect(facade.store.getArtifact(artifact.id)?.invalidatedAt).toBeUndefined();
});
it('coalesces concurrent refresh requests and exposes persisted test history',async()=>{
 const first=facade.refresh(),second=facade.refresh();expect(first).toBe(second);await first;
 const ref=evidence.put('actual successful check output');db.prepare('INSERT INTO check_results (id,task_id,name,command,exit_code,duration_ms,env_fingerprint,artifacts_json,not_verified,blocking,base_commit,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('check_1','task_1','unit','pnpm test',0,1,'env',JSON.stringify([ref]),0,1,'a'.repeat(40),'now');
 expect(facade.forTask('task_1').read.getTestHistory()).toHaveLength(1);expect(facade.importCheckEvidence('check_1',{taskId:'task_1'})).toEqual([ref]);expect(facade.store.blobs.text(ref)).toBe('actual successful check output');
 const map=index.getProjectMap();const trusted=facade.forTask('task_1',{trusted:true});const finding=trusted.write.publishFinding({claim:'Check passed',affectedPaths:['app.ts'],sourcePaths:['app.ts'],sourceHashes:{'app.ts':map.files[0]!.contentHash},producerAgent:'verifier',verificationStatus:'verified',evidenceRefs:[ref]});expect(trusted.write.promoteFinding(finding.id).visibility).toBe('project');
});
it('does not import failed or wrong-base check evidence into verified context',()=>{
 const ref=evidence.put('failure');db.prepare('INSERT INTO check_results (id,task_id,name,command,exit_code,duration_ms,env_fingerprint,artifacts_json,not_verified,blocking,base_commit,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('check_1','task_1','unit','pnpm test',1,1,'env',JSON.stringify([ref]),0,1,'a'.repeat(40),'now');
 expect(()=>facade.importCheckEvidence('check_1',{taskId:'task_1'})).toThrow('successful');db.prepare('UPDATE check_results SET exit_code=0,base_commit=?').run('b'.repeat(40));expect(()=>facade.importCheckEvidence('check_1',{taskId:'task_1'})).toThrow('successful');
});
it('keeps legacy findings visible as missing-provenance history, without enabling promotion',()=>{
 db.prepare('INSERT INTO findings VALUES (?,?,?,?,?,?,?)').run('legacy','task_1','Historical finding','[]','["app.ts"]','inferred','then');
 const result=facade.forTask('task_1').read.getTaskFindings();expect(result[0]?.finding.claim).toBe('Historical finding');expect(result[0]?.freshness).toEqual({fresh:false,reasons:['missing_provenance']});expect(()=>facade.forTask('task_1',{trusted:true}).write.promoteFinding('legacy')).toThrow('provenance');
});
it('binds a registered task worktree explicitly and rejects unrelated source directories',async()=>{
 const {execFile}=await import('node:child_process');
 const git=(cwd:string,...args:string[]):Promise<string>=>new Promise((resolve,reject)=>execFile('git',args,{cwd,encoding:'utf8'},(error,out)=>error?reject(error):resolve(out.trim())));
 await git(repo,'init','-b','main');await git(repo,'config','user.email','adw@test');await git(repo,'config','user.name','ADW');await git(repo,'add','.');await git(repo,'commit','-m','base');const base=await git(repo,'rev-parse','HEAD');db.prepare('UPDATE tasks SET base_commit=?').run(base);
 const {GitWorktreeManager}=await import('@adw/git');const manager=new GitWorktreeManager(repo,join(root,'worktrees-data'));const worktree=await manager.createTaskWorktree({taskId:'task_1'});writeFileSync(join(worktree.path,'app.ts'),'export const worktreeChanged=true;');
 const taskIndex=await ProjectIndexer.build({projectId:'proj_test',repoPath:worktree.path,baseCommit:base,dbPath:join(root,'task-index.sqlite')});
 try{
  expect(()=>new ContextFacade(db,taskIndex,{dataDir:join(root,'context')})).toThrow('registered');
  const context=await ContextFacade.create(db,taskIndex,{dataDir:join(root,'context'),evidenceStore:evidence,worktree});const proof=context.store.blobs.put('independent worktree verification');
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_2','proj_test','other task','["pass"]','[]','main',base,'locked','now','now');expect(()=>context.forTask('task_2')).toThrow('another task');
  const api=context.forTask('task_1',{trusted:true});const finding=api.write.publishFinding({claim:'Worktree fact',affectedPaths:['app.ts'],sourcePaths:['app.ts'],sourceHashes:{'app.ts':taskIndex.getProjectMap().files[0]!.contentHash},producerAgent:'verifier',verificationStatus:'verified',evidenceRefs:[proof]});expect(api.write.promoteFinding(finding.id).visibility).toBe('project');
  expect((await api.read.buildBundle({agentId:'codex',tokenBudget:3000})).bundle.selectedArtifacts.length).toBeGreaterThan(0);
 }finally{taskIndex.close();}
 const unrelated=join(root,'unrelated');mkdirSync(unrelated);writeFileSync(join(unrelated,'app.ts'),'private unrelated source');const wrong=await ProjectIndexer.build({projectId:'proj_test',repoPath:unrelated,baseCommit:base,dbPath:join(root,'wrong-index.sqlite')});try{await expect(ContextFacade.create(db,wrong,{dataDir:join(root,'context')})).rejects.toThrow('registered');}finally{wrong.close();}
});
it('passes a materialized broker bundle through the Codex adapter without model requests',async()=>{
 const {cpSync,chmodSync,readFileSync}=await import('node:fs');const {fileURLToPath}=await import('node:url');const {CodexAdapter}=await import('@adw/cli-adapters');
 const fake=join(root,'fake-cli');cpSync(fileURLToPath(new URL('../../cli-adapters/tests/fixtures/',import.meta.url)),fake,{recursive:true});chmodSync(join(fake,'fake-codex.mjs'),0o700);
 const api=facade.forTask('task_1'),map=index.getProjectMap();const artifact=api.write.publishArtifact({kind:'handoff',content:'Relevant shared context',sourcePaths:['app.ts'],sourceHashes:{'app.ts':map.files[0]!.contentHash},producerAgent:'codex',confidence:'inferred',visibility:'task'});
 const built=await api.read.buildBundle({agentId:'codex',tokenBudget:3000});expect(built.bundle.selectedArtifacts).toContain(artifact.id);
 const adapter=new CodexAdapter({binaryPath:join(fake,'fake-codex.mjs'),logDir:join(root,'agent-logs')});const events=[];
 for await(const event of adapter.startSession({worktreePath:repo,prompt:'Use the approved context',bundlePath:built.bundlePath,timeoutMs:10000}))events.push(event);
 expect(events.at(-1)?.type).toBe('completed');const invocation=JSON.parse(readFileSync(join(repo,'invocation.json'),'utf8'));expect(invocation.prompt).toContain('Relevant shared context');expect(invocation.prompt).toContain('full acceptance');expect(invocation.prompt).toContain(built.bundle.indexSnapshotId);
});
