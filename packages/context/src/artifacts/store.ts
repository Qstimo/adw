import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { ContextArtifactSchema,ProjectIdSchema,TaskIdSchema,TaskSpecSchema,FindingSchema,type ContextArtifact,type Finding,type ProjectMap,type TaskSpec } from '@adw/contracts';
import { BlobStore } from './blob-store.js';
import { artifactFreshness } from './invalidation.js';
import { estimateTokens,stableJson } from '../broker/compress.js';
import { safeRelativePath } from '../indexer/walk.js';

export interface PublishArtifactInput {
 projectId?:string;taskId?:string;kind:ContextArtifact['kind'];content:string;summary?:string;baseCommit:string;
 sourcePaths:string[];sourceHashes:Record<string,string>;producerAgent:string;confidence:ContextArtifact['confidence'];
 visibility:ContextArtifact['visibility'];expiresAt?:string;sessionId?:string;logicalKey?:string;evidenceRefs?:string[];
}
export interface StoredFinding extends Finding {id:string;taskId:string;artifactId?:string;createdAt:string}
export interface ContextScope {taskId?:string;sessionId?:string}
interface ArtifactRow {
 id:string;project_id:string;task_id:string|null;kind:ContextArtifact['kind'];content_ref:string;summary_ref:string|null;base_commit:string;
 source_paths_json:string;source_hashes_json:string;producer_agent:string;confidence:ContextArtifact['confidence'];created_at:string;expires_at:string|null;invalidated_at:string|null;
 visibility:ContextArtifact['visibility'];token_estimate:number;evidence_refs_json:string;session_id:string|null;logical_key:string|null;
}
export class ArtifactStore {
 readonly projectId:string;readonly repoPath:string;readonly sourceRoot:string;readonly blobs:BlobStore;
 constructor(readonly db:Database.Database,input:{projectId:string;artifactDir:string;sourceRoot?:string}){
  this.projectId=ProjectIdSchema.parse(input.projectId);
  const project=db.prepare('SELECT path FROM projects WHERE id=?').get(this.projectId) as {path:string}|undefined;if(!project)throw new Error('Project not found');this.repoPath=realpathSync(project.path);
  try{db.prepare('SELECT evidence_refs_json,session_id,logical_key FROM context_artifacts LIMIT 0').all();}catch{throw new Error('Core database migration v3 is required for context storage');}
  this.sourceRoot=input.sourceRoot?realpathSync(input.sourceRoot):this.repoPath;
  this.blobs=new BlobStore(input.artifactDir,this.repoPath);if(input.sourceRoot){new BlobStore(this.blobs.root,this.sourceRoot);}
 }
 audit(action:string,payload:Record<string,unknown>,actor='context'):void {
  this.db.prepare('INSERT INTO audit_events (id,at,actor,action,payload_json) VALUES (?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),actor,action,JSON.stringify({...payload,projectId:this.projectId}));
 }
 getTask(taskId:string):TaskSpec {
  TaskIdSchema.parse(taskId);
  const row=this.db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get(taskId,this.projectId) as Record<string,unknown>|undefined;if(!row)throw new Error('Task not found in project');
  const acceptance=JSON.parse(String(row.acceptance_json)) as string[],outOfScope=JSON.parse(String(row.out_of_scope_json)) as string[];
  const parsed=TaskSpecSchema.parse({id:row.id,projectId:row.project_id,intent:row.intent,acceptance,outOfScope,baseBranch:row.base_branch,baseCommit:row.base_commit,status:row.status});
  // Validate task text but never normalize the locked payload on retrieval.
  return {...parsed,intent:String(row.intent),acceptance,outOfScope};
 }
 private decode(row:ArtifactRow):ContextArtifact {
  return ContextArtifactSchema.parse({id:row.id,projectId:row.project_id,...(row.task_id?{taskId:row.task_id}:{}),kind:row.kind,contentRef:row.content_ref,...(row.summary_ref?{summaryRef:row.summary_ref}:{}),baseCommit:row.base_commit,sourcePaths:JSON.parse(row.source_paths_json),sourceHashes:JSON.parse(row.source_hashes_json),producerAgent:row.producer_agent,confidence:row.confidence,createdAt:row.created_at,...(row.expires_at?{expiresAt:row.expires_at}:{}),...(row.invalidated_at?{invalidatedAt:row.invalidated_at}:{}),visibility:row.visibility,tokenEstimate:row.token_estimate,evidenceRefs:JSON.parse(row.evidence_refs_json),...(row.session_id?{sessionId:row.session_id}:{}),...(row.logical_key?{logicalKey:row.logical_key}:{})});
 }
 list():ContextArtifact[]{return (this.db.prepare('SELECT * FROM context_artifacts WHERE project_id=? ORDER BY rowid DESC').all(this.projectId) as ArtifactRow[]).map(row=>this.decode(row));}
 getArtifact(id:string):ContextArtifact|undefined {const row=this.db.prepare('SELECT * FROM context_artifacts WHERE id=? AND project_id=?').get(id,this.projectId) as ArtifactRow|undefined;return row?this.decode(row):undefined;}
 canRead(artifact:ContextArtifact,scope:ContextScope):boolean {
  if(artifact.projectId!==this.projectId)return false;
  if(artifact.visibility==='project')return artifact.confidence==='verified'&&(artifact.evidenceRefs?.length??0)>0;
  if(!scope.taskId||artifact.taskId!==scope.taskId)return false;
  return artifact.visibility==='task'||(!!scope.sessionId&&scope.sessionId===artifact.sessionId);
 }
 readContent(id:string,scope:ContextScope):{artifact:ContextArtifact;content:string;summary?:string}|undefined {
  const artifact=this.getArtifact(id);if(!artifact||!this.canRead(artifact,scope))return undefined;
  return {artifact,content:this.blobs.text(artifact.contentRef),...(artifact.summaryRef?{summary:this.blobs.text(artifact.summaryRef)}:{})};
 }
 publish(input:PublishArtifactInput,map?:ProjectMap):ContextArtifact {
  if(input.projectId!==undefined&&input.projectId!==this.projectId)throw new Error('Artifact belongs to another project');
  if(!Array.isArray(input.sourcePaths)||input.sourcePaths.length>10_000)throw new Error('Artifact provenance must contain at most 10000 paths');
  if(typeof input.content!=='string'||!input.content.trim())throw new Error('Artifact content must be nonempty');
  if(Buffer.byteLength(input.content,'utf8')>4*1024*1024||input.summary!==undefined&&Buffer.byteLength(input.summary,'utf8')>4*1024*1024)throw new Error('Artifact content/summary exceeds 4 MiB');
  if(input.summary!==undefined&&(input.kind!=='research'||!input.summary.trim()))throw new Error('Nonempty semantic summaries are allowed only for research artifacts');
  if(input.visibility!=='project'&&!input.taskId)throw new Error('Task/session artifacts require taskId');
  if(input.visibility==='session'&&!input.sessionId)throw new Error('Session visibility requires sessionId');
  if(input.taskId){const task=this.getTask(input.taskId);if(task.baseCommit!==input.baseCommit)throw new Error('Artifact base differs from task base');}
  const refs=[...new Set(input.evidenceRefs??[])];for(const ref of refs)this.blobs.get(ref);
  const now=new Date().toISOString();
  const meta=ContextArtifactSchema.parse({id:`art_${randomUUID()}`,projectId:this.projectId,...(input.taskId?{taskId:input.taskId}:{}),kind:input.kind,contentRef:'pending',baseCommit:input.baseCommit,sourcePaths:[...new Set(input.sourcePaths)].sort(),sourceHashes:input.sourceHashes,producerAgent:input.producerAgent,confidence:input.confidence,createdAt:now,...(input.expiresAt?{expiresAt:input.expiresAt}:{}),visibility:input.visibility,tokenEstimate:estimateTokens(input.content),evidenceRefs:refs,...(input.sessionId?{sessionId:input.sessionId}:{}),...(input.logicalKey?{logicalKey:input.logicalKey}:{})});
  if(meta.sourcePaths.some(path=>!safeRelativePath(path)))throw new Error('Provenance paths must be relative without traversal');
  const sourcePaths=new Set(meta.sourcePaths);
  if(Object.keys(meta.sourceHashes).some(path=>!sourcePaths.has(path)))throw new Error('Source hashes must correspond exactly to source paths');
  if(meta.confidence==='verified'){
   if(!refs.length)throw new Error('Verified artifacts require stored evidence');
   if(!map||map.projectId!==this.projectId||map.repoPath!==this.sourceRoot||!artifactFreshness(meta,map).fresh)throw new Error('Verified artifact sources must be fresh against the project index');
  }
  if(meta.visibility==='project'&&meta.confidence!=='verified')throw new Error('Project knowledge must be verified');
  const contentRef=this.blobs.put(input.content),summaryRef=input.summary===undefined?undefined:this.blobs.put(input.summary);
  const artifact=ContextArtifactSchema.parse({...meta,contentRef,...(summaryRef?{summaryRef}:{})});
  this.db.transaction(()=>{
   this.db.prepare('INSERT INTO context_artifacts (id,project_id,task_id,kind,content_ref,summary_ref,base_commit,source_paths_json,source_hashes_json,producer_agent,confidence,created_at,expires_at,invalidated_at,visibility,token_estimate,evidence_refs_json,session_id,logical_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(artifact.id,this.projectId,artifact.taskId??null,artifact.kind,artifact.contentRef,artifact.summaryRef??null,artifact.baseCommit,JSON.stringify(artifact.sourcePaths),JSON.stringify(artifact.sourceHashes),artifact.producerAgent,artifact.confidence,artifact.createdAt,artifact.expiresAt??null,null,artifact.visibility,artifact.tokenEstimate,JSON.stringify(refs),artifact.sessionId??null,artifact.logicalKey??null);
   this.audit('context_artifact_published',{artifactId:artifact.id,taskId:artifact.taskId,baseCommit:artifact.baseCommit,confidence:artifact.confidence,visibility:artifact.visibility,contentRef:artifact.contentRef});
  })();return artifact;
 }
 invalidate(id:string,reason:string):ContextArtifact {
  if(!reason.trim())throw new Error('Invalidation requires a reason');const artifact=this.getArtifact(id);if(!artifact)throw new Error('Artifact not found in project');if(artifact.invalidatedAt)return artifact;
  const at=new Date().toISOString();this.db.transaction(()=>{
   const changed=this.db.prepare('UPDATE context_artifacts SET invalidated_at=? WHERE id=? AND project_id=? AND invalidated_at IS NULL').run(at,id,this.projectId);
   if(changed.changes){this.db.prepare('INSERT INTO artifact_invalidations VALUES (?,?,?)').run(id,at,reason);this.audit('context_artifact_invalidated',{artifactId:id,taskId:artifact.taskId,reason});}
  })();return this.getArtifact(id)!;
 }
 revalidateAgainstIndex(map:ProjectMap):{staleArtifactIds:string[];baseMismatches:string[]} {
  if(map.projectId!==this.projectId||map.repoPath!==this.sourceRoot)throw new Error('Index belongs to another project/source');
  const staleArtifactIds:string[]=[],baseMismatches:string[]=[];
  for(const artifact of this.list()){
   if(artifact.baseCommit!==map.baseCommit){baseMismatches.push(artifact.id);continue;}
   if(!artifactFreshness(artifact,map).fresh)staleArtifactIds.push(artifact.id);
  }
  // Freshness is relative to an immutable source snapshot. A private worktree
  // must not revoke knowledge that remains valid in another task's snapshot.
  this.audit('context_artifacts_revalidated',{snapshotId:map.snapshotId,staleArtifactIds,baseMismatches});
  return {staleArtifactIds,baseMismatches};
 }
 getDecisions(scope:ContextScope,map:ProjectMap,input:{paths?:string[];history?:boolean}={}):ContextArtifact[] {
  const seen=new Set<string>();return this.list().filter(artifact=>{
   if(artifact.kind!=='decision'||!this.canRead(artifact,scope))return false;
   if(input.paths?.length&&artifact.sourcePaths.length&&!artifact.sourcePaths.some(path=>input.paths!.some(p=>path===p||path.startsWith(p+'/'))))return false;
   if(input.history)return true;if(!artifactFreshness(artifact,map).fresh)return false;
   const key=stableJson([artifact.visibility,artifact.visibility==='project'?undefined:artifact.taskId,artifact.visibility==='session'?artifact.sessionId:undefined,artifact.confidence,artifact.logicalKey??(artifact.sourcePaths.length?artifact.sourcePaths:artifact.id)]);
   if(seen.has(key))return false;seen.add(key);return true;
  });
 }
 publishFinding(input:Omit<PublishArtifactInput,'kind'|'content'>&{claim:string;affectedPaths:string[];verificationStatus:Finding['verificationStatus']} ,map?:ProjectMap):StoredFinding&{artifactId:string} {
  if(!input.taskId||input.visibility!=='task')throw new Error('Findings must be published into a task namespace');
  const finding=FindingSchema.parse({claim:input.claim,evidenceRefs:input.evidenceRefs??[],affectedPaths:input.affectedPaths,verificationStatus:input.verificationStatus});
  if(finding.affectedPaths.some(path=>!safeRelativePath(path)))throw new Error('Affected paths must stay inside the project');
  if(finding.verificationStatus!==input.confidence)throw new Error('Finding confidence must match verification status');
  return this.db.transaction(()=>{
   const artifact=this.publish({...input,kind:'finding',content:finding.claim},map);const id=`finding_${randomUUID()}`,createdAt=new Date().toISOString();
   this.db.prepare('INSERT INTO findings (id,task_id,claim,evidence_refs_json,affected_paths_json,verification_status,created_at) VALUES (?,?,?,?,?,?,?)').run(id,input.taskId,finding.claim,JSON.stringify(finding.evidenceRefs),JSON.stringify(finding.affectedPaths),finding.verificationStatus,createdAt);
   this.db.prepare('INSERT INTO finding_artifacts VALUES (?,?)').run(id,artifact.id);this.audit('context_finding_published',{findingId:id,artifactId:artifact.id,taskId:input.taskId});
   return {...finding,id,taskId:input.taskId!,artifactId:artifact.id,createdAt};
  })();
 }
 getTaskFindings(taskId:string):StoredFinding[] {
  this.getTask(taskId);
  const rows=this.db.prepare('SELECT f.*,l.artifact_id FROM findings f JOIN tasks t ON t.id=f.task_id LEFT JOIN finding_artifacts l ON l.finding_id=f.id WHERE f.task_id=? AND t.project_id=? ORDER BY f.rowid DESC').all(taskId,this.projectId) as {id:string;task_id:string;claim:string;evidence_refs_json:string;affected_paths_json:string;verification_status:Finding['verificationStatus'];created_at:string;artifact_id:string|null}[];
  return rows.map(row=>({...FindingSchema.parse({claim:row.claim,evidenceRefs:JSON.parse(row.evidence_refs_json),affectedPaths:JSON.parse(row.affected_paths_json),verificationStatus:row.verification_status}),id:row.id,taskId:row.task_id,artifactId:row.artifact_id??undefined,createdAt:row.created_at}));
 }
}
