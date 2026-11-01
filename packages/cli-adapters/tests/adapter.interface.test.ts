import { afterEach, expect, it } from 'vitest';
import { rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentEventSchema } from '@adw/contracts';
import { fixture, collect } from './helpers.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const id of ['codex', 'claude-code'] as const) {
  it(`${id}: discovers an env-configured CLI and yields typed events in the chosen cwd`, async () => {
    const f = fixture(id); roots.push(f.root);
    const found = await f.adapter.discover();
    expect(found.binaryPath).toBe(f.binaryPath);
    expect(found.version).toBe(id === 'codex' ? '0.166.0' : '2.1.236');
    const caps = await f.adapter.probeCapabilities(found.version);
    expect(caps.execution.headless).toBe('supported'); expect(caps.output.format).toBe('jsonl');
    const prompt = "--dangerously-bypass-approvals-and-sandbox; $(touch MUST_NOT_EXIST)\n\n  keep whitespace  ";
    const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt, timeoutMs: 5000 }));
    for (const event of events) expect(AgentEventSchema.safeParse(event).success).toBe(true);
    expect(events[0]!.type).toBe('session_started');
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'completed', summary: 'Привет 🌍', providerSessionId: '11111111-1111-4111-8111-111111111111' });
    expect(new Set(events.map(event => event.sessionId)).size).toBe(1);
    expect(events.some(event => event.type === 'tool_call')).toBe(true);
    expect(events.some(event => event.type === 'tool_result')).toBe(true);
    expect(events.find(event => event.type === 'usage')).toMatchObject({ tokens: 12 });
    const invocation = JSON.parse(readFileSync(join(f.worktreePath, 'invocation.json'), 'utf8'));
    expect(invocation.cwd).toBe(f.worktreePath); expect(invocation.prompt).toBe(prompt);
    expect(invocation.args).not.toContain(prompt); expect(invocation.args.join(' ')).not.toContain('dangerously');
    expect(invocation.args).toEqual(id === 'codex' ? ['exec','--json','--sandbox','workspace-write','-'] : ['--print','--output-format','stream-json','--verbose']);
    const logDir = join(f.root, 'logs', events[0]!.sessionId);
    const logged = readFileSync(join(logDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(logged).toEqual(events);
    expect(readFileSync(join(logDir, 'stdout.log'), 'utf8')).toContain(id === 'codex' ? 'turn.completed' : '"type":"result"');
    expect(readFileSync(join(logDir, 'stderr.log'), 'utf8')).toContain('diagnostic');
    expect(JSON.parse(readFileSync(join(logDir, 'metadata.json'), 'utf8')).exit.code).toBe(0);
    expect(readdirSync(f.worktreePath)).toEqual(['invocation.json']);
  });
  it(`${id}: resumes an explicit provider session ID with stdin input`, async () => {
    const f = fixture(id); roots.push(f.root);
    const sid = '22222222-2222-4222-8222-222222222222';
    const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'Continue', timeoutMs: 5000, resumeSessionId: sid }));
    expect(events.at(-1)).toMatchObject({ type: 'completed', providerSessionId: sid });
    const invocation = JSON.parse(readFileSync(join(f.worktreePath, 'invocation.json'), 'utf8'));
    expect(invocation.args).toContain(sid); expect(invocation.args).not.toContain('--last');
    expect(invocation.args).toEqual(id === 'codex' ? ['exec','--json','--sandbox','workspace-write','resume',sid,'-'] : ['--print','--output-format','stream-json','--verbose','--resume',sid]);
  });
  it(`${id}: preserves acceptance criteria in a validated context bundle`, async () => {
    const f = fixture(id); roots.push(f.root);
    const bundle = { taskId: 'task_1', targetAgent: id, baseCommit: 'a'.repeat(40), acceptance: ['exact API shape; no omitted clauses'], selectedArtifacts: [], sourceRefs: [], tokenBudget: 300, generatedAt: '2026-10-31T00:00:00Z' };
    const bundlePath = join(f.root, 'bundle.json'); writeFileSync(bundlePath, JSON.stringify(bundle));
    const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'Do task', timeoutMs: 5000, bundlePath }));
    expect(events.at(-1)!.type).toBe('completed');
    const invocation = JSON.parse(readFileSync(join(f.worktreePath, 'invocation.json'), 'utf8'));
    expect(invocation.prompt).toContain(JSON.stringify(bundle));
  });
}
it('rejects an invalid resume ID before starting a CLI', async () => {
  const f = fixture('codex'); roots.push(f.root);
  const events = await collect(f.adapter.startSession({ worktreePath: f.worktreePath, prompt: 'x', timeoutMs: 5000, resumeSessionId: '--last' }));
  expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: 'failed', code: 'invalid_input' });
  expect(readdirSync(f.worktreePath)).toEqual([]);
});

it('rejects a context bundle targeting another provider before process launch', async () => {
  const f = fixture('codex'); roots.push(f.root);
  const bundlePath = join(f.root, 'bundle.json');
  writeFileSync(bundlePath, JSON.stringify({ taskId:'task_1',targetAgent:'claude-code',baseCommit:'a'.repeat(40),acceptance:['required'],selectedArtifacts:[],sourceRefs:[],tokenBudget:10,generatedAt:'2026-10-31T00:00:00Z' }));
  const events = await collect(f.adapter.startSession({worktreePath:f.worktreePath,prompt:'x',timeoutMs:5000,bundlePath}));
  expect(events.at(-1)).toMatchObject({type:'failed',code:'invalid_input'});
  expect(readdirSync(f.worktreePath)).toEqual([]);
});
for(const id of ['codex','claude-code'] as const){
 it(`${id}: starts reviewer with explicit read-only policy and no resume`,async()=>{
  const f=fixture(id);roots.push(f.root);const events=await collect(f.adapter.startSession({worktreePath:f.worktreePath,prompt:'Review only',timeoutMs:5000,role:'reviewer'}));expect(events.at(-1)?.type).toBe('completed');const invocation=JSON.parse(readFileSync(join(f.worktreePath,'invocation.json'),'utf8'));
  if(id==='codex'){expect(invocation.args).toContain('read-only');expect(invocation.args).not.toContain('workspace-write');}
  else{expect(invocation.args).toContain('--tools');expect(invocation.args[invocation.args.indexOf('--tools')+1]).toBe('');expect(invocation.args).toContain('--strict-mcp-config');}
 });
}
it('refuses to resume a session in reviewer role',async()=>{
 const f=fixture('codex');roots.push(f.root);const events=await collect(f.adapter.startSession({worktreePath:f.worktreePath,prompt:'review',timeoutMs:5000,role:'reviewer',resumeSessionId:'22222222-2222-4222-8222-222222222222'}));expect(events.at(-1)).toMatchObject({type:'failed',code:'invalid_input'});expect(readdirSync(f.worktreePath)).toEqual([]);
});
