import { afterEach,expect,it,vi } from 'vitest';
import { mkdirSync,writeFileSync,rmSync,symlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { fixture,build } from './helpers.js';
import { readSource } from '../src/index.js';
import type { ProjectIndexer } from '../src/index.js';
const roots:string[]=[],indexes:ProjectIndexer[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const i of indexes.splice(0))i.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('honors gitignore, excludes metadata/dependencies/secrets and never follows links',async()=>{
 const f=fixture({'.gitignore':'ignored.txt\n','ignored.txt':'hidden','visible.ts':'export const visible=1','node_modules/pkg/a.ts':'dependency','.adw/log.txt':'data','.git':'gitdir: /outside','.env':'SECRET=private','.aws/credentials':'private'});roots.push(f.root);
 writeFileSync(join(f.root,'outside.txt'),'outside private');symlinkSync(join(f.root,'outside.txt'),join(f.repo,'link.txt'));
 const i=await build(f);indexes.push(i);expect(i.getProjectMap().files.map(f=>f.path)).toEqual(['.gitignore','visible.ts']);expect((await i.searchCode({query:'private'})).hits).toEqual([]);
});
it('skips whole oversized/binary/non-UTF8 files without publishing truncated hashes',async()=>{
 const f=fixture({'a.txt':'x'.repeat(30),'b.bin':Buffer.from([0,1,2]),'c.bin':Buffer.from([255,254]),'d.txt':'valid'});roots.push(f.root);
 const i=await build(f,{limits:{maxFileBytes:10}});indexes.push(i);const map=i.getProjectMap();expect(map.files.map(f=>f.path)).toEqual(['d.txt']);expect(map.complete).toBe(false);expect(map.warnings.map(w=>w.code)).toEqual(['max_file_bytes','binary','binary']);
});
it('applies deterministic file and byte budgets with warnings',async()=>{
 const f=fixture({'a.txt':'1234','b.txt':'5678','c.txt':'90'});roots.push(f.root);
 const i=await build(f,{limits:{maxFiles:2,maxTotalBytes:5}});indexes.push(i);expect(i.getProjectMap().files.map(f=>f.path)).toEqual(['a.txt']);expect(i.getProjectMap().warnings.map(w=>w.code)).toEqual(['max_files','max_total_bytes']);
});
it('reparses dependent facts when a changed file consumes more of the global fact budget',async()=>{
 const f=fixture({'a.ts':'const a=1;','b.ts':'const b=2;'});roots.push(f.root);const i=await build(f,{limits:{maxFacts:2}});indexes.push(i);
 expect(i.getProjectMap().symbols.map(s=>s.name)).toEqual(['a','b']);writeFileSync(join(f.repo,'a.ts'),'const a=1;const extra=3;');await i.reindexChanged();
 expect(i.getProjectMap().symbols.map(s=>s.name)).toEqual(['a','extra']);expect(i.getProjectMap().complete).toBe(false);
 rmSync(join(f.repo,'a.ts'));await i.reindexChanged();expect(i.getProjectMap().symbols.map(s=>s.name)).toEqual(['b']);
});
it('refuses index databases inside the repository and preserves unrelated databases',async()=>{
 const f=fixture({'a.ts':'const x=1;'});roots.push(f.root);
 await expect(build(f,{dbPath:join(f.repo,'index.sqlite')})).rejects.toThrow('outside');expect(existsSync(join(f.repo,'index.sqlite'))).toBe(false);
 const db=new Database(f.dbPath);db.exec('CREATE TABLE unrelated (data TEXT)');db.prepare('INSERT INTO unrelated VALUES (?)').run('keep');db.close();
 await expect(build(f)).rejects.toThrow('dedicated');const check=new Database(f.dbPath);try{expect(check.prepare('SELECT data FROM unrelated').get()).toEqual({data:'keep'});}finally{check.close();}
});
it('reports invalid manifests without executing discovered scripts',async()=>{
 const f=fixture({'package.json':'{"scripts":{"test":"touch SHOULD_NOT_EXIST"}}','tsconfig.json':'{//comment\n"compilerOptions":{"strict":true,},}','nested/package.json':'{bad'});roots.push(f.root);
 const i=await build(f);indexes.push(i);const map=i.getProjectMap();expect(map.manifests.find(m=>m.kind==='tsconfig')).toBeDefined();expect(map.testCommands[0]?.command).toBe('touch SHOULD_NOT_EXIST');expect(existsSync(join(f.repo,'SHOULD_NOT_EXIST'))).toBe(false);expect(map.warnings[0]?.code).toBe('manifest_error');
});
it('rolls back publication when a scan fails its listing budget',async()=>{
 const f=fixture({'a.ts':'export const a=1'});roots.push(f.root);const i=await build(f,{limits:{maxListBytes:20}});indexes.push(i);const before=i.getProjectMap();
 for(let n=0;n<10;n++)writeFileSync(join(f.repo,`new_${n}.ts`),'const n=1');
 await expect(i.reindexChanged()).rejects.toThrow('output limit');expect(i.getProjectMap()).toEqual(before);
});
it('rejects invalid limits/base anchors and closes resources idempotently',async()=>{
 const f=fixture({'a.ts':'const a=1'});roots.push(f.root);
 await expect(build(f,{baseCommit:'WORK_TREE'})).rejects.toThrow();await expect(build(f,{limits:{maxFiles:0}})).rejects.toThrow();
 const i=await build(f);i.close();i.close();expect(()=>i.getProjectMap()).toThrow('closed');
});

it('fails actionably when ripgrep is missing and never publishes a partial success',async()=>{
 const f=fixture({'a.ts':'const a=1'});roots.push(f.root);vi.stubEnv('PATH','');
 await expect(build(f)).rejects.toThrow('ripgrep (rg) is required');
});
it('enforces repository scope even on direct source reads',async()=>{
 const f=fixture({'a.ts':'const a=1'});roots.push(f.root);writeFileSync(join(f.root,'outside.txt'),'private');
 expect(await readSource(f.repo,'../outside.txt',100,100)).toMatchObject({warning:{code:'invalid_path'}});
 await expect(build(f,{repoPath:join(f.repo,'a.ts')})).rejects.toThrow('directory');
});

it('charges skipped binary reads against the total I/O budget',async()=>{
 const f=fixture({'a.bin':Buffer.from([0,1,2]),'b.txt':'x'});roots.push(f.root);const i=await build(f,{limits:{maxTotalBytes:3}});indexes.push(i);
 expect(i.getProjectMap().files).toEqual([]);expect(i.getProjectMap().warnings.map(w=>w.code)).toEqual(['binary','max_total_bytes']);
 expect((await i.reindexChanged()).stats.totalBytes).toBe(3);
});
