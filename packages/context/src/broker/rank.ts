import type { ContextArtifact } from '@adw/contracts';
export function rankArtifact(artifact:ContextArtifact,query:string,paths:string[]):number {
 const words=query.toLowerCase().split(/\s+/).filter(Boolean),key=(artifact.logicalKey??'').toLowerCase();
 const reliability={verified:1000,inferred:200,unverified:0}[artifact.confidence];
 const overlap=artifact.sourcePaths.some(path=>paths.some(scope=>path===scope||path.startsWith(scope+'/')))?80:0;
 const relevance=Math.min(60,words.filter(word=>key.includes(word)||artifact.sourcePaths.some(path=>path.toLowerCase().includes(word))).length*10);
 const costPenalty=Math.min(25,Math.log2(1+artifact.tokenEstimate));
 return reliability+overlap+relevance+(artifact.kind==='decision'?30:0)-costPenalty;
}
