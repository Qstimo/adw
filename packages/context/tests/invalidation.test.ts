import { afterEach, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { fixture, build } from './helpers.js';
import type { ProjectIndexer } from '../src/index.js';
const roots:string[]=[],indexes:ProjectIndexer[]=[];
afterEach(()=>{for(const i of indexes.splice(0))i.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
it('reuses unchanged rows, refreshes only changed analysis and preserves immutable old searches',async()=>{
 const f=fixture({'a.ts':'export function before(){return 1}','b.ts':'export const stable=2'});roots.push(f.root);
 const index=await build(f);indexes.push(index);const old=index.getProjectMap();
 writeFileSync(join(f.repo,'a.ts'),'export function after(){return 3}');
 const result=await index.reindexChanged();const current=index.getProjectMap();
 expect(result.changedPaths).toEqual(['a.ts']);expect(result.staleArtifactHints).toEqual(['a.ts']);expect(result.stats.analyzedFiles).toBe(1);expect(result.stats.reusedFiles).toBe(1);
 expect(current.snapshotId).not.toBe(old.snapshotId);
 expect(current.files.find(f=>f.path==='b.ts')?.updatedAt).toBe(old.files.find(f=>f.path==='b.ts')?.updatedAt);
 expect(current.files.find(f=>f.path==='a.ts')?.updatedAt).not.toBe(old.files.find(f=>f.path==='a.ts')?.updatedAt);
 expect(index.getProjectMap(old.snapshotId)).toEqual(old);
 expect((await index.searchCode({query:'before',snapshotId:old.snapshotId})).hits.map(h=>h.path)).toEqual(['a.ts']);
 expect((await index.searchCode({query:'before'})).hits).toEqual([]);
});
it('detects removals, new ignore rules and additions without deleting history',async()=>{
 const f=fixture({'a.ts':'export const removed=1','b.ts':'export const hidden=2'});roots.push(f.root);const index=await build(f);indexes.push(index);const old=index.getProjectMap();
 rmSync(join(f.repo,'a.ts'));writeFileSync(join(f.repo,'.gitignore'),'b.ts\n');writeFileSync(join(f.repo,'c.ts'),'export const added=3');
 const result=await index.reindexChanged();expect(result.deletedPaths).toEqual(['a.ts','b.ts']);expect(result.changedPaths).toEqual(['.gitignore','c.ts']);
 expect(index.getProjectMap(old.snapshotId).files.some(f=>f.path==='a.ts')).toBe(true);
 expect((await index.searchCode({query:'hidden'})).hits).toEqual([]);
});
it('namespaces base SHAs and persists/deduplicates content across reopen',async()=>{
 const f=fixture({'a.ts':'export const stable=1'});roots.push(f.root);let index=await build(f);const old=index.getProjectMap();
 const update=await index.reindexChanged({baseCommit:'b'.repeat(40)});expect(update.baseChanged).toBe(true);expect(update.stats.reusedFiles).toBe(1);expect(update.staleArtifactHints).toEqual(['a.ts']);expect(index.getProjectMap(old.snapshotId).baseCommit).toBe('a'.repeat(40));
 const current=index.getProjectMap();index.close();index=await build(f,{baseCommit:'b'.repeat(40)});indexes.push(index);
 expect(index.getProjectMap()).toEqual(current);
 const unchanged=await index.reindexChanged();expect(unchanged.snapshotId).toBe(current.snapshotId);expect(unchanged.stats.analyzedFiles).toBe(0);expect(unchanged.staleArtifactHints).toEqual([]);
 const db=new Database(f.dbPath,{readonly:true});try{expect(db.prepare('SELECT count(*) AS n FROM indexed_contents').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) AS n FROM index_snapshots').get()).toEqual({n:2});}finally{db.close();}
});
it('rejects overlapping scans on one index instance',async()=>{
 const f=fixture({'a.ts':'export const x=1'});roots.push(f.root);const index=await build(f);indexes.push(index);
 const first=index.reindexChanged();await expect(index.reindexChanged()).rejects.toThrow('already running');expect(()=>index.close()).toThrow('during an index update');await first;
});
