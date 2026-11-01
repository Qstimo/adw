import type Database from 'better-sqlite3';
import type { SearchHit } from '../types.js';
import { contentHash } from './hash.js';
export interface FileDocument {path:string;content_hash:string;content:string}
export function searchFts(db:Database.Database,snapshotId:string,query:string,scope:string,limit:number):SearchHit[] {
 const terms=query.trim().split(/\s+/).filter(Boolean);
 if(terms.length>32)throw new Error('FTS query has too many terms');
 const match=terms.map(term=>'"'+term.replaceAll('"','""')+'"').join(' AND ');
 const rows=db.prepare(`SELECT f.path,f.content_hash,c.content
 FROM indexed_files_fts JOIN indexed_files f ON f.content_hash=indexed_files_fts.content_hash
 JOIN indexed_contents c ON c.content_hash=f.content_hash
 WHERE f.snapshot_id=? AND indexed_files_fts MATCH ? AND (?='' OR f.path=? OR substr(f.path,1,length(?)+1)=?||'/')
 ORDER BY f.path LIMIT ?`).all(snapshotId,match,scope,scope,scope,scope,limit) as FileDocument[];
 return rows.map(row=>{
  if(contentHash(row.content)!==row.content_hash)throw new Error('Index content hash mismatch');
  const term=(terms[0]??'').replaceAll('"','').toLowerCase(),offset=Math.max(0,row.content.toLowerCase().indexOf(term));
  const lineNumber=row.content.slice(0,offset).split('\n').length;
  return {path:row.path,contentHash:row.content_hash,lineNumber,line:row.content.split('\n')[lineNumber-1]?.replace(/\r$/,'')??'',source:'fts'};
 });
}
