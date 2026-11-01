import { performance } from 'node:perf_hooks';
import { ApiRequestSchema, type ApiRequest } from '@adw/contracts';
import { finishWebCheck, stopReason, sameOrigin, safeUrl, redactor, type WebCheckContext, type WebCheckRun, type EvidenceArtifact } from './common.js';
import type { TestObservation } from '../acceptance-link.js';
export async function runApiSmoke(context: WebCheckContext, input: {
    baseUrl: string;
    requests: ApiRequest[];
    timeoutMs: number;
    blocking: boolean;
}): Promise<WebCheckRun> {
    const started = performance.now(), observations: TestObservation[] = [], artifacts: EvidenceArtifact[] = [];
    let interrupted: string | undefined;
    const deadline = AbortSignal.timeout(input.timeoutMs), signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
    for (const raw of input.requests) {
        const request = ApiRequestSchema.parse(raw), url = sameOrigin(input.baseUrl, request.path), redact = redactor(request.headers);
        try {
            signal.throwIfAborted();
            if (performance.now() - started >= input.timeoutMs) {
                interrupted = 'timeout';
                throw new Error('timeout');
            }
            const response = await (context.fetch ?? fetch)(url, { method: 'GET', headers: request.headers, redirect: 'error', signal });
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            const reader = response.body?.getReader();
            if (reader)
                try {
                    while (true) {
                        const next = await reader.read();
                        if (next.done)
                            break;
                        bytes += next.value.length;
                        if (bytes > 64 * 1024) {
                            await reader.cancel();
                            throw new Error('response_limit');
                        }
                        chunks.push(next.value);
                    }
                }
                finally {
                    reader.releaseLock();
                }
            const body = Buffer.concat(chunks).toString('utf8'), safeBody = redact(body);
            const ref = context.store.put(JSON.stringify({ method: 'GET', url: safeUrl(url.href), status: response.status, contentType: response.headers.get('content-type'), body: safeBody, requestHeaders: '[OMITTED]', expectations: { status: request.expectedStatus, jsonShape: request.jsonShape }, proves: 'scenario_observation' }));
            artifacts.push({ ref, mediaType: 'application/json', role: 'api_response', scenario: request.title });
            let error = response.status !== request.expectedStatus ? `Expected HTTP ${request.expectedStatus}, got ${response.status}` : undefined;
            if (!error && request.jsonShape) {
                try {
                    const object = JSON.parse(body);
                    if (!object || typeof object !== 'object' || Array.isArray(object))
                        throw new Error('Expected JSON object');
                    for (const [key, type] of Object.entries(request.jsonShape)) {
                        const value = Object.hasOwn(object, key) ? object[key] : undefined;
                        const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
                        if (actual !== type||type==='number'&&!Number.isFinite(value))
                            throw new Error(`Schema mismatch at ${key}: expected ${type}`);
                    }
                }
                catch (errorValue) {
                    error = String(errorValue);
                }
            }
            if (performance.now() - started >= input.timeoutMs) {
                interrupted = 'timeout';
                throw new Error('timeout');
            }
            observations.push({ title: request.title, status: error ? 'failed' : 'passed', ...(error ? { reason: redact(error) } : {}) });
        }
        catch (error) {
            interrupted ??= signal.aborted ? (context.signal?.aborted ? stopReason(context.signal) : 'timeout') : String(error).includes('response_limit') ? 'output_limit' : undefined;
            observations.push({ title: request.title, status: 'not_verified', reason: interrupted ?? redact(String(error)) });
            if (interrupted)
                break;
        }
    }
    if (performance.now() - started >= input.timeoutMs)
        interrupted ??= 'timeout';
    if (signal.aborted)
        interrupted = context.signal?.aborted ? stopReason(context.signal) : 'timeout';
    const status = interrupted || observations.some(test => test.status === 'not_verified') ? 'not_verified' : observations.some(test => test.status === 'failed') ? 'failed' : 'passed';
    return finishWebCheck(context, { name: 'api_smoke', kind: 'api_smoke', command: 'HTTP GET smoke/schema checks', blocking: input.blocking, started, status, observations, artifacts, ...(interrupted ? { reason: interrupted } : {}) });
}
