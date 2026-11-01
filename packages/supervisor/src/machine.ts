import type { SupervisorEvent, SupervisorState } from './states.js';
export function transition(state: SupervisorState, event: SupervisorEvent): SupervisorState {
    const closed = ['accepted', 'rejected', 'failed', 'cancelled', 'needs_human'];
    if (!closed.includes(state) && state !== 'ready_for_human_review') {
        if (event.type === 'fail')
            return 'failed';
        if (event.type === 'cancel')
            return 'cancelled';
        if (event.type === 'escalate')
            return 'needs_human';
    }
    const edges: Partial<Record<SupervisorState, Partial<Record<SupervisorEvent['type'], SupervisorState>>>> = {
        draft: { submit_spec: 'spec_pending_approval' }, spec_pending_approval: { confirm_spec: 'spec_locked' },
        spec_locked: { plan: 'planning' }, planning: { schedule: 'scheduled' }, scheduled: { start: 'running' },
        running: { agent_completed: 'verifying' }, verifying: { verification_failed: 'fix_needed' }, fix_needed: { retry: 'running' },
        reviewing: { review_approved: 'ready_for_human_review', review_changes_requested: 'fix_needed' },
        ready_for_human_review: { accept: 'accepted', reject: 'rejected' },
    };
    if (state === 'verifying' && event.type === 'verification_passed')
        return event.allNodesComplete ? 'reviewing' : 'scheduled';
    const next = edges[state]?.[event.type];
    if (!next)
        throw new Error(`Illegal supervisor transition: ${state} + ${event.type}`);
    return next;
}
