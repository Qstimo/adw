import type { ContextArtifact,ProjectMap } from '@adw/contracts';
export interface Freshness { fresh:boolean; reasons:string[] }
export function artifactFreshness(artifact:ContextArtifact,map:ProjectMap,now=new Date()):Freshness {
 const reasons:string[]=[];
 if(artifact.projectId!==map.projectId)reasons.push('project_mismatch');
 if(artifact.baseCommit!==map.baseCommit)reasons.push('base_mismatch');
 if(artifact.invalidatedAt)reasons.push('invalidated');
 if(artifact.expiresAt&&Date.parse(artifact.expiresAt)<=now.getTime())reasons.push('expired');
 const hashes=new Map(map.files.map(file=>[file.path,file.contentHash]));
 for(const path of artifact.sourcePaths){if(!hashes.has(path))reasons.push(`source_missing:${path}`);else if(hashes.get(path)!==artifact.sourceHashes[path])reasons.push(`source_changed:${path}`);}
 return {fresh:reasons.length===0,reasons};
}
