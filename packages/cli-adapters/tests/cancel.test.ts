import { afterEach, expect, it } from 'vitest';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fixture, collect } from './helpers.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function assertDead(pid: number) {
  try { expect(readFileSync(`/proc/${pid}/status`, 'utf8')).toMatch(/State:\s+Z/); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
for (const id of ['codex', 'claude-code'] as const) {
  it.skipIf(process.platform !== 'linux')(`${id}: heartbeat/cancel stops descendants and cancellation is idempotent`, async () => {
    const f = fixture(id, { env: { FAKE_SCENARIO: 'hang' } }); roots.push(f.root);
    const events = [];
    let cancelled = false;
    for await (const event of f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 5000 })) {
      events.push(event);
      if (!cancelled && event.type === 'heartbeat' && existsSync(join(f.worktreePath, 'child.pid'))) {
        cancelled = true; await f.adapter.cancel(event.sessionId); await f.adapter.cancel(event.sessionId);
      }
    }
    expect(cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'cancelled' });
    assertDead(Number(readFileSync(join(f.worktreePath, 'child.pid'), 'utf8')));
  });
  it.skipIf(process.platform !== 'linux')(`${id}: timeout stops a child tree and yields one failed terminal`, async () => {
    const f = fixture(id, { env: { FAKE_SCENARIO: 'hang' } }); roots.push(f.root);
    const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 1200 }));
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'timeout' });
    expect(events.filter(event => event.type === 'failed')).toHaveLength(1);
    assertDead(Number(readFileSync(join(f.worktreePath, 'child.pid'), 'utf8')));
  });
}
it('bounds a stalled consumer queue instead of accumulating unlimited events', async () => {
  const f = fixture('codex', { env: { FAKE_SCENARIO: 'queue' }, maxQueuedEvents: 4, heartbeatMs: 1000 }); roots.push(f.root);
  const iterator = f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 5000 })[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.type).toBe('session_started');
  await delay(300);
  const events = await collect({ [Symbol.asyncIterator]: () => iterator });
  expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'queue_limit' });
});
it('closing the event consumer stops the process and writes a cancelled journal result', async () => {
  const f = fixture('codex', { env: { FAKE_SCENARIO: 'hang' } }); roots.push(f.root);
  const iterator = f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 5000 })[Symbol.asyncIterator]();
  const started = (await iterator.next()).value!;
  await iterator.return?.();
  const journal = join(f.root, 'logs', started.sessionId);
  const metadata = JSON.parse(readFileSync(join(journal, 'metadata.json'), 'utf8'));
  expect(metadata.result).toMatchObject({ type: 'failed', code: 'cancelled' });
  expect(readFileSync(join(journal, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});
it('honors an abort signal before discovery and never invokes the CLI',async()=>{
 const f=fixture('codex');const controller=new AbortController();controller.abort();
 try{const events=await collect(f.adapter.startSession({worktreePath:f.worktreePath,prompt:'never start',timeoutMs:5000,signal:controller.signal}));expect(events.at(-1)).toMatchObject({type:'failed',code:'cancelled'});const {existsSync}=await import('node:fs');expect(existsSync(join(f.worktreePath,'invocation.json'))).toBe(false);}finally{rmSync(f.root,{recursive:true,force:true});}
});
it('aborts a slow preflight probe without waiting for the full session timeout',async()=>{
 const f=fixture('codex',{env:{FAKE_SLOW_HELP:'1'}}),controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),300);
 try{const events=await collect(f.adapter.startSession({worktreePath:f.worktreePath,prompt:'never start model',timeoutMs:10000,signal:controller.signal}));expect(events.at(-1)).toMatchObject({type:'failed',code:'cancelled'});const {existsSync}=await import('node:fs');expect(existsSync(join(f.worktreePath,'invocation.json'))).toBe(false);}finally{clearTimeout(timer);rmSync(f.root,{recursive:true,force:true});}
});
