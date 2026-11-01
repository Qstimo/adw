import { afterEach, expect, it } from 'vitest';
import { fixture, FakeAdapter } from './helpers.js';
import { Supervisor } from '../src/index.js';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(() => f?.close());
it('requires two independent review passes and persists their session roles after verification', async () => {
    f = await fixture();
    f.confirm();
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('ready_for_human_review');
    expect(result.review?.status).toBe('approved');
    expect(f.adapter.calls).toHaveLength(1);
    expect(f.adapter.reviewCalls).toHaveLength(2);
    const sessions = f.db.prepare('SELECT role,runtime_session_id FROM agent_sessions ORDER BY rowid').all() as {
        role: string;
        runtime_session_id: string;
    }[];
    expect(sessions.map(session => session.role)).toEqual(['executor', 'reviewer', 'reviewer']);
    expect(new Set(sessions.map(session => session.runtime_session_id)).size).toBe(3);
    expect(f.db.prepare('SELECT status FROM review_runs').get()).toEqual({ status: 'approved' });
});
it('prefers another eligible agent over the executor for both review passes', async () => {
    f = await fixture();
    f.confirm();
    const other = new FakeAdapter('green', 'claude-code');
    const supervisor = new Supervisor({ ...f.options, adapters: [f.adapter, other] });
    const result = await supervisor.run({ ...f.input, nodes: [{ id: 'task', instruction: 'implement', dependsOn: [], agentHint: 'codex' }] });
    expect(result.review?.reviewerSessions.map(session => session.agentId)).toEqual(['claude-code', 'claude-code']);
    expect(f.adapter.reviewCalls).toHaveLength(0);
    expect(other.reviewCalls).toHaveLength(2);
    expect(other.calls).toHaveLength(0);
});
it('blocks readiness and stores task findings with provenance for blocking remarks', async () => {
    f = await fixture();
    f.confirm();
    f.adapter.reviewMode = 'blocking';
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('needs_human');
    expect(result.review?.status).toBe('changes_requested');
    expect(result.review?.blockingCount).toBe(1);
    expect(f.db.prepare('SELECT claim,verification_status FROM findings').get()).toEqual({ claim: 'Independent review issue', verification_status: 'inferred' });
    expect(f.db.prepare('SELECT count(*) AS n FROM review_findings').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) AS n FROM finding_artifacts').get()).toEqual({ n: 1 });
    expect(() => f.db.prepare("UPDATE tasks SET status='accepted'").run()).toThrow('Independent');
    expect(() => f.db.prepare("UPDATE review_runs SET status='approved'").run()).toThrow('immutable');
});
it('keeps advisory remarks for human review without automatically accepting the patch', async () => {
    f = await fixture();
    f.confirm();
    f.adapter.reviewMode = 'advisory';
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('ready_for_human_review');
    expect(result.review?.remarks).toHaveLength(1);
    expect(result.review?.blockingCount).toBe(0);
    expect(f.db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'ready_for_review' });
});
it.each(['malformed', 'mutate'] as const)('refuses a clean ready path for %s review', async (mode) => {
    f = await fixture();
    f.confirm();
    f.adapter.reviewMode = mode;
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('needs_human');
    expect(result.review?.status).toBe('inconclusive');
    if (mode === 'mutate')
        expect(result.review?.snapshotValid).toBe(false);
});
it('charges review usage to the same overall budget and cancels before readiness', async () => {
    f = await fixture();
    f.confirm();
    f.adapter.reviewMode = 'budget';
    f.input.limits.maxTokens = 100;
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('failed');
    expect(result.reason).toContain('budget');
    expect(f.adapter.reviewCalls).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) AS n FROM review_runs').get()).toEqual({ n: 0 });
});
it('times out a stalled reviewer session without leaving an active lease', async () => {
    f = await fixture();
    f.confirm();
    f.adapter.reviewMode = 'hang';
    f.input.limits.sessionTimeoutMs = 1000;
    const result = await f.supervisor.run(f.input);
    expect(result.state).toBe('failed');
    expect(result.reason).toContain('timed out');
    expect(f.db.prepare('SELECT active FROM supervisor_runs').get()).toEqual({ active: 0 });
    expect(f.adapter.cancelled.length).toBeGreaterThan(0);
    expect(f.adapter.reviewCalls).toHaveLength(1);
});
it('does not allow an environment variable to bypass mandatory independent review', async () => {
    f = await fixture();
    f.confirm();
    f.adapter.reviewMode = 'blocking';
    const previous = process.env.ADW_SKIP_REVIEW;
    process.env.ADW_SKIP_REVIEW = '1';
    try {
        const result = await f.supervisor.run(f.input);
        expect(result.review?.status).toBe('changes_requested');
        expect(result.state).toBe('needs_human');
    }
    finally {
        if (previous === undefined)
            delete process.env.ADW_SKIP_REVIEW;
        else
            process.env.ADW_SKIP_REVIEW = previous;
    }
});
it('refuses a web acceptance index outside the locked spec before claiming or launching an agent',async()=>{
 f=await fixture();f.confirm();await expect(f.supervisor.run({...f.input,web:{enabled:true,baseUrl:'http://127.0.0.1',apiSmoke:{enabled:true,requests:[{title:'health',path:'/health'}]},acceptance:[{id:'outside',acceptanceIndex:999,required:true,tests:['health']}]}})).rejects.toThrow('locked spec');expect(f.adapter.calls).toHaveLength(0);expect(f.db.prepare('SELECT count(*) AS n FROM supervisor_runs').get()).toEqual({n:0});
});
