import {afterEach,expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ContextBundleSchema} from '@adw/contracts';
import {contextFixture} from './broker-helpers.js';
import {buildContextCacheKey,estimateTokens} from '../src/index.js';
const fixtures:Awaited<ReturnType<typeof contextFixture>>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
it('preserves exact acceptance/out-of-scope under an impossibly tiny budget',async()=>{
 const f=await contextFixture();fixtures.push(f);const result=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:1});
 expect(result.bundle.acceptance).toEqual(['  keep the complete API contract\nincluding this exact line  ']);expect(result.bundle.outOfScope).toEqual(['Do not push']);expect(result.bundle.overBudget).toBe(true);expect(result.bundle.sections).toEqual([]);
 expect(result.bundle.estimatedTokens).toBe(estimateTokens(JSON.stringify(result.bundle)));expect(ContextBundleSchema.parse(JSON.parse(readFileSync(result.bundlePath,'utf8')))).toEqual(result.bundle);
 expect(f.db.prepare('SELECT over_budget FROM context_bundles').get()).toEqual({over_budget:1});
});
it('includes actual artifact/source bytes with provenance and prioritizes verified decisions',async()=>{
 const f=await contextFixture();fixtures.push(f);const verified=f.store.publish(f.input({content:'Independent verified rule',confidence:'verified',evidenceRefs:[f.evidence]}),f.index.getProjectMap());
 const inferred=f.store.publish(f.input({kind:'handoff',content:'An inferred hypothesis '.repeat(15)}));
 const full=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:5000,query:'function add'});
 expect(full.bundle.selectedArtifacts).toContain(verified.id);expect(full.bundle.sections?.find(s=>s.artifactId===verified.id)).toMatchObject({content:'Independent verified rule',artifact:{baseCommit:'a'.repeat(40),sourceHashes:f.input().sourceHashes}});
 expect(full.bundle.sections?.some(s=>s.kind==='source'&&s.content.includes('function add'))).toBe(true);
 const first=full.bundle.sections![0]!;expect(first.artifactId).toBe(verified.id);
 const just=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:Math.ceil(full.bundle.estimatedTokens!)-200});
 expect(just.bundle.selectedArtifacts).toContain(verified.id);expect(just.bundle.selectedArtifacts).not.toContain(inferred.id);expect(just.bundle.overBudget).toBe(false);
});
it('reuses scoped retrieval for another agent and invalidates cache after source changes',async()=>{
 const f=await contextFixture();fixtures.push(f);const artifact=f.store.publish(f.input());
 const a=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:5000}),b=await f.broker.buildBundle({taskId:'task_1',agentId:'claude-code',tokenBudget:5000});
 expect(b.cacheHit).toBe(true);expect(a.bundle.selectedArtifacts).toEqual(b.bundle.selectedArtifacts);expect(b.bundle.targetAgent).toBe('claude-code');
 writeFileSync(join(f.repo,'app.ts'),'export const changed=4;');await f.index.reindexChanged();const changed=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:5000});expect(changed.cacheHit).toBe(false);expect(changed.bundle.selectedArtifacts).not.toContain(artifact.id);
 expect(f.store.blobs.text(a.contentRef)).toContain('Use the add API');
});
it('keeps original research refs when using an explicitly provided summary',async()=>{
 const f=await contextFixture();fixtures.push(f);const research=f.store.publish(f.input({kind:'research',content:'Full research data '.repeat(300),summary:'Short research handoff'}));
 const result=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:1500});
 expect(result.bundle.sourceRefs).toContain(research.contentRef);expect(result.bundle.sourceRefs).toContain(research.summaryRef);expect(result.bundle.sections?.find(s=>s.artifactId===research.id)?.content).toBe('Short research handoff');
});
it('does not share task/session data through caches or permit acceptance/base overrides',async()=>{
 const f=await contextFixture();fixtures.push(f);const privateArtifact=f.store.publish(f.input());
 const other=await f.broker.buildBundle({taskId:'task_2',agentId:'codex',tokenBudget:5000});expect(other.bundle.selectedArtifacts).not.toContain(privateArtifact.id);
 await expect(f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:5000,acceptance:['different']})).rejects.toThrow('Acceptance');
 await expect(f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:5000,baseCommit:'b'.repeat(40)})).rejects.toThrow('base');
});
it('cache keys include canonical path hashes, query and summarizer version',()=>{
 const base={repositoryId:'proj_a',baseCommit:'a'.repeat(40),pathHashes:{a:'a'.repeat(64),b:'b'.repeat(64)},query:'add',summarizerVersion:'v1'};
 expect(buildContextCacheKey(base)).toBe(buildContextCacheKey({...base,pathHashes:{b:base.pathHashes.b,a:base.pathHashes.a}}));
 expect(buildContextCacheKey(base)).not.toBe(buildContextCacheKey({...base,query:'other'}));expect(buildContextCacheKey(base)).not.toBe(buildContextCacheKey({...base,summarizerVersion:'v2'}));
});
it('never rebuilds an older superseded decision into a current bundle',async()=>{
 const f=await contextFixture();fixtures.push(f);const old=f.store.publish(f.input({content:'Old decision'})),current=f.store.publish(f.input({content:'New decision'}));
 const result=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:5000});expect(result.bundle.selectedArtifacts).toContain(current.id);expect(result.bundle.selectedArtifacts).not.toContain(old.id);
 expect(f.store.getArtifact(old.id)?.contentRef).toBe(old.contentRef);
});
it('keeps a built bundle immutable after later invalidation and rejects DB bundle edits',async()=>{
 const f=await contextFixture();fixtures.push(f);const a=f.store.publish(f.input());const built=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:5000});
 const bytes=f.store.blobs.text(built.contentRef);f.store.invalidate(a.id,'later invalidation');const next=await f.broker.buildBundle({taskId:'task_1',agentId:'codex',tokenBudget:5000});
 expect(f.store.blobs.text(built.contentRef)).toBe(bytes);expect(next.bundle.selectedArtifacts).not.toContain(a.id);expect(next.cacheHit).toBe(false);
 expect(()=>f.db.prepare('UPDATE context_bundles SET estimated_tokens=0').run()).toThrow('immutable');
});
