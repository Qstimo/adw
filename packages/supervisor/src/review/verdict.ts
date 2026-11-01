import { ReviewVerdictSchema, type ReviewRemark, type ReviewVerdict, type ReviewerSession, type PatchSnapshot } from '@adw/contracts';
export function aggregateReview(input: {
    id: string;
    taskId: string;
    snapshot: PatchSnapshot;
    snapshotValid: boolean;
    remarks: ReviewRemark[];
    completedCategories: ('code' | 'security')[];
    reviewerSessions: ReviewerSession[];
    evidenceRefs: string[];
    reason?: string;
}): ReviewVerdict {
    const blockingCount = input.remarks.filter(remark => remark.severity === 'blocking').length;
    const complete = input.snapshotValid && input.completedCategories.includes('code') && input.completedCategories.includes('security');
    return ReviewVerdictSchema.parse({ ...input, evidenceRefs: [...new Set(input.evidenceRefs)], blockingCount, status: blockingCount ? 'changes_requested' : complete ? 'approved' : 'inconclusive' });
}
