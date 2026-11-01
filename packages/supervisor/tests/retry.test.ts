import { expect, it } from 'vitest';
import { RetryPolicy, failureFingerprint } from '../src/retry.js';
import type { CheckResult } from '@adw/contracts';
const result: CheckResult = { name: 'unit', command: 'test', exitCode: 1, durationMs: 1, environmentFingerprint: 'env', artifactRefs: ['stdout', 'stderr', 'metadata'], notVerified: false, blocking: true };
it('allows at most three fixes after the initial attempt', () => {
    const policy = new RetryPolicy();
    expect([1, 2, 3, 4].map(n => policy.failure(String(n)).action)).toEqual(['retry', 'retry', 'retry', 'needs_human']);
    expect(() => new RetryPolicy(4)).toThrow();
    expect(new RetryPolicy(0).failure('a').action).toBe('needs_human');
});
it('escalates identical failures twice despite changed duration and metadata', () => {
    const a = failureFingerprint([result]), b = failureFingerprint([{ ...result, durationMs: 900, artifactRefs: ['stdout', 'stderr', 'different metadata'] }]);
    expect(a).toBe(b);
    const policy = new RetryPolicy();
    expect(policy.failure(a).action).toBe('retry');
    expect(policy.failure(b)).toMatchObject({ action: 'needs_human', reason: 'Identical verification failure repeated' });
    expect(failureFingerprint([{ ...result, artifactRefs: ['different output', 'stderr'] }])).not.toBe(a);
});
