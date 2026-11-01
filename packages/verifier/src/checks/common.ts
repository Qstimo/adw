import { performance } from 'node:perf_hooks';
import { CheckResultSchema, type CheckResult } from '@adw/contracts';
import type { EvidenceStore } from '../evidence-store.js';
import type { TestObservation } from '../acceptance-link.js';
export interface EvidenceArtifact {
    ref: string;
    mediaType: string;
    role: string;
    scenario?: string;
}
export interface WebCheckContext {
    store: EvidenceStore;
    baseCommit: string;
    fingerprint: string;
    signal?: AbortSignal;
    fetch?: typeof fetch;
}
export interface WebCheckRun {
    result: CheckResult;
    observations: TestObservation[];
}
export function httpUrl(value: string): URL {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Only HTTP(S) URLs without embedded credentials are allowed');
    return url;
}
export function sameOrigin(base: string, path: string): URL {
    const origin = httpUrl(base), url = new URL(path, origin);
    if (url.origin !== origin.origin)
        throw new Error('Cross-origin scenario is not allowed');
    return httpUrl(url.href);
}
export function safeUrl(value: string): string {
    try {
        const url = httpUrl(value);
        url.search = '';
        url.hash = '';
        return url.href;
    }
    catch {
        return '[invalid URL]';
    }
}
export function redactor(headers: Record<string, string>): (value: string) => string {
    const secrets = Object.entries(headers).filter(([key]) => /authorization|cookie|api.?key|token/i.test(key)).flatMap(([, value]) => [value, value.replace(/^(Bearer|Basic)\s+/i, '')]).filter(value => value.length >= 4);
    return value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
}
export function finishWebCheck(context: WebCheckContext, input: {
    name: string;
    kind: NonNullable<CheckResult['kind']>;
    command: string;
    blocking: boolean;
    started: number;
    status: 'passed' | 'failed' | 'not_verified';
    observations: TestObservation[];
    reason?: string;
    stdout?: string;
    artifacts?: EvidenceArtifact[];
    coverage?: unknown;
}): WebCheckRun {
    const { store } = context, artifacts = input.artifacts ?? [], stdout = store.put(input.stdout ?? JSON.stringify(input.observations)), stderr = store.put(input.reason ?? '');
    const metadata = store.put(JSON.stringify({ kind: input.kind, reason: input.reason ?? '', status: input.status, proves: 'scenario_observation', baseCommit: context.baseCommit }));
    const manifest = store.put(JSON.stringify({ kind: input.kind, proves: 'scenario_observation', baseCommit: context.baseCommit, status: input.status, observations: input.observations, artifacts, coverage: input.coverage }));
    const result = CheckResultSchema.parse({ name: input.name, kind: input.kind, command: input.command, exitCode: input.status === 'not_verified' ? null : input.status === 'passed' ? 0 : 1, notVerified: input.status === 'not_verified', blocking: input.blocking, durationMs: performance.now() - input.started, environmentFingerprint: context.fingerprint, baseCommit: context.baseCommit, artifactRefs: [stdout, stderr, metadata, ...new Set([manifest, ...artifacts.map(artifact => artifact.ref)])], evidenceManifestRef: manifest, ...(input.coverage ? { coverage: JSON.stringify(input.coverage) } : {}) });
    return { result, observations: input.observations };
}
export function stopReason(signal: AbortSignal): string {
    const reason = signal.reason as {
        code?: string;
        name?: string;
    };
    const text = String(signal.reason);
    if (reason?.code === 'timeout' || reason?.name === 'TimeoutError' || /timeout|timed out/i.test(text))
        return 'timeout';
    if (reason?.code === 'budget' || text.includes('output_limit'))
        return 'output_limit';
    if (reason?.name === 'AbortError' || reason?.code === 'cancelled' || /cancel/i.test(text))
        return 'cancelled';
    return 'environment_unavailable';
}
