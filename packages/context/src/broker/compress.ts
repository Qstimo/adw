import { createHash } from 'node:crypto';
import { CommitSchema,SourceHashesSchema } from '@adw/contracts';
export function estimateTokens(text:string):number{return Math.ceil(Buffer.byteLength(text,'utf8')/4);}
export function stableJson(value:unknown):string {
 const normalize=(item:unknown):unknown=>{
  if(Array.isArray(item))return item.map(normalize);
  if(item!==null&&typeof item==='object')return Object.fromEntries(Object.entries(item).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,normalize(v)]));
  return item;
 };return JSON.stringify(normalize(value));
}
export function buildContextCacheKey(input:{repositoryId:string;baseCommit:string;pathHashes:Record<string,string>;query:string;summarizerVersion:string;extra?:unknown}):string {
 if(!input.repositoryId||!input.summarizerVersion)throw new Error('Repository and summarizer version are required');CommitSchema.parse(input.baseCommit);SourceHashesSchema.parse(input.pathHashes);
 return createHash('sha256').update(stableJson(input)).digest('hex');
}
export function uniqueRefs(refs:string[]):string[]{return [...new Set(refs)];}
