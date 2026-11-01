import {afterEach,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DesktopResponseSchema,DesktopMethods,type DesktopMethod,type DesktopParams,type DesktopResult} from '@adw/contracts';
import {fixture,git,FakeAdapter} from '../../supervisor/tests/helpers.js';
import {DesktopCoreService} from '../src/ipc/server.js';
import {DesktopPipeTransport,DESKTOP_FRAME_BYTES} from '../src/ipc/transport.js';
let f:Awaited<ReturnType<typeof fixture>>,service:DesktopCoreService;
async function request<M extends DesktopMethod>(method:M,params:DesktopParams<M>,authorized=false):Promise<DesktopResult<M>>{
 const response=DesktopResponseSchema.parse(await service.handle({id:randomUUID(),method,params},{humanAuthorized:authorized}));
 if(!response.ok)throw new Error(response.error.message);
 return DesktopMethods[method].result.parse(response.result) as DesktopResult<M>;
}
const open=()=>request('project.open',{path:f.repo});
async function draft(){const project=await open();return request('task.createDraft',{projectId:project.id,baseBranch:'main',intent:'Keep the approved intent',acceptance:['  exact acceptance\nsecond line  '],outOfScope:['Do not change main'],checks:f.input.checks,limits:{...f.input.limits,maxFixCycles:1}});}
const lock=(task:Awaited<ReturnType<typeof draft>>,authorized=true)=>request('task.confirmSpec',{taskId:task.spec.id,expectedSpecHash:task.specHash,expectedPolicyHash:task.policyHash},authorized);
async function terminal(taskId:string){for(let n=0;n<1500;n++){const task=await request('task.get',{taskId});if(task.run&&!task.run.active)return task;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Desktop run did not settle');}
beforeEach(async()=>{f=await fixture();service=new DesktopCoreService({dataDir:join(f.root,'desktop'),adapters:[f.adapter]});});
afterEach(async()=>{await service?.close();f?.close();});
it('opens a real repository with current Git status and never starts an agent',async()=>{
 const project=await open();expect(project.baseBranch).toBe('main');expect(project.head).toBe(await git(f.repo,'rev-parse','HEAD'));expect(project.dirty).toBe(false);expect(project.tasks).toEqual([]);expect(project.worktrees).toHaveLength(1);expect(f.adapter.calls).toEqual([]);
 writeFileSync(join(f.repo,'local.txt'),'uncommitted');expect((await request('project.getStatus',{projectId:project.id})).dirty).toBe(true);
});
it('validates envelopes, method allowlist, strict parameters and human authorization',async()=>{
 const task=await draft();await expect(lock(task,false)).rejects.toThrow('Native human confirmation');
 for(const raw of [{id:randomUUID(),method:'__proto__',params:{}},{id:randomUUID(),method:'task.get',params:{taskId:task.spec.id,approvedBy:'intruder'}},{id:randomUUID(),method:'core.health',params:{},humanAuthorized:true}])expect(await service.handle(raw)).toMatchObject({ok:false});
 expect(await request('core.health',{})).toEqual({status:'ok'});
});
it('locks exact raw acceptance together with the approved execution policy',async()=>{
 const task=await draft(),locked=await lock(task);expect(locked.spec.acceptance).toEqual(['  exact acceptance\nsecond line  ']);expect(locked.spec.status).toBe('locked');
 await expect(request('task.updateDraft',{taskId:task.spec.id,projectId:task.spec.projectId,baseBranch:'main',intent:'change',acceptance:['change'],outOfScope:[],checks:task.policy.checks,limits:task.policy.limits})).rejects.toThrow('Approved spec');
 expect(()=>service.db.prepare("UPDATE desktop_task_policies SET policy_json='{}' WHERE task_id=?").run(task.spec.id)).toThrow('immutable');
 expect(()=>service.db.prepare('DELETE FROM desktop_task_policies WHERE task_id=?').run(task.spec.id)).toThrow('immutable');
});
it('rejects stale policy/spec previews without partially approving either',async()=>{
 const task=await draft();await expect(request('task.confirmSpec',{taskId:task.spec.id,expectedSpecHash:task.specHash,expectedPolicyHash:'f'.repeat(64)},true)).rejects.toThrow('policy changed');
 await expect(request('task.confirmSpec',{taskId:task.spec.id,expectedSpecHash:'f'.repeat(64),expectedPolicyHash:task.policyHash},true)).rejects.toThrow();
 expect(service.db.prepare('SELECT approved_at FROM desktop_task_policies').get()).toEqual({approved_at:null});expect((await request('task.get',{taskId:task.spec.id})).spec.status).toBe('draft');
});
it('edits a draft, resolves branch SHA and refuses drafts without blocking checks',async()=>{
 const task=await draft();const input={taskId:task.spec.id,projectId:task.spec.projectId,baseBranch:'main',intent:'new intent',acceptance:['new criterion'],outOfScope:[],checks:task.policy.checks,limits:task.policy.limits};
 const edited=await request('task.updateDraft',input);expect(edited.spec.intent).toBe('new intent');expect(edited.spec.baseCommit).toBe(await git(f.repo,'rev-parse','HEAD'));expect(edited.specHash).not.toBe(task.specHash);
 await expect(request('task.updateDraft',{...input,checks:input.checks.map(check=>({...check,blocking:false}))})).rejects.toThrow('required check');expect((await request('task.get',{taskId:task.spec.id})).spec.intent).toBe('new intent');
});
it('enforces selected project scope and rejects repositories containing application data',async()=>{
 const task=await draft();const other=join(f.root,'other');mkdirSync(other);await git(other,'init','-b','main');await git(other,'-c','user.name=ADW','-c','user.email=adw@test','commit','--allow-empty','-m','base');await request('project.open',{path:other});
 await expect(request('task.get',{taskId:task.spec.id})).rejects.toThrow('open project');
 const nested=new DesktopCoreService({dataDir:join(f.repo,'adw-data')});try{expect(await nested.handle({id:randomUUID(),method:'project.open',params:{path:f.repo}})).toMatchObject({ok:false,error:{message:expect.stringContaining('outside')}});}finally{await nested.close();}
});
it('blocks execution until lock and respects a restrictive project privacy mode',async()=>{
 const task=await draft();await expect(request('task.start',{taskId:task.spec.id})).rejects.toThrow('not approved');await lock(task);
 await request('project.setPrivacy',{projectId:task.spec.projectId,privacyMode:'local-only'});await expect(request('task.start',{taskId:task.spec.id})).rejects.toThrow('privacy mode');expect(f.adapter.calls).toHaveLength(0);
});
it('runs existing supervisor, verification and review through typed desktop methods without touching main',async()=>{
 const task=await draft();await lock(task);const main=await git(f.repo,'rev-parse','HEAD');const started=await request('task.start',{taskId:task.spec.id});expect(started.runId).toBeTruthy();const done=await terminal(task.spec.id);expect(done.spec.status).toBe('ready_for_review');expect(done.run?.tokens).toBeGreaterThan(0);expect(f.adapter.calls).toHaveLength(1);
 const checks=await request('verification.getMatrix',{taskId:task.spec.id});expect(checks.length).toBeGreaterThan(0);expect(checks.every(check=>check.exitCode===0&&!check.notVerified)).toBe(true);
 const review=await request('review.getVerdict',{taskId:task.spec.id});expect(review.verdict?.status).toBe('approved');expect(review.diff).toContain('good');expect(await git(f.repo,'rev-parse','HEAD')).toBe(main);expect(readFileSync(join(f.repo,'value.txt'),'utf8')).toBe('base');
 const ref=checks[0]!.artifacts[0]!.ref;const evidence=await request('evidence.read',{taskId:task.spec.id,ref,offset:0,length:3});expect(Buffer.from(evidence.data,'base64').toString()).toBe('goo');expect(evidence.totalBytes).toBe(4);
 const events=await request('task.subscribeEvents',{taskId:task.spec.id});expect(events.events.length).toBeGreaterThan(0);expect((await request('task.subscribeEvents',{taskId:task.spec.id,after:events.cursor})).cursor).toBeGreaterThanOrEqual(events.cursor);
 await expect(request('review.acceptPatch',{taskId:task.spec.id,reviewId:review.verdict!.id})).rejects.toThrow('Native human confirmation');
 const receipt=await request('review.acceptPatch',{taskId:task.spec.id,reviewId:review.verdict!.id},true);expect(receipt.status).toBe('accepted');expect(await git(f.repo,'rev-parse','HEAD')).toBe(main);
},25000);
it('serves only evidence bound to the requested task and rejects stale cancellation',async()=>{
 const task=await draft();await expect(request('evidence.read',{taskId:task.spec.id,ref:'sha256:'+'f'.repeat(64),offset:0,length:10})).rejects.toThrow('does not belong');
 await expect(request('task.cancel',{taskId:task.spec.id,runId:'stale'})).rejects.toThrow('no longer controlled');
});
it('provides indexed context with provenance, never fabricating cache-hit percentages',async()=>{
 const task=await draft();const map=await request('context.getProjectMap',{taskId:task.spec.id});expect(map.baseCommit).toBe(task.spec.baseCommit);expect(map.files.some(file=>file.path==='value.txt')).toBe(true);expect(map.cacheHits).toBe(0);expect(map.complete).toBe(true);expect(await request('context.getDecisions',{taskId:task.spec.id})).toEqual([]);
 await expect(request('context.getArtifact',{taskId:task.spec.id,artifactId:'art_missing'})).rejects.toThrow('not visible');
});
it('rejects a locked but unstarted task through a durable human action',async()=>{
 const task=await draft();await lock(task);await expect(request('review.rejectPatch',{taskId:task.spec.id,reason:'No longer needed'})).rejects.toThrow('Native human confirmation');
 expect(await request('review.rejectPatch',{taskId:task.spec.id,reason:'No longer needed'},true)).toEqual({taskId:task.spec.id,status:'rejected',reason:'No longer needed'});expect((await request('task.get',{taskId:task.spec.id})).spec.status).toBe('rejected');expect(service.db.prepare('SELECT status FROM desktop_rejections').get()).toEqual({status:'finished'});
 await expect(request('task.start',{taskId:task.spec.id})).rejects.toThrow();
});
it('reassembles split UTF-8 frames and requires the private host token on pipe authorization',async()=>{
 const task=await draft(),output:unknown[]=[],token='host-secret-'.repeat(4),pipe=new DesktopPipeTransport(service,value=>output.push(value),token);
 const frame=(authorization?:string)=>Buffer.from(JSON.stringify({id:randomUUID(),method:'task.confirmSpec',params:{taskId:task.spec.id,expectedSpecHash:task.specHash,expectedPolicyHash:task.policyHash},...(authorization?{authorization}:{})})+'\n');
 await pipe.feed(frame('wrong'));expect(output[0]).toMatchObject({ok:false});await pipe.feed(frame(token));expect(output[1]).toMatchObject({ok:true});
 const health=Buffer.from(JSON.stringify({id:randomUUID(),method:'core.health',params:{}})+'\n');await pipe.feed(health.subarray(0,8));await pipe.feed(health.subarray(8));expect(output[2]).toMatchObject({ok:true,result:{status:'ok'}});await pipe.end();expect(JSON.stringify(output)).not.toContain(token);
});
it('recovers after malformed frames and fails closed on oversized or incomplete messages',async()=>{
 const output:unknown[]=[],pipe=new DesktopPipeTransport(service,value=>output.push(value));await pipe.feed(Buffer.from('not-json\n'));await pipe.feed(Buffer.from(JSON.stringify({id:randomUUID(),method:'core.health',params:{}})+'\n'));expect(output).toMatchObject([{ok:false,error:{code:'invalid_frame'}},{ok:true}]);
 await pipe.feed(Buffer.from('{'));await pipe.end();expect(output.at(-1)).toMatchObject({ok:false,error:{message:expect.stringContaining('Incomplete')}});
 const oversized=new DesktopPipeTransport(service,()=>{});await expect(oversized.feed(Buffer.alloc(DESKTOP_FRAME_BYTES+1,65))).rejects.toThrow('exceeds');await expect(oversized.feed(Buffer.from('\n'))).rejects.toThrow('closed');
});

it('cancels only the owned active run and refuses a concurrent project switch',async()=>{
 await service.close();const adapter=new FakeAdapter('hang');service=new DesktopCoreService({dataDir:join(f.root,'desktop-hang'),adapters:[adapter]});
 const task=await draft();await lock(task);const run=await request('task.start',{taskId:task.spec.id});
 await expect(request('project.open',{path:f.repo})).rejects.toThrow('Stop the current task');
 await expect(request('task.cancel',{taskId:task.spec.id,runId:'wrong'})).rejects.toThrow('no longer controlled');
 expect(await request('task.cancel',{taskId:task.spec.id,runId:run.runId})).toEqual({cancelled:true});expect((await terminal(task.spec.id)).spec.status).toBe('cancelled');
},20000);
it('rejects a completed task worktree without changing the repository main checkout',async()=>{
 const task=await draft();await lock(task);await request('task.start',{taskId:task.spec.id});const done=await terminal(task.spec.id);expect(done.spec.status).toBe('ready_for_review');const before=await git(f.repo,'rev-parse','HEAD');
 await request('review.rejectPatch',{taskId:task.spec.id,reason:'Human rejects the proposal'},true);expect((await request('task.get',{taskId:task.spec.id})).spec.status).toBe('rejected');expect(await git(f.repo,'rev-parse','HEAD')).toBe(before);expect((await request('project.getStatus',{projectId:task.spec.projectId})).worktrees).toHaveLength(1);
},25000);
it('serializes concurrent project mutations in request order',async()=>{
 const task=await draft();const input={taskId:task.spec.id,projectId:task.spec.projectId,baseBranch:'main',intent:'concurrent update',acceptance:['updated criterion'],outOfScope:[],checks:task.policy.checks,limits:task.policy.limits};
 const edited=request('task.updateDraft',input),stale=lock(task);expect((await edited).spec.intent).toBe('concurrent update');await expect(stale).rejects.toThrow('Spec changed');expect((await request('task.get',{taskId:task.spec.id})).spec.status).toBe('draft');
});
it('keeps a reconciliation claim when worktree deletion succeeds but the final database write fails',async()=>{
 const task=await draft();await lock(task);await request('task.start',{taskId:task.spec.id});expect((await terminal(task.spec.id)).spec.status).toBe('ready_for_review');
 service.db.exec("CREATE TRIGGER test_rejection_finalize_failure BEFORE UPDATE ON desktop_rejections WHEN NEW.status='finished' BEGIN SELECT RAISE(ABORT,'simulated disk/write failure'); END");
 await expect(request('review.rejectPatch',{taskId:task.spec.id,reason:'Reject'},true)).rejects.toThrow('reconciliation');expect(service.db.prepare('SELECT status FROM desktop_rejections').get()).toEqual({status:'running'});expect((await request('task.get',{taskId:task.spec.id})).spec.status).toBe('reviewing');expect((await request('project.getStatus',{projectId:task.spec.projectId})).worktrees).toHaveLength(1);
 await expect(request('review.rejectPatch',{taskId:task.spec.id,reason:'Reject again'},true)).rejects.toThrow();
},25000);
it('restores a task only when worktree removal failed before any Git deletion',async()=>{
 const task=await draft();await lock(task);await request('task.start',{taskId:task.spec.id});expect((await terminal(task.spec.id)).spec.status).toBe('ready_for_review');
 service.db.prepare("UPDATE supervisor_runs SET state_json=json_set(state_json,'$.worktree.path',?) WHERE task_id=?").run(f.repo,task.spec.id);
 await expect(request('review.rejectPatch',{taskId:task.spec.id,reason:'Reject'},true)).rejects.toThrow();expect(service.db.prepare('SELECT status FROM desktop_rejections').get()).toEqual({status:'failed'});expect((await request('task.get',{taskId:task.spec.id})).spec.status).toBe('ready_for_review');expect(readFileSync(join(f.repo,'value.txt'),'utf8')).toBe('base');expect((await request('project.getStatus',{projectId:task.spec.projectId})).worktrees).toHaveLength(2);
},25000);
