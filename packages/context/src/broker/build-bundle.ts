import { randomUUID } from 'node:crypto';
import { ContextBundleSchema,type ContextBundle,type BundleSection,type ContextArtifact } from '@adw/contracts';
import { ArtifactStore, type ContextScope } from '../artifacts/store.js';
import { artifactFreshness } from '../artifacts/invalidation.js';
import { ProjectIndexer } from '../indexer/project-indexer.js';
import { buildContextCacheKey,estimateTokens,stableJson,uniqueRefs } from './compress.js';
import { rankArtifact } from './rank.js';
import { normalizeScope,inScope } from '../indexer/walk.js';

export interface BuildBundleInput {taskId:string;agentId:string;tokenBudget:number;acceptance?:string[];baseCommit?:string;query?:string;paths?:string[];sessionId?:string}
export interface BuiltBundle {bundle:ContextBundle;contentRef:string;bundlePath:string;cacheHit:boolean;omittedArtifacts:string[]}
interface Candidate {section:BundleSection;refs:string[];score:number;key:string;artifactId?:string}
const MAX_BUNDLE_BYTES=1024*1024;
function measured(bundle:ContextBundle):ContextBundle {
 const result={...bundle,estimatedTokens:0,overBudget:false,warnings:[...(bundle.warnings??[])]};
 for(let iteration=0;iteration<12;iteration++){
  const estimate=estimateTokens(JSON.stringify(result));
  const over=estimate>result.tokenBudget;
  if(over&&!result.warnings.includes('Mandatory task context exceeds token budget; acceptance was preserved in full'))result.warnings.push('Mandatory task context exceeds token budget; acceptance was preserved in full');
  if(result.estimatedTokens===estimate&&result.overBudget===over)return ContextBundleSchema.parse(result);
  result.estimatedTokens=estimate;result.overBudget=over;
 }
 throw new Error('Bundle estimate did not converge');
}
export class ContextBroker {
 private cache=new Map<string,{candidates:Candidate[];bytes:number}>();
 private cacheBytes=0;
 private cacheHits=0;
 constructor(readonly store:ArtifactStore,readonly index:ProjectIndexer){if(store.projectId!==index.projectId||store.sourceRoot!==index.repoPath)throw new Error('Index and artifact store belong to different projects');}
 getMetrics(){return {cacheHits:this.cacheHits,cacheEntries:this.cache.size,cacheBytes:this.cacheBytes};}
 async buildBundle(input:BuildBundleInput):Promise<BuiltBundle>{
  if(!input.agentId.trim()||input.agentId.length>128)throw new Error('Invalid target agent');
  if(!Number.isSafeInteger(input.tokenBudget)||input.tokenBudget<1||input.tokenBudget>1_000_000)throw new Error('Invalid token budget');
  const agentId=input.agentId.trim();
  const query=input.query??'';if(query.length>1000||/[\n\r\0]/.test(query))throw new Error('Bundle query must be single-line and at most 1000 characters');
  const paths=(input.paths??[]).map(normalizeScope);if(paths.length>100)throw new Error('Too many context scopes');
  const task=this.store.getTask(input.taskId),map=this.index.getProjectMap();
  if(map.baseCommit!==task.baseCommit||input.baseCommit!==undefined&&input.baseCommit!==task.baseCommit)throw new Error('Task and index base commits differ');
  if(input.acceptance!==undefined&&stableJson(input.acceptance)!==stableJson(task.acceptance))throw new Error('Acceptance differs from the stored task');
  const scope:ContextScope={taskId:input.taskId,sessionId:input.sessionId};
  const latestDecisions=new Set(this.store.getDecisions(scope,map).map(artifact=>artifact.id));
  const artifacts=this.store.list().filter(artifact=>this.store.canRead(artifact,scope)&&artifactFreshness(artifact,map).fresh&&(artifact.kind!=='decision'||latestDecisions.has(artifact.id)));
  // Bound materialization separately from the prompt budget; metadata remains
  // scoped and evidence-backed even for candidates too large to fit inline.
  const bodies=new Map<string,{content:string;summary?:string}>();let retrievedBytes=0;
  const bounded=[...artifacts].sort((a,b)=>rankArtifact(b,query,paths)-rankArtifact(a,query,paths)||(a.id<b.id?-1:1)).slice(0,128);
  for(const artifact of bounded){
   if(estimateTokens(JSON.stringify(artifact))>input.tokenBudget)continue;
   if(artifact.kind!=='research'&&artifact.tokenEstimate>input.tokenBudget)continue;
   if(retrievedBytes+artifact.tokenEstimate*4>8*1024*1024)continue;
   const content=this.store.blobs.text(artifact.contentRef);retrievedBytes+=Buffer.byteLength(content);
   let summary:string|undefined;
   if(artifact.summaryRef){summary=this.store.blobs.text(artifact.summaryRef);retrievedBytes+=Buffer.byteLength(summary);}
   if(retrievedBytes>8*1024*1024)break;bodies.set(artifact.id,{content,summary});
  }
  const pathHashes=Object.fromEntries(map.files.map(file=>[file.path,file.contentHash]));
  const key=buildContextCacheKey({repositoryId:this.store.projectId+'@'+this.store.repoPath,baseCommit:task.baseCommit,pathHashes,query,summarizerVersion:'lossless-v1',extra:{snapshotId:map.snapshotId,taskId:task.id,sessionId:input.sessionId,paths,budget:input.tokenBudget,acceptance:task.acceptance,intent:task.intent,outOfScope:task.outOfScope,artifacts}});
  const cached=this.cache.get(key);let candidates:Candidate[];
  if(cached){candidates=structuredClone(cached.candidates);this.cacheHits++;}
  else {
   candidates=artifacts.filter(artifact=>bodies.has(artifact.id)).map(artifact=>{
    const body=bodies.get(artifact.id)!;const useSummary=artifact.kind==='research'&&artifact.summaryRef&&body.summary!==undefined;
    return {key:artifact.id,artifactId:artifact.id,score:rankArtifact(artifact,query,paths),refs:[artifact.contentRef,...(artifact.summaryRef?[artifact.summaryRef]:[])],section:{kind:'artifact' as const,ref:useSummary?artifact.summaryRef!:artifact.contentRef,content:useSummary?body.summary!:body.content,artifactId:artifact.id,artifact,confidence:artifact.confidence}};
   });
   let hits:{path:string;lineNumber:number}[]=[];
   if(query.trim()){
    if(paths.length){for(const path of paths){const result=await this.index.searchCode({query,scope:path,limit:20,snapshotId:map.snapshotId});hits.push(...result.hits);if(hits.length>=40)break;}}
    else hits=(await this.index.searchCode({query,limit:20,snapshotId:map.snapshotId})).hits;
   }else hits=map.files.filter(file=>paths.length?paths.some(path=>inScope(file.path,path)):false).slice(0,20).map(file=>({path:file.path,lineNumber:1}));
   const seen=new Set<string>();
   for(const hit of hits.slice(0,40)){
    const source=this.index.getSource(hit.path,map.snapshotId);if(!source)continue;
    if(retrievedBytes+Buffer.byteLength(source.content)>8*1024*1024)break;retrievedBytes+=Buffer.byteLength(source.content);
    const lines=source.content.split('\n'),startLine=Math.max(1,hit.lineNumber-2),endLine=Math.min(lines.length,hit.lineNumber+4);
    const ref=`repo:${encodeURIComponent(hit.path)}#L${startLine}-L${endLine}@${source.contentHash}`;
    if(seen.has(ref))continue;seen.add(ref);
    candidates.push({key:ref,score:150,refs:[ref],section:{kind:'source',ref,path:hit.path,contentHash:source.contentHash,startLine,endLine,content:lines.slice(startLine-1,endLine).join('\n')}});
   }
   candidates.sort((a,b)=>b.score-a.score||(a.key<b.key?-1:a.key>b.key?1:0));
   const bytes=Buffer.byteLength(JSON.stringify(candidates));
   if(bytes<=2*1024*1024){while(this.cache.size&&(this.cache.size>=64||this.cacheBytes+bytes>8*1024*1024)){const first=this.cache.keys().next().value!;this.cacheBytes-=this.cache.get(first)!.bytes;this.cache.delete(first);}this.cache.set(key,{candidates:structuredClone(candidates),bytes});this.cacheBytes+=bytes;}
  }
  const warnings=map.complete?[]:[`Index snapshot is incomplete (${map.warnings.length} warning records); omitted sources are not verified`];
  let bundle=measured({taskId:task.id,projectId:task.projectId,targetAgent:agentId,baseCommit:task.baseCommit,indexSnapshotId:map.snapshotId,intent:task.intent,acceptance:[...task.acceptance],outOfScope:[...task.outOfScope],selectedArtifacts:[],sourceRefs:[],sections:[],tokenBudget:input.tokenBudget,generatedAt:new Date().toISOString(),cacheKey:key,warnings});
  if(Buffer.byteLength(JSON.stringify(bundle))>MAX_BUNDLE_BYTES)throw new Error('Mandatory task context exceeds the 1 MiB bundle limit; it was not truncated');
  const omittedArtifacts:string[]=artifacts.filter(artifact=>!candidates.some(candidate=>candidate.artifactId===artifact.id)).map(artifact=>artifact.id),dedupe=new Set<string>();
  for(const candidate of candidates){
   const dedupeKey=candidate.section.kind+':'+candidate.section.ref;
   if(dedupe.has(dedupeKey)){if(candidate.artifactId)omittedArtifacts.push(candidate.artifactId);continue;}
   const next=measured({...bundle,selectedArtifacts:[...bundle.selectedArtifacts,...(candidate.artifactId?[candidate.artifactId as ContextArtifact['id']]:[])],sourceRefs:uniqueRefs([...bundle.sourceRefs,...candidate.refs]),sections:[...(bundle.sections??[]),candidate.section]});
   if(next.overBudget||Buffer.byteLength(JSON.stringify(next))>MAX_BUNDLE_BYTES){if(candidate.artifactId)omittedArtifacts.push(candidate.artifactId);continue;}
   bundle=next;dedupe.add(dedupeKey);
  }
  const contentRef=this.store.blobs.put(JSON.stringify(bundle));
  this.store.db.transaction(()=>{
   if(this.index.getProjectMap().snapshotId!==map.snapshotId||stableJson(this.store.getTask(input.taskId))!==stableJson(task))throw new Error('Task or index changed while building context; retry');
     const current=new Map(this.store.list().map(artifact=>[artifact.id,artifact]));
     for(const id of bundle.selectedArtifacts){const artifact=current.get(id);if(!artifact||!artifactFreshness(artifact,map).fresh)throw new Error('Selected artifact became stale while building context; retry');}
   for(const section of bundle.sections??[]){if(section.kind==='source'){const source=section.path?this.index.getSource(section.path,map.snapshotId):undefined;if(!source||source.contentHash!==section.contentHash)throw new Error('Selected source became unavailable; retry');}}
   this.store.db.prepare('INSERT INTO context_bundles VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`bundle_${randomUUID()}`,this.store.projectId,task.id,task.baseCommit,map.snapshotId,agentId,contentRef,key,bundle.estimatedTokens!,Number(bundle.overBudget),bundle.generatedAt);
   this.store.audit('context_bundle_built',{taskId:task.id,targetAgent:agentId,contentRef,cacheKey:key,cacheHit:!!cached,selectedArtifacts:bundle.selectedArtifacts,overBudget:bundle.overBudget,estimatedTokens:bundle.estimatedTokens});
  }).immediate();
  return {bundle,contentRef,bundlePath:this.store.blobs.path(contentRef),cacheHit:!!cached,omittedArtifacts};
 }
}
