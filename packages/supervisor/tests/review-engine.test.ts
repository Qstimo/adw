import { afterEach, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextBundleSchema } from '@adw/contracts';
import { capturePatchSnapshot } from '@adw/git';
import { fixture, git } from './helpers.js';
import { ReviewEngine, SECURITY_CHECKLIST, type ReviewInput, type SessionOutcome } from '../src/review/engine.js';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(() => f?.close());
async function setup() {
    f = await fixture();
    const wt = await f.manager.createTaskWorktree({ taskId: 'task_test' });
    writeFileSync(join(wt.path, 'value.txt'), 'good');
    await git(wt.path, 'add', '.');
    await git(wt.path, 'commit', '-m', 'change');
    const snapshot = await capturePatchSnapshot(f.manager, wt);
    const checks = await f.verifier.run({ worktreePath: wt.path, baseCommit: wt.baseCommit, checks: f.input.checks });
    const requests: {
        prompt: string;
        category: string;
    }[] = [];
    const input: ReviewInput = { task: { id: 'task_test', intent: 'Keep good', acceptance: ['  exact criteria\nall clauses  '], outOfScope: ['no edits'] }, worktree: wt, snapshot, checks: checks.results, executorSessions: [{ agentId: 'codex', sessionId: 'executor', providerSessionId: 'provider-executor' }], signal: new AbortController().signal, selectReviewer: () => f.adapter, buildBundle: async (agentId) => {
            const bundle = ContextBundleSchema.parse({ taskId: 'task_test', targetAgent: agentId, baseCommit: wt.baseCommit, acceptance: ['  exact criteria\nall clauses  '], selectedArtifacts: [], sourceRefs: [], tokenBudget: 8000, generatedAt: new Date().toISOString() });
            const path = join(f.root, 'bundle.json');
            writeFileSync(path, JSON.stringify(bundle));
            return { bundle, bundlePath: path, contentRef: 'sha256:' + 'a'.repeat(64), cacheHit: false, omittedArtifacts: [] };
        }, runSession: async (_adapter, request) => {
            requests.push(request);
            return { agentId: 'codex', sessionId: 'review-' + request.category, providerSessionId: 'provider-review-' + request.category, summary: JSON.stringify({ category: request.category, remarks: [] }) };
        } };
    return { input, engine: new ReviewEngine(f.manager, f.verifier.evidenceStore), requests };
}
it('runs code/security as independent fresh sessions and includes exact diff/acceptance/evidence/checklist', async () => {
    const { input, engine, requests } = await setup();
    const review = await engine.review(input);
    expect(review.status).toBe('approved');
    expect(review.reviewerSessions.map(session => session.sessionId)).toEqual(['review-code', 'review-security']);
    expect(requests[0]!.prompt).toContain(JSON.stringify(input.task.acceptance));
    expect(requests[0]!.prompt).toContain('+good');
    expect(requests[1]!.prompt).toContain(SECURITY_CHECKLIST);
    expect(review.evidenceRefs.length).toBeGreaterThan(3);
});
it('returns changes_requested for any blocking finding and retains raw response provenance', async () => {
    const { input, engine } = await setup();
    input.runSession = async (_adapter, request) => ({ agentId: 'codex', sessionId: 'r-' + request.category, summary: JSON.stringify({ category: request.category, remarks: request.category === 'code' ? [{ id: 'b1', category: 'code', severity: 'blocking', message: 'No edge case guard', path: 'value.txt', evidenceRefs: [] }] : [] }) });
    const review = await engine.review(input);
    expect(review.status).toBe('changes_requested');
    expect(review.blockingCount).toBe(1);
    expect(review.remarks[0]!.verificationStatus).toBe('inferred');
    expect(review.remarks[0]!.evidenceRefs).toHaveLength(2);
});
it.each(['not JSON', '```json\n{"category":"code","remarks":[]}\n```', '{"category":"code","remarks":[],"approved":true}'])('fails closed for malformed or extra-field review: %s', async (summary) => {
    const { input, engine } = await setup();
    const original = input.runSession;
    input.runSession = async (adapter, request) => request.category === 'code' ? { agentId: 'codex', sessionId: 'bad-review', summary } : original(adapter, request);
    const review = await engine.review(input);
    expect(review.status).toBe('inconclusive');
    expect(review.completedCategories).toEqual(['security']);
});
it.each(['runtime', 'provider'])('rejects reuse of the executor %s session identity', async (kind) => {
    const { input, engine } = await setup();
    input.runSession = async () => ({ agentId: 'codex', sessionId: kind === 'runtime' ? 'executor' : 'new-runtime', providerSessionId: kind === 'provider' ? 'provider-executor' : 'fresh-provider', summary: '{"category":"code","remarks":[]}' });
    expect((await engine.review(input)).status).toBe('inconclusive');
});
it('detects review edits and refuses to certify a previously green snapshot', async () => {
    const { input, engine } = await setup();
    input.runSession = async () => {
        writeFileSync(join(input.worktree.path, 'value.txt'), 'changed by reviewer');
        return { agentId: 'codex', sessionId: 'review-edited', summary: '{"category":"code","remarks":[]}' };
    };
    const review = await engine.review(input);
    expect(review.status).toBe('inconclusive');
    expect(review.snapshotValid).toBe(false);
    expect(review.reason).toContain('changed');
});
it.each(['path', 'evidence'])('rejects an invented %s in a reviewer remark', async (invalid) => {
    const { input, engine } = await setup();
    input.runSession = async (_adapter, request) => ({ agentId: 'codex', sessionId: 'r-' + request.category, summary: JSON.stringify({ category: request.category, remarks: [{ id: 'x', category: request.category, severity: 'advisory', message: 'Invented', path: invalid === 'path' ? 'outside.ts' : 'value.txt', evidenceRefs: invalid === 'evidence' ? ['sha256:' + 'f'.repeat(64)] : [] }] }) });
    expect((await engine.review(input)).status).toBe('inconclusive');
});
it('does not run a reviewer for failed checks or missing executor identity', async () => {
    const { input, engine, requests } = await setup();
    input.checks[0]!.exitCode = 1;
    expect((await engine.review(input)).status).toBe('inconclusive');
    expect(requests).toHaveLength(0);
    input.checks[0]!.exitCode = 0;
    input.executorSessions = [];
    expect((await engine.review(input)).status).toBe('inconclusive');
});
it('rejects reuse of a provider session between code and security passes', async () => {
    const { input, engine } = await setup();
    input.runSession = async (_adapter, request) => ({ agentId: 'codex', sessionId: 'new-' + request.category, providerSessionId: 'same-provider', summary: JSON.stringify({ category: request.category, remarks: [] }) });
    const review = await engine.review(input);
    expect(review.status).toBe('inconclusive');
    expect(review.completedCategories).toEqual(['code']);
});
it('refuses oversized check output without silently truncating the review input', async () => {
    const { input, engine, requests } = await setup();
    input.checks[0]!.artifactRefs[0] = f.verifier.evidenceStore.put('x'.repeat(256 * 1024 + 1));
    const review = await engine.review(input);
    expect(review.status).toBe('inconclusive');
    expect(requests).toHaveLength(0);
    expect(review.reason).toContain('lossless');
});
it('does not approve binary changes without additional independent evidence', async () => {
    const { input, engine, requests } = await setup();
    writeFileSync(join(input.worktree.path, 'binary.bin'), Buffer.from([0, 1]));
    await git(input.worktree.path, 'add', '.');
    await git(input.worktree.path, 'commit', '-m', 'binary');
    input.snapshot = await capturePatchSnapshot(f.manager, input.worktree);
    const review = await engine.review(input);
    expect(review.status).toBe('inconclusive');
    expect(review.reason).toContain('Binary');
    expect(requests).toHaveLength(0);
});
