import {afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {execFile,spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {DesktopMethods,DesktopResponseSchema,type DesktopMethod,type DesktopParams} from '@adw/contracts';
import {fixture} from '../../supervisor/tests/helpers.js';
const execute=promisify(execFile),root=fileURLToPath(new URL('../../../',import.meta.url));
const binary=join(root,'packages/core/dist/desktop-core.mjs');
let f:Awaited<ReturnType<typeof fixture>>,child:ChildProcessWithoutNullStreams|undefined;
beforeAll(async()=>{await execute(process.execPath,[join(root,'scripts/build-desktop-core.mjs')],{cwd:root,timeout:30000});},35000);
beforeEach(async()=>{f=await fixture();});
afterEach(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(resolve=>child!.once('exit',()=>resolve()));}child=undefined;f?.close();});
it('runs a compiled system Node health check without an Electron runtime',async()=>{
 const result=await execute(process.execPath,[binary,'--data-dir',join(f.root,'headless'),'--health'],{cwd:root,timeout:10000});expect(JSON.parse(result.stdout)).toEqual({status:'ok'});expect(result.stderr).toBe('');
 // Bundling must carry runtime assets, not rely on source-relative import.meta.url paths.
 expect(readFileSync(join(root,'packages/core/dist/assets/compat/codex/0.166.0.json'),'utf8')).toContain('codex-jsonl-v1');
 expect(readFileSync(join(root,'packages/core/dist/assets/verifier/playwright-worker.mjs'),'utf8')).toContain('scenario_observation');
});
it('exchanges real pipe messages, locks only with the host secret, indexes sources and closes on EOF',async()=>{
 const token=randomUUID()+randomUUID();child=spawn(process.execPath,[binary,'--data-dir',join(f.root,'pipe')],{cwd:root,env:{...process.env,ADW_DESKTOP_SESSION_TOKEN:token},stdio:['pipe','pipe','pipe']});
 const processClosed=new Promise<number|null>(resolve=>child!.once('exit',resolve));
 const pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();let stdout='',stderr='',buffer='';
 child.stderr.on('data',chunk=>{stderr+=chunk;});
 child.stdout.on('data',chunk=>{stdout+=chunk;buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop()!;for(const line of lines){try{const response=DesktopResponseSchema.parse(JSON.parse(line)),entry=pending.get(response.id);if(entry){pending.delete(response.id);entry.resolve(response);}}catch(error){for(const entry of pending.values())entry.reject(new Error(String(error)));}}});
 const send=(method:DesktopMethod,params:unknown,authorization?:string):Promise<any>=>new Promise((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});child!.stdin.write(JSON.stringify({id,method,params,...(authorization?{authorization}:{})})+'\n');});
 async function call<M extends DesktopMethod>(method:M,params:DesktopParams<M>,authorization?:string){const response=await send(method,params,authorization);if(!response.ok)throw new Error(response.error.message);return DesktopMethods[method].result.parse(response.result) as any;}
 child.once('exit',(code,signal)=>{for(const entry of pending.values())entry.reject(new Error('Core exited before replying: '+JSON.stringify({code,signal,stderr,stdout})));});
 const project=await call('project.open',{path:f.repo});const task=await call('task.createDraft',{projectId:project.id,baseBranch:'main',intent:'Сохранить точный текст',acceptance:['  критерий\nстрока 2  '],outOfScope:[],checks:f.input.checks,limits:{...f.input.limits,maxFixCycles:1}});
 const confirm={taskId:task.spec.id,expectedSpecHash:task.specHash,expectedPolicyHash:task.policyHash};expect(await send('task.confirmSpec',confirm,'wrong-token')).toMatchObject({ok:false});const locked=await call('task.confirmSpec',confirm,token);expect(locked.spec.acceptance).toEqual(['  критерий\nстрока 2  ']);
 const map=await call('context.getProjectMap',{taskId:task.spec.id});expect(map.files.some((file:any)=>file.path==='value.txt')).toBe(true);expect(stdout).not.toContain(token);expect(stderr).toBe('');child.stdin.end();expect(await processClosed).toBe(0);expect(f.adapter.calls).toEqual([]);
},20000);
it('refuses a malformed host session token before starting a core service',async()=>{
 await expect(execute(process.execPath,[binary,'--data-dir',join(f.root,'bad-token'),'--health'],{env:{...process.env,ADW_DESKTOP_SESSION_TOKEN:'short'},timeout:10000})).rejects.toMatchObject({stderr:expect.stringContaining('Invalid desktop host session token')});
});
