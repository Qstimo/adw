import {afterEach,expect,it} from 'vitest';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {contextFixture} from './broker-helpers.js';
const fixtures:Awaited<ReturnType<typeof contextFixture>>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
it('invalidates changed/deleted source artifacts and keeps historical content',async()=>{
 const f=await contextFixture();fixtures.push(f);const a=f.store.publish(f.input());
 writeFileSync(join(f.repo,'app.ts'),'export const changed=2;');await f.index.reindexChanged();
 expect(f.store.revalidateAgainstIndex(f.index.getProjectMap()).staleArtifactIds).toEqual([a.id]);
 expect(f.api.read.getArtifact(a.id)?.freshness.fresh).toBe(false);expect(f.store.getArtifact(a.id)?.invalidatedAt).toBeUndefined();expect(f.store.blobs.text(a.contentRef)).toBe('Use the add API');
 expect(f.store.revalidateAgainstIndex(f.index.getProjectMap()).staleArtifactIds).toEqual([a.id]);
 const hash=f.index.getProjectMap().files[0]!.contentHash;const b=f.store.publish(f.input({sourceHashes:{'app.ts':hash}}));rmSync(join(f.repo,'app.ts'));await f.index.reindexChanged();
 expect(f.store.revalidateAgainstIndex(f.index.getProjectMap()).staleArtifactIds.sort()).toEqual([a.id,b.id].sort());
});
it('flags a different base without invalidating knowledge belonging to another branch',async()=>{
 const f=await contextFixture();fixtures.push(f);const a=f.store.publish(f.input());await f.index.reindexChanged({baseCommit:'b'.repeat(40)});
 const result=f.store.revalidateAgainstIndex(f.index.getProjectMap());expect(result.baseMismatches).toEqual([a.id]);expect(f.store.getArtifact(a.id)?.invalidatedAt).toBeUndefined();
 await f.index.reindexChanged({baseCommit:'a'.repeat(40)});expect(f.api.read.getDecisions()).toHaveLength(1);
});
it('expires artifacts without allowing an expired decision into bundles',async()=>{
 const f=await contextFixture();fixtures.push(f);const a=f.store.publish(f.input({expiresAt:'2000-01-01T00:00:00Z'}));const bundle=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:3000});
 expect(bundle.bundle.selectedArtifacts).not.toContain(a.id);expect(f.store.revalidateAgainstIndex(f.index.getProjectMap()).staleArtifactIds).toEqual([a.id]);
});
it('does not permanently revoke a fact valid in a different immutable source snapshot',async()=>{
 const f=await contextFixture();fixtures.push(f);const original=f.index.getProjectMap();const a=f.store.publish(f.input({confidence:'verified',visibility:'project',evidenceRefs:[f.evidence]}),original);
 writeFileSync(join(f.repo,'app.ts'),'export const worktreeEdit=1;');await f.index.reindexChanged();expect(f.store.revalidateAgainstIndex(f.index.getProjectMap()).staleArtifactIds).toContain(a.id);
 expect(f.store.getArtifact(a.id)?.invalidatedAt).toBeUndefined();expect(f.store.getDecisions({taskId:'task_1'},original).map(x=>x.id)).toContain(a.id);
});
