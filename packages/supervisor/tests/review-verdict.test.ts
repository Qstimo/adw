import { expect, it } from 'vitest';
import { PatchSnapshotSchema } from '@adw/contracts';
import { aggregateReview } from '../src/review/verdict.js';
const base = { id: 'review_test', taskId: 'task_test', snapshot: PatchSnapshotSchema.parse({ taskId: 'task_test', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), patchHash: 'c'.repeat(64) }), snapshotValid: true, remarks: [], completedCategories: ['code', 'security'] as ('code' | 'security')[], reviewerSessions: [{ agentId: 'codex', sessionId: 'r1', category: 'code' as const }, { agentId: 'claude-code', sessionId: 'r2', category: 'security' as const }], evidenceRefs: ['sha256:' + 'd'.repeat(64)] };
it('aggregates full advisory-only review, while any blocking remark prevents approval', () => {
    const advisory = { id: 'r1', category: 'security' as const, severity: 'advisory' as const, message: 'Inspect egress policy', evidenceRefs: [], verificationStatus: 'inferred' as const };
    expect(aggregateReview({ ...base, remarks: [advisory] }).status).toBe('approved');
    expect(aggregateReview({ ...base, remarks: [{ ...advisory, severity: 'blocking' }] })).toMatchObject({ status: 'changes_requested', blockingCount: 1 });
});
it('never approves missing passes or a changed patch', () => {
    expect(aggregateReview({ ...base, completedCategories: ['code'] }).status).toBe('inconclusive');
    expect(aggregateReview({ ...base, snapshotValid: false }).status).toBe('inconclusive');
});
