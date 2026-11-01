export const states = ['draft', 'spec_pending_approval', 'spec_locked', 'planning', 'scheduled', 'running', 'verifying', 'reviewing', 'fix_needed', 'ready_for_human_review', 'needs_human', 'failed', 'cancelled', 'accepted', 'rejected'] as const;
export type SupervisorState = typeof states[number];
export type SupervisorEvent = {
    type: 'submit_spec' | 'confirm_spec' | 'plan' | 'schedule' | 'start' | 'agent_completed' | 'review_approved' | 'review_changes_requested' | 'retry' | 'accept' | 'reject';
} | {
    type: 'verification_passed';
    allNodesComplete: boolean;
} | {
    type: 'verification_failed';
} | {
    type: 'fail' | 'cancel' | 'escalate';
    reason: string;
};
export const taskStatus = (state: SupervisorState): string => ({ draft: 'draft', spec_pending_approval: 'draft', spec_locked: 'locked', planning: 'locked', scheduled: 'queued', running: 'running', verifying: 'verifying', reviewing: 'reviewing', fix_needed: 'running', ready_for_human_review: 'ready_for_review', needs_human: 'needs_human', failed: 'failed', cancelled: 'cancelled', accepted: 'accepted', rejected: 'rejected' })[state];
