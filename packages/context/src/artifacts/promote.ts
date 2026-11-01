import type { ContextArtifact,ProjectMap } from '@adw/contracts';
import { ArtifactStore } from './store.js';
import { artifactFreshness } from './invalidation.js';
export function promoteArtifact(store:ArtifactStore,id:string,map:ProjectMap):ContextArtifact {
 return store.db.transaction(()=>{
  const source=store.getArtifact(id);if(!source)throw new Error('Artifact not found in project');
  if(source.visibility==='project')throw new Error('Artifact is already project knowledge');
  if(source.confidence!=='verified'||!source.evidenceRefs?.length)throw new Error('Promotion requires independent verified evidence');
  if(!artifactFreshness(source,map).fresh)throw new Error('Stale or expired sources cannot be promoted');
  const existing=store.db.prepare('SELECT promoted_artifact_id FROM artifact_promotions WHERE source_artifact_id=?').get(source.id) as {promoted_artifact_id:string}|undefined;
  if(existing){const artifact=store.getArtifact(existing.promoted_artifact_id);if(!artifact||!artifactFreshness(artifact,map).fresh)throw new Error('Previous promotion is no longer fresh; publish a new finding');return artifact;}
  const promoted=store.publish({taskId:source.taskId,kind:source.kind,content:store.blobs.text(source.contentRef),...(source.summaryRef?{summary:store.blobs.text(source.summaryRef)}:{}),baseCommit:source.baseCommit,sourcePaths:source.sourcePaths,sourceHashes:source.sourceHashes,producerAgent:source.producerAgent,confidence:'verified',visibility:'project',evidenceRefs:source.evidenceRefs,expiresAt:source.expiresAt,logicalKey:source.logicalKey},map);
  store.db.prepare('INSERT INTO artifact_promotions VALUES (?,?)').run(source.id,promoted.id);store.audit('context_artifact_promoted',{taskId:source.taskId,sourceArtifactId:source.id,artifactId:promoted.id});return promoted;
 }).immediate();
}
