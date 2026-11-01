import {afterEach,expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {contextFixture} from './broker-helpers.js';
import {createContextAPI} from '../src/index.js';
const fixtures:Awaited<ReturnType<typeof contextFixture>>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
const claim={claim:'The add API passes checks',affectedPaths:['app.ts'],sourcePaths:['app.ts'],producerAgent:'codex',verificationStatus:'inferred' as const};
it('publishes findings atomically into a task namespace without promoting guesses',async()=>{
 const f=await contextFixture();fixtures.push(f);const finding=f.api.write.publishFinding({...claim,sourceHashes:{'app.ts':f.input().sourceHashes['app.ts']!}});
 expect(finding.verificationStatus).toBe('inferred');expect(f.store.getArtifact(finding.artifactId)?.visibility).toBe('task');expect(f.api.read.getTaskFindings()[0]?.finding.id).toBe(finding.id);
 expect(()=>f.api.write.promoteFinding(finding.id)).toThrow('trusted');expect(()=>f.trusted.write.promoteFinding(finding.id)).toThrow('verified');
 expect(()=>f.api.write.publishFinding({...claim,sourceHashes:f.input().sourceHashes,verificationStatus:'verified',evidenceRefs:[f.evidence]})).toThrow('trusted');
 expect(()=>f.db.prepare('UPDATE findings SET claim=? WHERE id=?').run('overwrite',finding.id)).toThrow('immutable');
});
it('promotes independently verified fresh findings into new project artifacts idempotently',async()=>{
 const f=await contextFixture();fixtures.push(f);const finding=f.trusted.write.publishFinding({...claim,sourceHashes:f.input().sourceHashes,verificationStatus:'verified',evidenceRefs:[f.evidence]});
 const original=f.store.getArtifact(finding.artifactId)!;const promoted=f.trusted.write.promoteFinding(finding.id);
 expect(promoted.id).not.toBe(original.id);expect(promoted.visibility).toBe('project');expect(f.store.getArtifact(original.id)?.visibility).toBe('task');expect(f.trusted.write.promoteFinding(finding.id).id).toBe(promoted.id);
 const other=createContextAPI(f.store,f.index,f.broker,{taskId:'task_2'});expect(other.read.getArtifact(original.id)).toBeUndefined();expect(other.read.getArtifact(promoted.id)?.artifact.id).toBe(promoted.id);
 expect(()=>other.write.promoteFinding(finding.id)).toThrow();
});
it('refuses promotion once source files change',async()=>{
 const f=await contextFixture();fixtures.push(f);const finding=f.trusted.write.publishFinding({...claim,sourceHashes:f.input().sourceHashes,verificationStatus:'verified',evidenceRefs:[f.evidence]});
 writeFileSync(join(f.repo,'app.ts'),'export const changed=3;');await f.index.reindexChanged();expect(()=>f.trusted.write.promoteFinding(finding.id)).toThrow('Stale');
 expect(f.api.read.getTaskFindings()[0]?.freshness.fresh).toBe(false);
});
it('isolates session artifacts and forbids scope spoofing on agent writes',async()=>{
 const f=await contextFixture();fixtures.push(f);const a=createContextAPI(f.store,f.index,f.broker,{taskId:'task_1',sessionId:'session_a'}),b=createContextAPI(f.store,f.index,f.broker,{taskId:'task_1',sessionId:'session_b'});
 const {taskId,baseCommit,...input}=f.input({visibility:'session'});const artifact=a.write.publishArtifact(input);
 expect(a.read.getArtifact(artifact.id)).toBeDefined();expect(b.read.getArtifact(artifact.id)).toBeUndefined();expect(f.api.read.getArtifact(artifact.id)).toBeUndefined();
 expect(()=>a.write.publishArtifact({...input,taskId:'task_2'} as any)).toThrow('scope');expect(()=>a.write.publishArtifact({...input,visibility:'project',confidence:'verified',evidenceRefs:[f.evidence]})).toThrow('trusted');
});
it('rolls back the finding/artifact/audit together when storing the finding fails',async()=>{
 const f=await contextFixture();fixtures.push(f);f.db.exec("CREATE TRIGGER finding_failure BEFORE INSERT ON findings BEGIN SELECT RAISE(ABORT,'forced failure'); END;");
 expect(()=>f.api.write.publishFinding({...claim,sourceHashes:f.input().sourceHashes})).toThrow('forced failure');
 expect(f.store.list()).toEqual([]);expect(f.store.getTaskFindings('task_1')).toEqual([]);expect(f.db.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({n:0});
});
