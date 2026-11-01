import { createHash } from 'node:crypto';
import { mkdirSync,realpathSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { WorktreeSchema,type Worktree } from '@adw/contracts';
import { GitWorktreeManager } from '@adw/git';
import { ArtifactStore,ContextBroker,createContextAPI,ProjectIndexer,isInside,type ContextAPI,type ContextScope } from '@adw/context';
import type { EvidenceStore } from '@adw/verifier';
const sourceBindings=new WeakMap<ProjectIndexer,{root:string;taskId?:string}>();
export interface ContextFacadeOptions {dataDir:string;projectId?:string;evidenceStore?:EvidenceStore;worktree?:Worktree}
export class ContextFacade {
 readonly store:ArtifactStore;readonly broker:ContextBroker;
 private readonly boundTaskId?:string;
 private refreshPromise?:ReturnType<ProjectIndexer['reindexChanged']>;
 constructor(readonly db:Database.Database,readonly index:ProjectIndexer,input:ContextFacadeOptions){
  const projectId=input.projectId??index.projectId;if(projectId!==index.projectId)throw new Error('Index belongs to another project');
  const project=db.prepare('SELECT path FROM projects WHERE id=?').get(projectId) as {path:string}|undefined;if(!project)throw new Error('Project not found');const projectRoot=realpathSync(project.path);
  if(projectRoot!==index.repoPath&&sourceBindings.get(index)?.root!==projectRoot)throw new Error('Use ContextFacade.create to bind a registered project worktree');
  this.boundTaskId=sourceBindings.get(index)?.taskId;
  const root=resolve(input.dataDir);if(isInside(index.repoPath,root)||isInside(projectRoot,root))throw new Error('Context data directory must be outside the repository');mkdirSync(root,{recursive:true,mode:0o700});const canonical=realpathSync(root);if(isInside(index.repoPath,canonical)||isInside(projectRoot,canonical))throw new Error('Context data directory resolves inside the repository');
  const namespace=createHash('sha256').update(projectId+'\0'+projectRoot).digest('hex');
  this.store=new ArtifactStore(db,{projectId,artifactDir:join(canonical,'projects',namespace,'artifacts'),sourceRoot:index.repoPath});
  if(this.store.sourceRoot!==index.repoPath)throw new Error('Project database and index repository differ');
  this.broker=new ContextBroker(this.store,index);this.evidenceStore=input.evidenceStore;
 }
 static async create(db:Database.Database,index:ProjectIndexer,input:ContextFacadeOptions):Promise<ContextFacade>{
  const projectId=input.projectId??index.projectId;
  if(projectId!==index.projectId)throw new Error('Index belongs to another project');
  const project=db.prepare('SELECT path FROM projects WHERE id=?').get(projectId) as {path:string}|undefined;if(!project)throw new Error('Project not found');const root=realpathSync(project.path);
  let taskId:string|undefined;
  if(root!==index.repoPath){
   if(!input.worktree)throw new Error('A registered task-worktree receipt is required');
   const worktree=WorktreeSchema.parse(input.worktree);
   if(realpathSync(worktree.path)!==index.repoPath||worktree.baseCommit!==index.getProjectMap().baseCommit)throw new Error('Worktree receipt differs from the index source');
   const task=db.prepare('SELECT base_commit FROM tasks WHERE id=? AND project_id=?').get(worktree.taskId,projectId) as {base_commit:string}|undefined;
   if(task?.base_commit!==worktree.baseCommit)throw new Error('Worktree does not belong to this task/base');
   const manager=new GitWorktreeManager(root,dirname(dirname(worktree.path)));await manager.assertManaged(worktree);taskId=worktree.taskId;
  }
  sourceBindings.set(index,{root,taskId});
  try{return new ContextFacade(db,index,input);}finally{sourceBindings.delete(index);}
 }
 private readonly evidenceStore?:EvidenceStore;
 refresh():ReturnType<ProjectIndexer['reindexChanged']>{
  if(this.refreshPromise)return this.refreshPromise;
  const refresh=this.index.reindexChanged().then(result=>{this.store.revalidateAgainstIndex(this.index.getProjectMap());return result;});this.refreshPromise=refresh;
  void refresh.finally(()=>{if(this.refreshPromise===refresh)this.refreshPromise=undefined;}).catch(()=>{});return refresh;
 }
 forTask(taskId:string,options:{sessionId?:string;trusted?:boolean}={}):ContextAPI{if(this.boundTaskId&&this.boundTaskId!==taskId)throw new Error('Worktree index belongs to another task');return createContextAPI(this.store,this.index,this.broker,{taskId,...options,beforeBuild:()=>this.refresh()});}
 importCheckEvidence(checkId:string,scope:ContextScope):string[]{
  if(!scope.taskId)throw new Error('Evidence import requires a task scope');const task=this.store.getTask(scope.taskId);
  const check=this.db.prepare('SELECT artifacts_json,exit_code,not_verified,base_commit FROM check_results WHERE id=? AND task_id=?').get(checkId,scope.taskId) as {artifacts_json:string;exit_code:number|null;not_verified:number;base_commit:string|null}|undefined;
  if(!check||check.exit_code!==0||check.not_verified||check.base_commit!==task.baseCommit)throw new Error('Only successful verified check evidence from this task/base can be imported');
  if(!this.evidenceStore)throw new Error('Verification evidence store is not configured');
  const refs=JSON.parse(check.artifacts_json) as string[];for(const ref of refs){const actual=this.store.blobs.put(this.evidenceStore.get(ref));if(actual!==ref)throw new Error('Evidence hash mismatch');}
  this.store.audit('context_evidence_imported',{taskId:scope.taskId,checkId,refs});return refs;
 }
}
