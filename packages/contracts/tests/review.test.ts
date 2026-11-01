import { expect, it } from 'vitest';
import { ReviewRemarkSchema, ReviewResponseSchema, ReviewVerdictSchema } from '../src/index.js';
const ref = 'sha256:' + 'a'.repeat(64), snapshot = { taskId: 'task_1', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), patchHash: 'c'.repeat(64) };
const remark = { id: 'r1', category: 'code', severity: 'blocking', message: 'Exact issue', path: 'src/app.ts', startLine: 2, endLine: 3, evidenceRefs: [ref] };
const verdict = { id: 'review_1', taskId: 'task_1', snapshot, snapshotValid: true, remarks: [], blockingCount: 0, status: 'approved', completedCategories: ['code', 'security'], reviewerSessions: [{ agentId: 'codex', sessionId: 'r1', category: 'code' }, { agentId: 'claude-code', sessionId: 'r2', category: 'security' }], evidenceRefs: [ref] };
it('validates structured remarks while forbidding path traversal and fabricated verified claims', () => {
    expect(ReviewRemarkSchema.parse(remark).verificationStatus).toBe('inferred');
    for (const changed of [{ path: '../secret' }, { path: '/secret' }, { startLine: 0 }, { endLine: 1 }, { path: undefined }, { verificationStatus: 'verified' }, { evidenceRefs: ['invented'] }])
        expect(ReviewRemarkSchema.safeParse({ ...remark, ...changed }).success).toBe(false);
});
it('rejects contradictory counts/status, incomplete passes and repeated reviewer sessions', () => {
    expect(ReviewVerdictSchema.safeParse(verdict).success).toBe(true);
    for (const changed of [{ remarks: [remark] }, { blockingCount: 1 }, { completedCategories: ['code'] }, { snapshotValid: false }, { taskId: 'task_other' }, { reviewerSessions: [verdict.reviewerSessions[0], verdict.reviewerSessions[0]] }, { evidenceRefs: [] }])
        expect(ReviewVerdictSchema.safeParse({ ...verdict, ...changed }).success).toBe(false);
    expect(ReviewVerdictSchema.safeParse({ ...verdict, remarks: [remark], blockingCount: 1, status: 'changes_requested' }).success).toBe(true);
});
it('requires exact JSON response shape, unique local IDs and the requested category', () => {
    expect(ReviewResponseSchema.safeParse({ category: 'code', remarks: [remark] }).success).toBe(true);
    for (const value of [{ category: 'security', remarks: [remark] }, { category: 'code', remarks: [remark, remark] }, { category: 'code', remarks: [], approved: true }])
        expect(ReviewResponseSchema.safeParse(value).success).toBe(false);
});
