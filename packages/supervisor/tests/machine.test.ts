import { expect, it } from 'vitest';
import { transition } from '../src/machine.js';
import type { SupervisorEvent, SupervisorState } from '../src/states.js';
it('permits only deterministic ordered gates; executor completed only enters verification', () => {
    let state: SupervisorState = 'draft';
    for (const type of ['submit_spec', 'confirm_spec', 'plan', 'schedule', 'start', 'agent_completed'] as const)
        state = transition(state, { type });
    expect(state).toBe('verifying');
    expect(() => transition('running', { type: 'verification_passed', allNodesComplete: true })).toThrow('Illegal');
    expect(transition(state, { type: 'verification_passed', allNodesComplete: true })).toBe('reviewing');
    expect(transition('reviewing',{type:'review_approved'})).toBe('ready_for_human_review');
    expect(()=>transition('reviewing',{type:'accept'})).toThrow();
    expect(transition(state, { type: 'verification_passed', allNodesComplete: false })).toBe('scheduled');
    expect(transition('ready_for_human_review', { type: 'accept' })).toBe('accepted');
});
it('rejects fabricated agent success and terminal-state resurrection', () => {
    expect(() => transition('running', { type: 'mark_tests_passed' } as unknown as SupervisorEvent)).toThrow();
    for (const state of ['failed', 'cancelled', 'accepted', 'rejected', 'needs_human'] as const)
        expect(() => transition(state, { type: 'start' })).toThrow();
    expect(transition('verifying', { type: 'cancel', reason: 'user' })).toBe('cancelled');
});
it('retries only after independent failure and escalates deterministically', () => {
    expect(transition('verifying', { type: 'verification_failed' })).toBe('fix_needed');
    expect(transition('fix_needed', { type: 'retry' })).toBe('running');
    expect(transition('fix_needed', { type: 'escalate', reason: 'repeat' })).toBe('needs_human');
});
