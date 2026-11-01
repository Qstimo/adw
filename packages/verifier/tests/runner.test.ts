import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EvidenceStore, VerifierRunner, environmentFingerprint } from '../src/index.js';
let dir: string, runner: VerifierRunner;
const baseCommit = 'a'.repeat(40);
beforeEach(() => {dir=mkdtempSync(join(tmpdir(),'adw-verify-'));runner=new VerifierRunner(new EvidenceStore(join(dir,'evidence')));});
afterEach(() => rmSync(dir,{recursive:true,force:true}));
const node = (code: string) => { const file=join(dir,`${randomUUID()}.cjs`); writeFileSync(file,code); return `"${process.execPath}" "${file}"`; };
it('runs green checks and persists stdout, stderr and metadata by content hash', async () => {
 const run=await runner.run({worktreePath:dir,baseCommit,checks:[{name:'unit',command:node('const fs=require("node:fs");fs.writeSync(1,"ok");fs.writeSync(2,"diagnostic")'),blocking:true}]});
 expect(run.readyForReview).toBe(true);const result=run.results[0]!;
 expect(result.exitCode).toBe(0);expect(result.baseCommit).toBe(baseCommit);expect(result.environmentFingerprint).toMatch(/^[a-f0-9]{64}$/);
 expect(runner.evidenceStore.get(result.artifactRefs[0]!).toString()).toContain('ok');
 expect(runner.evidenceStore.get(result.artifactRefs[1]!).toString()).toContain('diagnostic');
});
it('blocks known red results and does not treat required missing commands as green', async () => {
 const run=await runner.run({worktreePath:dir,baseCommit,checks:[{name:'red',command:node('process.exit(2)'),blocking:true},{name:'missing',command:'adw_nonexistent_binary_123456',blocking:true}]});
 expect(run.readyForReview).toBe(false);expect(run.results[0]!.exitCode).toBe(2);expect(run.results[1]!.notVerified).toBe(true);
});
it('marks optional unavailable checks notVerified without blocking passing required checks', async () => {
 const run=await runner.run({worktreePath:dir,baseCommit,checks:[{name:'required',command:node('process.exit(0)'),blocking:true},{name:'optional',command:'adw_nonexistent_binary_123456',blocking:false}]});
 expect(run.readyForReview).toBe(true);expect(run.results[1]!.notVerified).toBe(true);expect(run.warnings).toHaveLength(1);
});
it('times out an entire process group and records incomplete verification', async () => {
 const run=await runner.run({worktreePath:dir,baseCommit,timeoutMs:150,checks:[{name:'hang',command:node('setInterval(()=>{},1000)'),blocking:true}]});
 expect(run.readyForReview).toBe(false);expect(run.results[0]!.notVerified).toBe(true);
 expect(runner.evidenceStore.get(run.results[0]!.artifactRefs[2]!).toString()).toContain('timeout');
},5000);
it('caps output and blocks readiness when logs were truncated', async () => {
 const run=await runner.run({worktreePath:dir,baseCommit,maxOutputBytes:32,checks:[{name:'noisy',command:node('require("node:fs").writeSync(1,"x".repeat(10000))'),blocking:true}]});
 expect(run.readyForReview).toBe(false);expect(run.results[0]!.notVerified).toBe(true);
 expect(runner.evidenceStore.get(run.results[0]!.artifactRefs[0]!).length).toBeLessThanOrEqual(32);
});
it('rejects empty, optional-only and invalid-timeout suites', async () => {
 for(const checks of [[],[{name:'optional',command:'true',blocking:false}],[{name:'bad',command:'true',blocking:true,timeoutMs:0}]]) await expect(runner.run({worktreePath:dir,baseCommit,checks})).rejects.toThrow();
});
it('fingerprint changes with lockfile and environment and detects corrupt evidence', () => {
 const before=environmentFingerprint(dir,{});writeFileSync(join(dir,'pnpm-lock.yaml'),'changed');
 expect(environmentFingerprint(dir,{})).not.toBe(before);expect(environmentFingerprint(dir,{FLAG:'1'})).not.toBe(environmentFingerprint(dir,{}));
 const ref=runner.evidenceStore.put('hello');expect(runner.evidenceStore.put('hello')).toBe(ref);
 const hash=ref.slice(7);writeFileSync(join(dir,'evidence',hash.slice(0,2),hash),'corrupt');expect(()=>runner.evidenceStore.get(ref)).toThrow('hash');
});
it('runs the actual demo fixture with green typecheck/unit and forced red unit', async () => {
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const demo=join(dir,'demo');mkdirSync(demo);
 cpSync(join(root,'fixtures/demo-repo/src'),join(demo,'src'),{recursive:true});
 cpSync(join(root,'fixtures/demo-repo/public'),join(demo,'public'),{recursive:true});
 const manifest=JSON.parse(readFileSync(join(root,'fixtures/demo-repo/package.json'),'utf8'));writeFileSync(join(demo,'package.json'),JSON.stringify(manifest));
 writeFileSync(join(demo,'tsconfig.json'),JSON.stringify({extends:join(root,'tsconfig.base.json'),compilerOptions:{jsx:'react-jsx'},include:['src']}));
 mkdirSync(join(demo,'node_modules/@types'),{recursive:true});
 for(const name of ['react','react-dom']) symlinkSync(join(root,'fixtures/demo-repo/node_modules',name),join(demo,'node_modules',name),'dir');
 for(const name of ['react','react-dom']) symlinkSync(join(root,'fixtures/demo-repo/node_modules/@types',name),join(demo,'node_modules/@types',name),'dir');
 symlinkSync(join(root,'node_modules/vitest'),join(demo,'node_modules/vitest'),'dir');
 symlinkSync(join(root,'node_modules/@types/node'),join(demo,'node_modules/@types/node'),'dir');
 const tsc=join(root,'node_modules/typescript/bin/tsc');const vitest=join(root,'node_modules/vitest/vitest.mjs');
 const unit=`"${process.execPath}" "${vitest}" run --maxWorkers=1 --minWorkers=1`;
 const green=await runner.run({worktreePath:demo,baseCommit,timeoutMs:20000,checks:[{name:'typecheck',command:`"${process.execPath}" "${tsc}" --noEmit`,blocking:true},{name:'unit',command:unit,blocking:true}]});
 expect(green.results.map(r=>r.exitCode)).toEqual([0,0]);expect(green.readyForReview).toBe(true);
 const red=await runner.run({worktreePath:demo,baseCommit,env:{FAIL_UNIT:'1'},checks:[{name:'unit',command:unit,blocking:true}]});
 expect(red.readyForReview).toBe(false);expect(red.results[0]!.exitCode).toBe(1);
},30000);

it.skipIf(process.platform !== 'linux')('timeout terminates descendants as well as the parent shell', async () => {
 const childFile=join(dir,'child.cjs'),pidFile=join(dir,'child.pid');
 writeFileSync(childFile,'setInterval(()=>{},1000)');
 const parent=node(`const cp=require("node:child_process");const fs=require("node:fs");const child=cp.spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
 const run=await runner.run({worktreePath:dir,baseCommit,timeoutMs:500,checks:[{name:'tree',command:parent,blocking:true}]});
 expect(run.readyForReview).toBe(false);expect(run.results[0]!.notVerified).toBe(true);
 const pid=Number(readFileSync(pidFile,'utf8'));
 // A reaped process is absent; a zombie has exited and only awaits OS reaping.
 try { expect(readFileSync(`/proc/${pid}/status`,'utf8')).toMatch(/State:\s+Z/); }
 catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
},5000);
it('honors pre-aborted cancellation before launching any command',async()=>{
 const controller=new AbortController();controller.abort(new Error('cancelled before start'));
 await expect(runner.run({worktreePath:dir,baseCommit,checks:[{name:'never',command:'true',blocking:true}],signal:controller.signal})).rejects.toThrow('before start');
});
it('kills an active check on cancellation and does not launch subsequent checks',async()=>{
 const marker=join(dir,'ready'),later=join(dir,'later'),controller=new AbortController();
 const running=runner.run({worktreePath:dir,baseCommit,signal:controller.signal,checks:[{name:'active',command:node(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`),blocking:true},{name:'later',command:node(`require('node:fs').writeFileSync(${JSON.stringify(later)},'bad')`),blocking:true}]});
 const {existsSync}=await import('node:fs');while(!existsSync(marker))await new Promise(resolve=>setTimeout(resolve,5));controller.abort();const run=await running;
 expect(run.readyForReview).toBe(false);expect(run.results).toHaveLength(1);expect(run.results[0]!.notVerified).toBe(true);expect(existsSync(later)).toBe(false);expect(runner.evidenceStore.get(run.results[0]!.artifactRefs[2]!).toString()).toContain('cancelled');
});
