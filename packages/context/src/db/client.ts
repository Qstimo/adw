import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
export function openIndexDb(file:string):Database.Database {
 const db=new Database(file);
 try {
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  if(tables.length&&!tables.some(row=>row.name==='context_index_meta'))throw new Error('Expected a dedicated context index database');
  if(tables.length){const meta=db.prepare('SELECT version FROM context_index_meta WHERE singleton=1').get() as {version:number}|undefined;if(meta?.version!==1)throw new Error('Unsupported context index schema version');}
  db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');db.pragma('busy_timeout=5000');
  if(!tables.length)db.transaction(()=>db.exec(readFileSync(new URL('./index-schema.sql',import.meta.url),'utf8'))).immediate();
  return db;
 } catch(error){db.close();throw error;}
}
