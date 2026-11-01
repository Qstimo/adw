import { performance } from 'node:perf_hooks';
import { WebVerificationSchema, type WebVerificationInput, type CheckResult } from '@adw/contracts';
import { finishWebCheck, stopReason, httpUrl, safeUrl, type WebCheckContext } from './checks/common.js';
import { runApiSmoke } from './checks/api-smoke.js';
import { runPlaywright, type BrowserWorker } from './checks/playwright.js';
import { startWebServer, type WebServer } from './checks/server.js';
import { linkAcceptance, type TestObservation } from './acceptance-link.js';
export interface WebDependencies {
    fetch?: typeof fetch;
    browserWorker?: BrowserWorker;
    startServer?: typeof startWebServer;
}
export async function runWebPipeline(context: WebCheckContext, input: {
    config: WebVerificationInput;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    acceptance?: readonly string[];
    precedingReady: boolean;
}, dependencies: WebDependencies = {}): Promise<{
    results: CheckResult[];
    readyForReview: boolean;
    warnings: string[];
}> {
    const config = WebVerificationSchema.parse(input.config);
    if (!config.enabled)
        return { results: [], readyForReview: true, warnings: [] };
    for (const criterion of config.acceptance)
        if (input.acceptance && criterion.required && criterion.acceptanceIndex === undefined || criterion.acceptanceIndex !== undefined && (!input.acceptance || criterion.acceptanceIndex >= input.acceptance.length))
            throw new Error('Web acceptance map differs from locked task');
    const started = performance.now(), results: CheckResult[] = [], observations: TestObservation[] = [], warnings: string[] = [];
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new Error('timeout')), config.timeoutMs);
    const abort = () => controller.abort(context.signal?.reason ?? new Error('cancelled'));
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted)
        abort();
    const current = { ...context, fetch: dependencies.fetch ?? context.fetch, signal: controller.signal };
    let server: WebServer | undefined, baseUrl = config.baseUrl, unavailable: string | undefined;
    let environmentDescription: string | undefined, healthReason = 'environment_unavailable';
    try {
        if (!input.precedingReady)
            unavailable = 'Required command checks failed; web scenarios were not run';
        else {
            try {
                controller.signal.throwIfAborted();
                if (config.server) {
                    server = await (dependencies.startServer ?? startWebServer)(current, { ...config.server, cwd: input.cwd, env: input.env });
                    baseUrl = server.baseUrl;
                    void server.failure.catch(error => controller.abort(error));
                }
                if (!baseUrl)
                    throw new Error('No web base URL');
                const target = httpUrl(baseUrl);
                if (!config.server) {
                    const healthTimeout = AbortSignal.timeout(Math.min(5000, config.timeoutMs)), healthSignal = AbortSignal.any([controller.signal, healthTimeout]);
                    try {
                        const response = await (current.fetch ?? fetch)(target, { method: 'GET', redirect: 'error', signal: healthSignal });
                        environmentDescription = JSON.stringify({ proves: 'http_reachability', url: safeUrl(target.href), httpStatus: response.status });
                        await response.body?.cancel();
                    }
                    catch (error) {
                        if (healthSignal.aborted)
                            healthReason = stopReason(healthSignal);
                        throw error;
                    }
                }
            }
            catch (error) {
                unavailable = String(error);
                if (controller.signal.aborted)
                    healthReason = stopReason(controller.signal);
                else if (/timeout/i.test(unavailable))
                    healthReason = 'timeout';
                if (['timeout', 'output_limit'].includes(healthReason) && !controller.signal.aborted)
                    controller.abort(new Error(healthReason));
            }
        }
        const healthStatus = unavailable ? 'not_verified' : 'passed';
        results.push(finishWebCheck(current, { name: 'web_environment', kind: 'environment_health', command: config.server?.command ?? 'External HTTP reachability', blocking: !!config.apiSmoke?.blocking && !!config.apiSmoke.enabled || !!config.playwright?.blocking && !!config.playwright.enabled || config.acceptance.some(criterion => criterion.required) || !config.acceptance.length, started, status: healthStatus, observations: [], ...(unavailable ? { reason: healthReason, stdout: unavailable } : environmentDescription ? { stdout: environmentDescription } : {}) }).result);
        const skip = (name: 'api_smoke' | 'playwright_e2e', blocking: boolean, titles: string[]) => {
            const run = finishWebCheck(current, { name, kind: name, command: name === 'api_smoke' ? 'HTTP smoke/schema checks' : 'Playwright browser scenarios', blocking, started: performance.now(), status: 'not_verified', observations: titles.map(title => ({ title, status: 'not_verified', reason: unavailable ?? 'Web verification interrupted' })), reason: controller.signal.aborted ? stopReason(controller.signal) : 'environment_unavailable' });
            results.push(run.result);
            observations.push(...run.observations);
        };
        if (config.apiSmoke?.enabled) {
            if (unavailable || controller.signal.aborted)
                skip('api_smoke', config.apiSmoke.blocking, config.apiSmoke.requests.map(request => request.title));
            else {
                const run = await runApiSmoke(current, { ...config.apiSmoke, baseUrl: baseUrl! });
                results.push(run.result);
                observations.push(...run.observations);
                if (run.result.notVerified) {
                    const metadata = JSON.parse(context.store.get(run.result.artifactRefs[2]!).toString());
                    if (['timeout', 'output_limit'].includes(metadata.reason))
                        controller.abort(new Error(metadata.reason));
                }
            }
        }
        if (config.playwright?.enabled) {
            if (unavailable || controller.signal.aborted)
                skip('playwright_e2e', config.playwright.blocking, config.playwright.scenarios.map(scenario => scenario.title));
            else {
                const run = await runPlaywright(current, { ...config.playwright, baseUrl: baseUrl!, cwd: input.cwd }, dependencies.browserWorker);
                results.push(run.result);
                observations.push(...run.observations);
            }
        }
    }
    finally {
        try {
            await server?.stop();
        }
        finally {
            if (performance.now() - started >= config.timeoutMs && !controller.signal.aborted)
                controller.abort(new Error('timeout'));
            clearTimeout(timeout);
            context.signal?.removeEventListener('abort', abort);
        }
    }
    const acceptanceStarted = performance.now();
    const coverage = linkAcceptance(config.acceptance, observations, input.acceptance);
    warnings.push(...coverage.warnings);
    if (controller.signal.aborted) {
        coverage.ready = false;
        coverage.coverage = coverage.coverage.map(criterion => criterion.status === 'failed' ? criterion : { ...criterion, status: 'not_verified', notVerified: true, reason: 'Web run interrupted; runtime policy is not verified' });
    }
    if (controller.signal.aborted)
        warnings.push(`Web verification stopped: ${String(controller.signal.reason)}`);
    const linked = finishWebCheck(current, { name: 'web_acceptance', kind: 'acceptance', command: 'Map scenario observations to acceptance criteria', blocking: true, started: acceptanceStarted, status: coverage.ready && !controller.signal.aborted ? 'passed' : coverage.coverage.some(item => item.status === 'failed') ? 'failed' : 'not_verified', observations, coverage: coverage.coverage, ...(controller.signal.aborted ? { reason: stopReason(controller.signal) } : !coverage.ready ? { reason: 'acceptance_not_verified' } : {}) });
    linked.result.acceptanceCoverage = coverage.coverage;
    results.push(linked.result);
    for (const check of results)
        if (check.notVerified || check.exitCode !== 0)
            warnings.push(`${check.name}: ${check.notVerified ? 'notVerified' : 'failed'}`);
    return { results, readyForReview: !controller.signal.aborted && coverage.ready && results.every(check => !check.blocking || check.exitCode === 0 && !check.notVerified), warnings };
}
/** Audit-safe policy copy; request credentials are intentionally not persisted. */
export function redactWebConfig(config: WebVerificationInput | undefined): unknown {
    if (!config)
        return undefined;
    const copy = structuredClone(config);
    const url = (value: string) => {
        try {
            const parsed = new URL(value);
            parsed.username = '';
            parsed.password = '';
            parsed.search = '';
            parsed.hash = '';
            return parsed.href;
        }
        catch {
            return '[invalid URL]';
        }
    };
    if (copy.baseUrl)
        copy.baseUrl = url(copy.baseUrl);
    if (copy.server?.readyUrl)
        copy.server.readyUrl = url(copy.server.readyUrl);
    for (const request of copy.apiSmoke?.requests ?? []) {
        request.path = request.path.split('?')[0]!.split('#')[0]!;
        request.headers = Object.fromEntries(Object.keys(request.headers ?? {}).map(key => [key, '[REDACTED]']));
    }
    for (const scenario of copy.playwright?.scenarios ?? [])
        scenario.path = scenario.path.split('?')[0]!.split('#')[0]!;
    return copy;
}
