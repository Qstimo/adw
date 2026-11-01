import type { Finding } from '@adw/contracts';
import { ArtifactStore,type PublishArtifactInput } from './artifacts/store.js';
import { promoteArtifact } from './artifacts/promote.js';
import { artifactFreshness } from './artifacts/invalidation.js';
import { ContextBroker,type BuildBundleInput } from './broker/build-bundle.js';
import { ProjectIndexer } from './indexer/project-indexer.js';
import type { SearchInput } from './types.js';
import { normalizeScope } from './indexer/walk.js';
export type ScopedArtifactInput=Omit<PublishArtifactInput,'projectId'|'taskId'|'baseCommit'|'sessionId'>;
export interface PublishFindingInput {claim:string;affectedPaths:string[];sourcePaths:string[];sourceHashes:Record<string,string>;producerAgent:string;verificationStatus:Finding['verificationStatus'];evidenceRefs?:string[];expiresAt?:string;logicalKey?:string}
export interface ContextAPIOptions {taskId:string;sessionId?:string;trusted?:boolean;beforeBuild?:()=>Promise<unknown>}
export function createContextAPI(store:ArtifactStore,index:ProjectIndexer,broker:ContextBroker,options:ContextAPIOptions){
 if(broker.store!==store||broker.index!==index)throw new Error('Broker is bound to another context service');
 if(store.projectId!==index.projectId||store.sourceRoot!==index.repoPath)throw new Error('Index belongs to another project');
 store.getTask(options.taskId);const scope={taskId:options.taskId,sessionId:options.sessionId};
 const canVerify=options.trusted===true,beforeBuild=options.beforeBuild;
 const noScopeOverride=(input:object,allowBase=false)=>{for(const name of ['projectId','taskId',...(allowBase?[]:['baseCommit']),'sessionId','trusted'])if(Object.hasOwn(input,name))throw new Error('Context scope is bound by the service');};
 const trusted=()=>{if(!canVerify)throw new Error('Independent verification requires a trusted writer');};
 const read={
  getProjectMap(){store.audit('context_project_map_read',{taskId:scope.taskId});return index.getProjectMap();},
  async searchCode(input:SearchInput){store.audit('context_code_searched',{taskId:scope.taskId,query:input.query,scope:input.scope});return index.searchCode(input);},
  getArtifact(id:string){const value=store.readContent(id,scope);if(!value)return undefined;store.audit('context_artifact_read',{taskId:scope.taskId,artifactId:id});return {...value,freshness:artifactFreshness(value.artifact,index.getProjectMap())};},
  getDecisions(input:{paths?:string[];history?:boolean}={}){const paths=input.paths?.map(normalizeScope);store.audit('context_decisions_read',{taskId:scope.taskId,paths,history:input.history??false});return store.getDecisions(scope,index.getProjectMap(),{...input,paths});},
  getTaskFindings(){store.audit('context_findings_read',{taskId:scope.taskId});return store.getTaskFindings(scope.taskId).map(finding=>{const artifact=finding.artifactId?store.getArtifact(finding.artifactId):undefined;return {finding,artifact,freshness:artifact?artifactFreshness(artifact,index.getProjectMap()):{fresh:false,reasons:['missing_provenance']}};});},
  getTestHistory(){store.getTask(scope.taskId);const exists=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='check_results'").get();if(!exists)return [];store.audit('context_test_history_read',{taskId:scope.taskId});return store.db.prepare('SELECT id,name,command,exit_code,duration_ms,env_fingerprint,artifacts_json,coverage,not_verified,blocking,base_commit,created_at FROM check_results WHERE task_id=? ORDER BY rowid DESC LIMIT 100').all(scope.taskId);},
  async buildBundle(input:Omit<BuildBundleInput,'taskId'|'sessionId'>){noScopeOverride(input,true);await beforeBuild?.();return broker.buildBundle({...input,taskId:scope.taskId,sessionId:scope.sessionId});},
 };
 const write={
  publishArtifact(input:ScopedArtifactInput){noScopeOverride(input);if(input.confidence==='verified'||input.visibility==='project')trusted();const task=store.getTask(scope.taskId);return store.publish({...input,projectId:store.projectId,taskId:scope.taskId,sessionId:scope.sessionId,baseCommit:task.baseCommit},index.getProjectMap());},
  publishFinding(input:PublishFindingInput){noScopeOverride(input);if(input.verificationStatus==='verified')trusted();const task=store.getTask(scope.taskId);return store.publishFinding({...input,taskId:scope.taskId,baseCommit:task.baseCommit,visibility:'task',confidence:input.verificationStatus},index.getProjectMap());},
  promoteFinding(id:string){trusted();const finding=store.getTaskFindings(scope.taskId).find(value=>value.id===id);if(!finding?.artifactId)throw new Error('Finding with provenance not found in task');return promoteArtifact(store,finding.artifactId,index.getProjectMap());},
  invalidateArtifact(id:string,reason:string){trusted();const artifact=store.getArtifact(id);if(!artifact||!store.canRead(artifact,scope))throw new Error('Artifact not found in scope');return store.invalidate(id,reason);},
 };
 return {read,write};
}
export type ContextAPI=ReturnType<typeof createContextAPI>;
