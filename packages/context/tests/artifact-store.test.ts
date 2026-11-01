import {afterEach,expect,it} from 'vitest';
import {writeFileSync,readFileSync,symlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type {PublishArtifactInput} from '../src/index.js';
import {contextFixture} from './broker-helpers.js';
const fixtures:Awaited<ReturnType<typeof contextFixture>>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
it('stores content-addressed artifacts with complete provenance and append-only history',async()=>{
 const f=await contextFixture();fixtures.push(f);const a=f.store.publish(f.input()),b=f.store.publish(f.input({content:'Prefer the updated API'}));
 expect(a.contentRef).toMatch(/^sha256:[a-f0-9]{64}$/);expect(f.store.blobs.text(a.contentRef)).toBe('Use the add API');expect(a.baseCommit).toBe('a'.repeat(40));
 expect(f.store.list().map(a=>a.id)).toEqual([b.id,a.id]);expect(f.api.read.getDecisions().map(a=>a.id)).toEqual([b.id]);expect(f.api.read.getDecisions({history:true})).toHaveLength(2);
 expect(()=>f.db.prepare('UPDATE context_artifacts SET confidence=? WHERE id=?').run('verified',a.id)).toThrow('immutable');expect(()=>f.db.prepare('DELETE FROM context_artifacts WHERE id=?').run(a.id)).toThrow('append-only');
});
it('rejects missing provenance, cross-task base and invalid project promotion',async()=>{
 const f=await contextFixture();fixtures.push(f);
 const changes:Partial<PublishArtifactInput>[]=[{baseCommit:''},{producerAgent:''},{sourceHashes:{}},{taskId:'task_missing'},{baseCommit:'b'.repeat(40)},{sourcePaths:['../app.ts'],sourceHashes:{'../app.ts':'b'.repeat(64)}}];
 for(const change of changes)expect(()=>f.store.publish(f.input(change))).toThrow();
 expect(()=>f.store.publish(f.input({visibility:'project'}))).toThrow('verified');
 expect(()=>f.store.publish(f.input({confidence:'verified'}),f.index.getProjectMap())).toThrow('evidence');
 expect(()=>f.store.publish(f.input({kind:'decision',summary:'a summary'}))).toThrow('research');
});
it('requires actual stored evidence and fresh hashes for verified knowledge',async()=>{
 const f=await contextFixture();fixtures.push(f);const verified=f.input({confidence:'verified',visibility:'project',evidenceRefs:[f.evidence]});
 expect(f.store.publish(verified,f.index.getProjectMap()).confidence).toBe('verified');
 expect(()=>f.store.publish({...verified,evidenceRefs:['sha256:'+'0'.repeat(64)]},f.index.getProjectMap())).toThrow();
 expect(()=>f.store.publish({...verified,sourceHashes:{'app.ts':'0'.repeat(64)}},f.index.getProjectMap())).toThrow('fresh');
 expect(()=>f.store.publish({...verified,expiresAt:'2000-01-01T00:00:00Z'},f.index.getProjectMap())).toThrow('fresh');
});
it('invalidates explicitly, preserving the original row/content and first reason',async()=>{
 const f=await contextFixture();fixtures.push(f);const a=f.store.publish(f.input());const invalid=f.store.invalidate(a.id,'source changed');
 expect(invalid.invalidatedAt).toBeTruthy();expect(f.store.blobs.text(invalid.contentRef)).toBe('Use the add API');f.store.invalidate(a.id,'another reason');
 expect(f.db.prepare('SELECT reason FROM artifact_invalidations WHERE artifact_id=?').get(a.id)).toEqual({reason:'source changed'});
 expect(()=>f.db.prepare('UPDATE context_artifacts SET invalidated_at=NULL WHERE id=?').run(a.id)).toThrow();
 expect(f.api.read.getDecisions()).toEqual([]);expect(f.api.read.getDecisions({history:true})).toHaveLength(1);
});
it('preserves verified decisions when a newer inferred claim is published',async()=>{
 const f=await contextFixture();fixtures.push(f);const verified=f.store.publish(f.input({confidence:'verified',evidenceRefs:[f.evidence]}),f.index.getProjectMap());f.store.publish(f.input({content:'A contrary guess'}));
 expect(f.api.read.getDecisions().map(a=>a.id)).toContain(verified.id);
});
it('deduplicates CAS writes, detects corruption and refuses symlinked shards',async()=>{
 const f=await contextFixture();fixtures.push(f);const ref=f.store.blobs.put('immutable');expect(f.store.blobs.put('immutable')).toBe(ref);
 writeFileSync(f.store.blobs.path(ref),'corrupt');expect(()=>f.store.blobs.get(ref)).toThrow('hash mismatch');expect(()=>f.store.blobs.put('immutable')).toThrow('hash mismatch');
 const foreign=join(f.root,'foreign');mkdirSync(foreign);const hash='f'.repeat(64);symlinkSync(foreign,join(f.store.blobs.root,'ff'));
 expect(()=>f.store.blobs.get('sha256:'+hash)).toThrow('Symlinked');expect(readFileSync(join(f.repo,'app.ts'),'utf8')).toContain('function add');
});
it('treats project decisions as shared across origin tasks while preserving history',async()=>{
 const f=await contextFixture();fixtures.push(f);const old=f.store.publish(f.input({taskId:'task_1',visibility:'project',confidence:'verified',logicalKey:'api-rule',evidenceRefs:[f.evidence]}),f.index.getProjectMap());
 const latest=f.store.publish(f.input({taskId:'task_2',visibility:'project',confidence:'verified',logicalKey:'api-rule',evidenceRefs:[f.evidence],content:'Updated shared rule'}),f.index.getProjectMap());
 expect(f.api.read.getDecisions().map(a=>a.id)).toEqual([latest.id]);expect(f.api.read.getDecisions({history:true}).map(a=>a.id)).toEqual([latest.id,old.id]);
});
