import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,realpathSync,readFileSync,existsSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type Database from 'better-sqlite3';
import {DesktopMethods,DesktopEnvelopeSchema,DesktopHumanMethods,DesktopPolicySchema,DesktopProjectSchema,DesktopTaskSchema,DesktopContextSchema,ReviewVerdictSchema,AcceptanceCoverageSchema,AdwConfigSchema,type DesktopPolicy,type DesktopTask,type DesktopCheck,type DesktopMethod,type DesktopProject,type Worktree} from '@adw/contracts';
import {GitWorktreeManager,resolveBaseCommit,rejectPatch} from '@adw/git';
import {EvidenceStore,VerifierRunner,redactWebConfig,listChangedTestPaths} from '@adw/verifier';
import {ProjectIndexer,stableJson,isInside} from '@adw/context';
import {readSpec,specHash,confirmSpec,type SupervisorResult} from '@adw/supervisor';
import {CodexAdapter,ClaudeCodeAdapter,type AgentAdapter} from '@adw/cli-adapters';
import {openDb,migrate} from '../db/client.js';
import {createSupervisor} from '../services/supervisor-facade.js';
import {ContextFacade} from '../services/context-facade.js';
import {acceptReviewedPatch} from '../services/review-acceptance.js';
import {projectGit} from './git-status.js';
const hash=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
const defaultPolicy=():DesktopPolicy=>DesktopPolicySchema.parse({checks:[{name:'typecheck',command:'pnpm typecheck',blocking:true},{name:'unit',command:'pnpm test',blocking:true}],limits:{wallTimeMs:300000,sessionTimeoutMs:120000,bundleTokens:8000,maxFixCycles:3},privacyMode:'cli-subscription'});
interface ProjectScope {id:string;path:string;dataDir:string;manager:GitWorktreeManager;evidence:EvidenceStore;policy:DesktopPolicy;agents:string[]}
export class DesktopCoreService {
 readonly db:Database.Database;
 readonly dataDir:string;
 private project?:ProjectScope;
 private closed=false;
 private requests:Promise<unknown>=Promise.resolve();
 private active=new Map<string,{runId:string;controller:AbortController;promise:Promise<SupervisorResult>}>();
 private evidenceCache=new Map<string,Buffer>();
 private cachedBytes=0;
 constructor(input:{dataDir:string;adapters?:readonly AgentAdapter[]}){
  mkdirSync(resolve(input.dataDir),{recursive:true,mode:0o700});this.dataDir=realpathSync(input.dataDir);this.db=openDb(join(this.dataDir,'adw.sqlite'));try{migrate(this.db);}catch(error){this.db.close();throw error;}this.adapters=input.adapters;
 }
 private readonly adapters?:readonly AgentAdapter[];
 private audit(action:string,payload:unknown){this.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'desktop-user',action,JSON.stringify(payload));}
 private selected(projectId?:string):ProjectScope{if(!this.project||projectId&&this.project.id!==projectId)throw new Error('Project is not open in this session');return this.project;}
 private task(taskId:string){const p=this.selected(),row=this.db.prepare('SELECT status FROM tasks WHERE id=? AND project_id=?').get(taskId,p.id) as {status:string}|undefined;if(!row)throw new Error('Task does not belong to the open project');return {project:p,status:row.status,spec:readSpec(this.db,taskId)};}
 private policy(taskId:string):DesktopPolicy{const row=this.db.prepare('SELECT policy_json FROM desktop_task_policies WHERE task_id=?').get(taskId) as {policy_json:string}|undefined;if(!row)throw new Error('Task has no desktop execution policy');return DesktopPolicySchema.parse(JSON.parse(row.policy_json));}
 private publicPolicy(policy:DesktopPolicy):DesktopPolicy{return DesktopPolicySchema.parse({...policy,...(policy.web?{web:redactWebConfig(policy.web)}:{})});}
 handle(raw:unknown,authority:{humanAuthorized?:boolean}={}):Promise<unknown>{
  const request=this.requests.then(()=>this.handleOne(raw,authority));
  this.requests=request.catch(()=>{});return request;
 }
 private async handleOne(raw:unknown,authority:{humanAuthorized?:boolean}):Promise<unknown>{
  let id='00000000-0000-4000-8000-000000000000';
  try{
   if(this.closed)throw new Error('Core is closed');
   if(Buffer.byteLength(JSON.stringify(raw))>2*1024*1024)throw new Error('IPC request exceeds limit');
   const envelope=DesktopEnvelopeSchema.parse(raw);id=envelope.id;
   if(!Object.hasOwn(DesktopMethods,envelope.method))throw new Error('Unknown IPC method');
   const method=envelope.method as DesktopMethod,definition=DesktopMethods[method];const params=definition.params.parse(envelope.params);
   if(DesktopHumanMethods.has(method)&&!authority.humanAuthorized)throw new Error('Native human confirmation is required');
   const result=definition.result.parse(await this.dispatch(method,params));
   const response={id,ok:true,result};if(Buffer.byteLength(JSON.stringify(response))>2*1024*1024)throw new Error('IPC response exceeds limit; narrow the request');return response;
  }catch(error){return {id,ok:false,error:{code:'request_failed',message:(error instanceof Error?error.message:'Request failed').slice(0,4000)}};}
 }
 async openProject(path:string):Promise<DesktopProject>{
  if(this.active.size)throw new Error('Stop the current task before changing projects');
  const root=realpathSync(path);if(isInside(root,this.dataDir))throw new Error('Application data must be outside the selected repository');
  if(realpathSync(await projectGit(root,['rev-parse','--show-toplevel']))!==root)throw new Error('Select the Git repository root');
  const branches=(await projectGit(root,['for-each-ref','--format=%(refname:short)','refs/heads/'])).split('\n').filter(Boolean);if(!branches.length)throw new Error('Repository has no local branches');
  let baseBranch=await projectGit(root,['symbolic-ref','--short','HEAD']).catch(()=>branches[0]!);if(!branches.includes(baseBranch))baseBranch=branches[0]!;
  const dataDir=join(this.dataDir,'projects',hash(root)),manager=new GitWorktreeManager(root,join(dataDir,'git'));let policy=defaultPolicy(),agents=['codex','claude-code'];
  const configPath=join(root,'adw.config.json');if(existsSync(configPath)){
   const stat=lstatSync(configPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw new Error('Invalid project configuration file');
   const config=AdwConfigSchema.parse(JSON.parse(readFileSync(configPath,'utf8')));policy=DesktopPolicySchema.parse({...policy,checks:Object.entries(config.verifier.commands).map(([name,command])=>({name,command,blocking:true})),web:config.verifier.web,privacyMode:config.privacyMode});agents=config.agents;
  }
  let row=this.db.prepare('SELECT id FROM projects WHERE path=?').get(root) as {id:string}|undefined;
  if(!row){row={id:'proj_'+randomUUID()};this.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(row.id,root,baseBranch,new Date().toISOString());}
  const saved=this.db.prepare('SELECT privacy_mode FROM desktop_project_settings WHERE project_id=?').get(row.id) as {privacy_mode:DesktopPolicy['privacyMode']}|undefined;if(saved)policy.privacyMode=saved.privacy_mode;
  this.project={id:row.id,path:root,dataDir,manager,evidence:new EvidenceStore(join(dataDir,'evidence')),policy,agents};this.evidenceCache.clear();this.cachedBytes=0;this.audit('desktop_project_opened',{projectId:row.id,path:root});return this.projectStatus(row.id);
 }
 async projectStatus(id:string):Promise<DesktopProject>{
  const p=this.selected(id),branches=(await projectGit(p.path,['for-each-ref','--format=%(refname:short)','refs/heads/'])).split('\n').filter(Boolean);
  const branch=await projectGit(p.path,['symbolic-ref','--short','HEAD']).catch(()=>branches[0]!);
  const tasks=this.db.prepare('SELECT id,intent,status FROM tasks WHERE project_id=? ORDER BY rowid DESC LIMIT 100').all(p.id) as {id:string;intent:string;status:string}[];
  return DesktopProjectSchema.parse({id:p.id,path:p.path,baseBranch:branch,branches,head:await projectGit(p.path,['rev-parse','HEAD']),dirty:!!await projectGit(p.path,['status','--porcelain','--untracked-files=all']),worktrees:await p.manager.list(),privacyMode:p.policy.privacyMode,policy:this.publicPolicy(p.policy),tasks:tasks.map(task=>({...task,intent:task.intent.slice(0,160)}))});
 }
 taskView(taskId:string):DesktopTask{
  const {spec,status}=this.task(taskId),policy=this.policy(taskId);const row=this.db.prepare('SELECT * FROM supervisor_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as {id:string;state:string;state_json:string;active:number;started_at:string}|undefined;
  let run:unknown=null;
  if(row){const value=JSON.parse(row.state_json);const usage=this.db.prepare("SELECT json_extract(payload_json,'$.recordId') AS session,MAX(json_extract(payload_json,'$.event.tokens')) AS tokens,MAX(json_extract(payload_json,'$.event.cost')) AS cost FROM audit_events WHERE action='agent_event' AND json_extract(payload_json,'$.runId')=? AND json_extract(payload_json,'$.event.type')='usage' GROUP BY session").all(row.id) as {tokens:number|null;cost:number|null}[];
   run={id:row.id,state:row.state,active:!!row.active,startedAt:row.started_at,nodes:(value.nodes??[]).map((node:any)=>({id:node.id,instruction:node.instruction,dependsOn:node.dependsOn,status:node.status})),...(value.reason?{reason:value.reason}:{}),...(value.review?{review:value.review}:{}),...(value.worktree?.path?{worktreePath:value.worktree.path}:{}),tokens:usage.some(item=>item.tokens!==null)?usage.reduce((sum,item)=>sum+(item.tokens??0),0):null,cost:usage.some(item=>item.cost!==null)?usage.reduce((sum,item)=>sum+(item.cost??0),0):null};
  }
  return DesktopTaskSchema.parse({spec:{...spec,status},specHash:specHash(spec),policy:this.publicPolicy(policy),policyHash:hash(policy),run});
 }
 private async draft(params:any,update:boolean){
  const p=this.selected(params.projectId);if(update&&this.task(params.taskId).status!=='draft')throw new Error('Approved spec cannot be edited');
  const baseCommit=await resolveBaseCommit(p.path,params.baseBranch),id=update?params.taskId:'task_'+randomUUID(),now=new Date().toISOString();
  const prior=update?this.policy(id):p.policy;const policy=DesktopPolicySchema.parse({...prior,checks:params.checks,limits:params.limits,privacyMode:p.policy.privacyMode});
  this.db.transaction(()=>{
   if(update){if(this.db.prepare("UPDATE tasks SET intent=?,acceptance_json=?,out_of_scope_json=?,base_branch=?,base_commit=?,updated_at=? WHERE id=? AND project_id=? AND status='draft'").run(params.intent,JSON.stringify(params.acceptance),JSON.stringify(params.outOfScope),params.baseBranch,baseCommit,now,id,p.id).changes!==1)throw new Error('Draft changed or was approved');this.db.prepare('UPDATE desktop_task_policies SET policy_json=?,policy_hash=? WHERE task_id=?').run(stableJson(policy),hash(policy),id);}
   else{this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,p.id,params.intent,JSON.stringify(params.acceptance),JSON.stringify(params.outOfScope),params.baseBranch,baseCommit,'draft',now,now);this.db.prepare('INSERT INTO desktop_task_policies VALUES (?,?,?,NULL)').run(id,stableJson(policy),hash(policy));}
   this.audit(update?'desktop_draft_updated':'desktop_draft_created',{taskId:id,policyHash:hash(policy)});
  }).immediate();return this.taskView(id);
 }
 private async start(taskId:string){
  const {project:p}=this.task(taskId),policy=this.policy(taskId);
  if(p.policy.privacyMode!=='cli-subscription'||policy.privacyMode!=='cli-subscription')throw new Error('CLI execution is not allowed by this task/project privacy mode');
  const row=this.db.prepare('SELECT approved_at,policy_hash FROM desktop_task_policies WHERE task_id=?').get(taskId) as {approved_at:string|null;policy_hash:string};if(!row.approved_at||row.policy_hash!==hash(policy))throw new Error('Execution policy is not approved');
  if(this.active.size)throw new Error('The desktop scheduler runs one task at a time');
  const adapters=(this.adapters??[new CodexAdapter({logDir:join(p.dataDir,'sessions')}),new ClaudeCodeAdapter({logDir:join(p.dataDir,'sessions')})]).filter(adapter=>p.agents.includes(adapter.id));
  const controller=new AbortController(),supervisor=createSupervisor({db:this.db,manager:p.manager,verifier:new VerifierRunner(p.evidence),adapters,dataDir:join(p.dataDir,'context')});
  const promise=supervisor.run({taskId,checks:policy.checks,limits:policy.limits,web:policy.web,signal:controller.signal});void promise.catch(()=>{});
  const run=this.db.prepare('SELECT id FROM supervisor_runs WHERE task_id=? AND active=1').get(taskId) as {id:string}|undefined;if(!run){await promise;throw new Error('Task did not start');}
  this.active.set(taskId,{runId:run.id,controller,promise});void promise.finally(()=>{if(this.active.get(taskId)?.runId===run.id)this.active.delete(taskId);}).catch(()=>{});return {runId:run.id};
 }
 matrix(taskId:string):DesktopCheck[]{
  const {project:p}=this.task(taskId);const rows=this.db.prepare('SELECT * FROM check_results WHERE task_id=? ORDER BY rowid DESC LIMIT 2000').all(taskId) as any[];
  return rows.map(row=>{const refs=JSON.parse(row.artifacts_json) as string[];const types=new Map<string,{mediaType:string;role:string}>();if(refs[3])try{const manifest=JSON.parse(p.evidence.get(refs[3]).toString());for(const artifact of manifest.artifacts??[])types.set(artifact.ref,{mediaType:artifact.mediaType,role:artifact.role});}catch{}
   let coverage:any[]=[];if(row.coverage)try{coverage=JSON.parse(row.coverage).map((item:unknown)=>AcceptanceCoverageSchema.parse(item));}catch{}
   return {id:row.id,name:row.name,command:row.command,exitCode:row.exit_code,durationMs:row.duration_ms,notVerified:!!row.not_verified,blocking:!!row.blocking,baseCommit:row.base_commit,coverage,artifacts:refs.map((ref,index)=>({ref,...(types.get(ref)??{mediaType:index<3?'text/plain':'application/json',role:['stdout','stderr','metadata','manifest'][index]??'evidence'})}))};
  });
 }
 private evidence(taskId:string,ref:string):Buffer{
  const {project:p}=this.task(taskId);const refs=new Set(this.matrix(taskId).flatMap(check=>check.artifacts.map(artifact=>artifact.ref)));for(const row of this.db.prepare('SELECT evidence_ref,verdict_json FROM review_runs WHERE task_id=?').all(taskId) as {evidence_ref:string;verdict_json:string}[]){refs.add(row.evidence_ref);for(const item of ReviewVerdictSchema.parse(JSON.parse(row.verdict_json)).evidenceRefs)refs.add(item);}
  if(!refs.has(ref))throw new Error('Evidence does not belong to this task');
  let content=this.evidenceCache.get(ref);if(!content){content=p.evidence.get(ref);if(content.length>16*1024*1024)throw new Error('Evidence exceeds desktop viewer limit');while(this.evidenceCache.size&&(this.evidenceCache.size>=8||this.cachedBytes+content.length>64*1024*1024)){const first=this.evidenceCache.keys().next().value!;this.cachedBytes-=this.evidenceCache.get(first)!.length;this.evidenceCache.delete(first);}this.evidenceCache.set(ref,content);this.cachedBytes+=content.length;}return content;
 }
 private async context<T>(taskId:string,callback:(facade:ContextFacade)=>T|Promise<T>):Promise<T>{
  const {project:p,spec}=this.task(taskId),run=this.latestRun(taskId),worktree=run?.worktree as Worktree|undefined;let source=p.path,binding:Worktree|undefined;
  if(worktree&&existsSync(worktree.path)){await p.manager.assertManaged(worktree);source=worktree.path;binding=worktree;}
  const directory=join(p.dataDir,'desktop-context',hash({taskId,source}));mkdirSync(directory,{recursive:true});const index=await ProjectIndexer.build({projectId:p.id,repoPath:source,baseCommit:spec.baseCommit,dbPath:join(directory,'index.sqlite')});
  try{const facade=await ContextFacade.create(this.db,index,{dataDir:join(p.dataDir,'context'),worktree:binding,evidenceStore:p.evidence});return await callback(facade);}finally{index.close();}
 }
 private latestRun(taskId:string):any{this.task(taskId);const row=this.db.prepare('SELECT state_json FROM supervisor_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as {state_json:string}|undefined;return row?JSON.parse(row.state_json):undefined;}
 private async reject(taskId:string,reason:string){
  const {project:p,status}=this.task(taskId);const worktree=this.latestRun(taskId)?.worktree as Worktree|undefined;const id=randomUUID(),now=new Date().toISOString();
  this.db.transaction(()=>{if(this.db.prepare('SELECT 1 FROM supervisor_runs WHERE task_id=? AND active=1').get(taskId)||this.db.prepare("SELECT 1 FROM review_acceptances WHERE task_id=? AND status IN ('running','accepted')").get(taskId))throw new Error('Task operation is active or already accepted');if(!['locked','ready_for_review','needs_human','failed','cancelled'].includes(status))throw new Error('Task cannot be rejected in its current state');if(this.db.prepare("UPDATE tasks SET status='reviewing',updated_at=? WHERE id=? AND status=?").run(now,taskId,status).changes!==1)throw new Error('Task state changed');this.db.prepare("INSERT INTO desktop_rejections VALUES (?,?,'running',?,?,?,NULL)").run(id,taskId,status,reason,now);}).immediate();
  let removed=false;
  try{const receipt=worktree?await rejectPatch(p.manager,worktree,reason):{taskId,status:'rejected' as const,reason};removed=true;this.db.transaction(()=>{if(this.db.prepare("UPDATE desktop_rejections SET status='finished',ended_at=? WHERE id=? AND status='running'").run(new Date().toISOString(),id).changes!==1)throw new Error('Rejection claim lost');if(this.db.prepare("UPDATE tasks SET status='rejected',updated_at=? WHERE id=? AND status='reviewing'").run(new Date().toISOString(),taskId).changes!==1)throw new Error('Task state changed; reconcile rejected worktree');this.audit('human_patch_rejected',{taskId,receipt});}).immediate();return receipt;}
  catch(error){if(removed)throw new Error('Worktree rejection completed; database reconciliation is required', {cause:error});this.db.transaction(()=>{const own=this.db.prepare("UPDATE desktop_rejections SET status='failed',ended_at=? WHERE id=? AND status='running'").run(new Date().toISOString(),id);if(own.changes)this.db.prepare("UPDATE tasks SET status=?,updated_at=? WHERE id=? AND status='reviewing'").run(status,new Date().toISOString(),taskId);}).immediate();throw error;}
 }
 private async dispatch(method:DesktopMethod,params:any):Promise<unknown>{
  switch(method){
   case 'core.health':return {status:'ok'};
   case 'project.pick':throw new Error('Folder picker is owned by the desktop host');
   case 'project.open':return this.openProject(params.path);
   case 'project.getStatus':return this.projectStatus(params.projectId);
   case 'project.setPrivacy':{const p=this.selected(params.projectId);if(this.active.size)throw new Error('Stop the active task before changing privacy mode');this.db.prepare('INSERT INTO desktop_project_settings VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET privacy_mode=excluded.privacy_mode').run(p.id,params.privacyMode);p.policy.privacyMode=params.privacyMode;return this.projectStatus(p.id);}
   case 'task.createDraft':return this.draft(params,false);
   case 'task.updateDraft':return this.draft(params,true);
   case 'task.get':return this.taskView(params.taskId);
   case 'task.confirmSpec':{this.task(params.taskId);this.db.transaction(()=>{const policy=this.policy(params.taskId);if(hash(policy)!==params.expectedPolicyHash)throw new Error('Execution policy changed since preview');confirmSpec(this.db,{taskId:params.taskId,expectedSpecHash:params.expectedSpecHash,approvedBy:'desktop-user'});this.db.prepare('UPDATE desktop_task_policies SET approved_at=COALESCE(approved_at,?) WHERE task_id=?').run(new Date().toISOString(),params.taskId);}).immediate();return this.taskView(params.taskId);}
   case 'task.start':return this.start(params.taskId);
   case 'task.cancel':{this.task(params.taskId);const run=this.active.get(params.taskId);if(!run||run.runId!==params.runId)throw new Error('The selected run is no longer controlled by this session');run.controller.abort();return {cancelled:true};}
   case 'task.subscribeEvents':{this.task(params.taskId);const rows=this.db.prepare("SELECT rowid AS cursor,at,action,payload_json FROM audit_events WHERE rowid>? AND (json_extract(payload_json,'$.taskId')=? OR json_extract(payload_json,'$.runId') IN (SELECT id FROM supervisor_runs WHERE task_id=?) OR json_extract(payload_json,'$.supervisorRunId') IN (SELECT id FROM supervisor_runs WHERE task_id=?)) ORDER BY rowid LIMIT 100").all(params.after,params.taskId,params.taskId,params.taskId) as any[];return {cursor:rows.at(-1)?.cursor??params.after,events:rows.map(row=>({cursor:row.cursor,at:row.at,action:row.action,payload:row.payload_json.slice(0,16000),truncated:row.payload_json.length>16000}))};}
   case 'verification.getMatrix':return this.matrix(params.taskId);
   case 'evidence.read':{const bytes=this.evidence(params.taskId,params.ref),artifact=this.matrix(params.taskId).flatMap(check=>check.artifacts).find(item=>item.ref===params.ref);return {data:bytes.subarray(params.offset,params.offset+params.length).toString('base64'),totalBytes:bytes.length,mediaType:artifact?.mediaType??'text/plain'};}
   case 'review.getVerdict':{const {project:p}=this.task(params.taskId),run=this.latestRun(params.taskId);const row=this.db.prepare('SELECT verdict_json FROM review_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(params.taskId) as {verdict_json:string}|undefined;const diff=run?.diffRef?p.evidence.get(run.diffRef).toString():'';return {verdict:row?ReviewVerdictSchema.parse(JSON.parse(row.verdict_json)):null,diff:diff.slice(0,512000),truncated:diff.length>512000,changedTests:listChangedTestPaths(diff)};}
   case 'review.acceptPatch':{const {project:p}=this.task(params.taskId),run=this.latestRun(params.taskId);if(!run?.worktree)throw new Error('No task worktree');return acceptReviewedPatch({db:this.db,manager:p.manager,evidenceStore:p.evidence,taskId:params.taskId,reviewId:params.reviewId,approvedBy:'desktop-user',worktree:run.worktree});}
   case 'review.rejectPatch':return this.reject(params.taskId,params.reason);
   case 'context.getProjectMap':return this.context(params.taskId,facade=>{const api=facade.forTask(params.taskId),map=api.read.getProjectMap(),decisions=api.read.getDecisions({history:true});return DesktopContextSchema.parse({snapshotId:map.snapshotId,baseCommit:map.baseCommit,complete:map.complete,fileCount:map.files.length,symbolCount:map.symbols.length,warnings:map.warnings.map(warning=>JSON.stringify(warning)).slice(0,100),files:map.files.slice(0,200).map(file=>({path:file.path,hash:file.contentHash})),decisions:decisions.slice(0,100).map(artifact=>{const read=api.read.getArtifact(artifact.id)!;return {id:artifact.id,kind:artifact.kind,confidence:artifact.confidence,baseCommit:artifact.baseCommit,sourcePaths:artifact.sourcePaths,fresh:read.freshness.fresh,reasons:read.freshness.reasons};}),cacheHits:facade.broker.getMetrics().cacheHits,truncated:map.files.length>200||decisions.length>100});});
   case 'context.getDecisions':return DesktopContextSchema.parse(await this.dispatch('context.getProjectMap',params)).decisions;
   case 'context.getArtifact':return this.context(params.taskId,facade=>{const read=facade.forTask(params.taskId).read.getArtifact(params.artifactId);if(!read)throw new Error('Artifact is not visible in this task');return {content:read.content.slice(0,128000),truncated:read.content.length>128000,fresh:read.freshness.fresh};});
  }
 }
 async close(){if(this.closed)return;this.closed=true;await this.requests;for(const run of this.active.values())run.controller.abort();await Promise.allSettled([...this.active.values()].map(run=>run.promise));this.active.clear();this.evidenceCache.clear();this.db.close();}
}
