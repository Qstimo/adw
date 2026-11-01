import { createHash } from 'node:crypto';
import type { CheckResult } from '@adw/contracts';
import { stableJson } from '@adw/context';
export function failureFingerprint(results: readonly CheckResult[]): string {
    // stdout/stderr hashes are stable diagnostics; metadata ref contains timing/signal details.
    const failures = results.filter(result => result.blocking && (result.exitCode !== 0 || result.notVerified)).map(result => ({ name: result.name, command: result.command, exitCode: result.exitCode, notVerified: result.notVerified, output: result.artifactRefs.slice(0, 2) })).sort((a, b) => a.name.localeCompare(b.name) || a.command.localeCompare(b.command));
    return createHash('sha256').update(stableJson(failures)).digest('hex');
}
export class RetryPolicy {
    private fingerprints = new Map<string, number>();
    private fixes = 0;
    constructor(readonly maxFixCycles = 3) { if (!Number.isInteger(maxFixCycles) || maxFixCycles < 0 || maxFixCycles > 3)
        throw new Error('Fix cycles must be 0..3'); }
    failure(fingerprint: string): {
        action: 'retry' | 'needs_human';
        reason: string;
        fixCycle: number;
    } {
        const count = (this.fingerprints.get(fingerprint) ?? 0) + 1;
        this.fingerprints.set(fingerprint, count);
        if (count >= 2)
            return { action: 'needs_human', reason: 'Identical verification failure repeated', fixCycle: this.fixes };
        if (this.fixes >= this.maxFixCycles)
            return { action: 'needs_human', reason: 'Fix cycle limit reached', fixCycle: this.fixes };
        this.fixes++;
        return { action: 'retry', reason: 'Independent verification failed', fixCycle: this.fixes };
    }
}
