import { afterEach, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture,build } from './helpers.js';
import type { ProjectIndexer } from '../src/index.js';
const roots:string[]=[],indexes:ProjectIndexer[]=[];
afterEach(()=>{for(const i of indexes.splice(0))i.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
it('searches FTS with literal, bounded project scope rather than SQL or FTS operators',async()=>{
 const f=fixture({'src/a.ts':'export function add(){return 1}','src2/b.ts':'export function add(){return 2}','src_percent/a.ts':'export function add(){return 3}','srcXpercent/a.ts':'export function add(){return 4}'});roots.push(f.root);const i=await build(f);indexes.push(i);
 expect((await i.searchCode({query:'function add',scope:'src'})).hits).toMatchObject([{path:'src/a.ts',lineNumber:1,source:'fts'}]);
 expect((await i.searchCode({query:'add',scope:'src_percent'})).hits.map(h=>h.path)).toEqual(['src_percent/a.ts']);
 expect((await i.searchCode({query:'" OR "'})).hits).toEqual([]);
 expect((await i.searchCode({query:'add',limit:1})).hits).toHaveLength(1);
 for(const scope of ['../','/etc','src/../src2','C:/tmp'])await expect(i.searchCode({query:'add',scope})).rejects.toThrow('Scope');
 await expect(i.searchCode({query:''})).rejects.toThrow('Query');await expect(i.searchCode({query:'x',limit:0})).rejects.toThrow('limit');
});
it('ripgrep returns exact literal line matches from frozen snapshot bytes, including no-newline boundaries',async()=>{
 const f=fixture({'a.txt':'no match','src/b.ts':'first\nexport const literal = "[a+b]";\n','src/c.ts':'// [a+b]'});roots.push(f.root);const i=await build(f);indexes.push(i);
 writeFileSync(join(f.repo,'src/b.ts'),'live content is different');
 const hits=(await i.searchCode({query:'[a+b]',engine:'ripgrep',scope:'src'})).hits;
 expect(hits).toMatchObject([{path:'src/b.ts',lineNumber:2,line:'export const literal = "[a+b]";',source:'ripgrep'},{path:'src/c.ts',lineNumber:1,line:'// [a+b]'}]);
 expect((await i.searchCode({query:'absent',engine:'ripgrep'})).hits).toEqual([]);
 expect(i.getSource('src/b.ts')?.content).toBe('first\nexport const literal = "[a+b]";\n');
 rmSync(f.repo,{recursive:true});expect((await i.searchCode({query:'[a+b]',engine:'ripgrep'})).hits).toHaveLength(2);
});
it('preserves BOM bytes in hashes and supports BOM manifests and source searches',async()=>{
 const text='\uFEFFexport const bom=1';const f=fixture({'bom.ts':text,'package.json':'\uFEFF{"scripts":{"test":"echo test"}}'});roots.push(f.root);const i=await build(f);indexes.push(i);
 expect(i.getProjectMap().files.find(f=>f.path==='bom.ts')?.contentHash).toBe(createHash('sha256').update(text).digest('hex'));
 expect(i.getProjectMap().testCommands[0]?.name).toBe('test');
 for(const engine of ['fts','ripgrep'] as const)expect((await i.searchCode({query:'bom',engine})).hits[0]).toMatchObject({path:'bom.ts',lineNumber:1});
});
it('does not expose another project snapshot from a shared index database',async()=>{
 const one=fixture({'private.ts':'export const privateWord=1'}),two=fixture({'public.ts':'export const publicWord=1'});roots.push(one.root,two.root);
 const a=await build(one),b=await build(two,{projectId:'proj_second',dbPath:one.dbPath});indexes.push(a,b);
 await expect(b.searchCode({query:'privateWord',snapshotId:a.getProjectMap().snapshotId})).rejects.toThrow('not found');
 expect((await b.searchCode({query:'privateWord'})).hits).toEqual([]);
 await expect(build(two,{dbPath:one.dbPath})).rejects.toThrow('another repository');
});

it('keeps snapshot search order stable when unrelated projects change the global FTS corpus',async()=>{
 const f=fixture({'a.txt':'alpha '.repeat(10)+'beta','b.txt':'alpha '+'beta '.repeat(10)});roots.push(f.root);const i=await build(f);indexes.push(i);
 const before=await i.searchCode({query:'alpha beta',limit:1});
 const files=Object.fromEntries(Array.from({length:30},(_,n)=>[`file${n}.txt`,`alpha unrelated${n}`]));
 const other=fixture(files);roots.push(other.root);const j=await build(other,{projectId:'proj_other',dbPath:f.dbPath});indexes.push(j);
 expect(await i.searchCode({query:'alpha beta',limit:1})).toEqual(before);
});
