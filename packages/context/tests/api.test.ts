import {afterEach,expect,it} from 'vitest';
import {contextFixture} from './broker-helpers.js';
import {createContextAPI} from '../src/index.js';
const fixtures:Awaited<ReturnType<typeof contextFixture>>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
it('exposes the scoped read/write surface without exposing database or privileged verifier methods',async()=>{
 const f=await contextFixture();fixtures.push(f);expect(f.api.read.getProjectMap().projectId).toBe('proj_test');expect((await f.api.read.searchCode({query:'function add'})).hits).toHaveLength(1);
 const finding=f.api.write.publishFinding({claim:'A finding',verificationStatus:'unverified',affectedPaths:['app.ts'],sourcePaths:['app.ts'],sourceHashes:f.input().sourceHashes,producerAgent:'codex'});
 expect(f.api.read.getArtifact(finding.artifactId)?.content).toBe('A finding');expect(f.api.read.getTaskFindings()).toHaveLength(1);expect(f.api.read.getDecisions()).toEqual([]);expect(f.api.read.getTestHistory()).toEqual([]);
 const bundle=await f.api.read.buildBundle({agentId:'codex',tokenBudget:2000,baseCommit:'a'.repeat(40)});expect(bundle.bundle.taskId).toBe('task_1');expect('publishFinding' in f.api.read).toBe(false);expect('db' in f.api).toBe(false);
 expect(()=>createContextAPI(f.store,f.index,f.broker,{taskId:'task_missing'})).toThrow('not found');
});
it('binds verification permissions immutably when the API is created',async()=>{
 const f=await contextFixture();fixtures.push(f);const options={taskId:'task_1',trusted:false};const api=createContextAPI(f.store,f.index,f.broker,options);options.trusted=true;
 const {taskId,baseCommit,...input}=f.input({visibility:'project',confidence:'verified',evidenceRefs:[f.evidence]});expect(()=>api.write.publishArtifact(input)).toThrow('trusted');
});
