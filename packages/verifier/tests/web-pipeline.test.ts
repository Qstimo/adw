import { afterEach, expect, it } from 'vitest';
import { rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebVerificationSchema, type WebVerification } from '@adw/contracts';
import { VerifierRunner } from '../src/runner.js';
import { redactWebConfig } from '../src/web-pipeline.js';
import { webFixture, fakeBrowser, scenario, okFetch } from './web-helpers.js';
let fixture: ReturnType<typeof webFixture>;
afterEach(() => fixture && rmSync(fixture.root, { recursive: true, force: true }));
const config = () => WebVerificationSchema.parse({ enabled: true, baseUrl: 'http://127.0.0.1:5179', apiSmoke: { enabled: true, requests: [{ title: 'health', path: '/health', jsonShape: { ok: 'boolean' } }] }, playwright: { enabled: true, scenarios: [scenario] }, acceptance: [{ id: 'api', acceptanceIndex: 0, tests: ['health'] }, { id: 'ui', acceptanceIndex: 1, tests: [scenario.title] }] });
const acceptance = ['Health passes', 'UI becomes ready'];
it('runs commands, app health, API, browser and acceptance in order and stops the managed server', async () => {
    fixture = webFixture();
    let stopped = false, browsed = false;
    const marker = join(fixture.root, 'built'), script = join(fixture.root, 'build.cjs');
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`);
    const web = config();
    web.server = { command: 'fixture-server', timeoutMs: 1000 };
    delete web.baseUrl;
    const browser = fakeBrowser();
    const runner = new VerifierRunner(fixture.store, { fetch: okFetch, browserWorker: async (input) => {
            browsed = true;
            return browser(input);
        }, startServer: async () => {
            expect(existsSync(marker)).toBe(true);
            return { baseUrl: 'http://127.0.0.1:5179', stop: async () => {
                    stopped = true;
                }, failure: new Promise<never>(() => {
                }) };
        } });
    const run = await runner.run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [{ name: 'build', command: `"${process.execPath}" "${script}"`, blocking: true }], web, acceptance });
    expect(run.readyForReview).toBe(true);
    expect(run.results.map(check => check.name)).toEqual(['build', 'web_environment', 'api_smoke', 'playwright_e2e', 'web_acceptance']);
    expect(run.results.at(-1)?.acceptanceCoverage?.every(criterion => criterion.status === 'passed')).toBe(true);
    expect(browsed).toBe(true);
    expect(stopped).toBe(true);
});
it('blocks required failures but preserves optional failed observations as warnings', async () => {
    fixture = webFixture();
    const runner = new VerifierRunner(fixture.store, { fetch: okFetch, browserWorker: fakeBrowser('failed') });
    const web = config();
    const required = await runner.run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [], web, acceptance });
    expect(required.readyForReview).toBe(false);
    expect(required.results.at(-1)?.acceptanceCoverage?.[1]?.status).toBe('failed');
    web.playwright!.blocking = false;
    delete web.acceptance[1]!.acceptanceIndex;
    web.acceptance[1]!.required = false;
    const optional = await runner.run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [], web, acceptance });
    expect(optional.readyForReview).toBe(true);
    expect(optional.results.at(-1)?.acceptanceCoverage?.[1]?.notVerified).toBe(true);
    expect(optional.warnings.join(' ')).toContain('optional');
});
it('does not turn missing acceptance mapping into a clean result', async () => {
    fixture = webFixture();
    const web = config();
    web.acceptance = [];
    const visited: string[] = [];
    const transport = (async (input: unknown, options?: RequestInit) => {
        visited.push(new URL(String(input)).pathname);
        return okFetch(input as RequestInfo, options);
    }) as typeof fetch;
    const run = await new VerifierRunner(fixture.store, { fetch: transport, browserWorker: fakeBrowser() }).run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [], web, acceptance });
    expect(run.readyForReview).toBe(false);
    expect(run.warnings.join(' ')).toContain('Missing acceptance map');
    expect(visited).toEqual(['/', '/health']);
});
it('records unavailable server as notVerified and never starts API/browser scenarios', async () => {
    fixture = webFixture();
    const web = config();
    web.server = { command: 'unavailable', timeoutMs: 100 };
    let requests = 0, browsers = 0;
    const run = await new VerifierRunner(fixture.store, { fetch: (async () => {
            requests++;
            return new Response('{}');
        }) as typeof fetch, browserWorker: async () => {
            browsers++;
            throw new Error('must not run');
        }, startServer: async () => {
            throw new Error('listen EPERM');
        } }).run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [], web, acceptance });
    expect(run.readyForReview).toBe(false);
    expect(requests + browsers).toBe(0);
    expect(run.results.every(check => check.notVerified)).toBe(true);
    expect(fixture.store.get(run.results[0]!.artifactRefs[0]!).toString()).toContain('EPERM');
});
it('does not start an app after a required command fails', async () => {
    fixture = webFixture();
    const web = config();
    web.server = { command: 'must-not-start', timeoutMs: 100 };
    let started = false;
    const run = await new VerifierRunner(fixture.store, { startServer: async () => {
            started = true;
            throw new Error('must not run');
        } }).run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [{ name: 'unit', command: 'exit 1', blocking: true }], web, acceptance });
    expect(run.readyForReview).toBe(false);
    expect(started).toBe(false);
});
it('stops API on timeout and does not launch the browser afterward', async () => {
    fixture = webFixture();
    const web = config();
    web.apiSmoke!.timeoutMs = 20;
    let browsed = false;
    const transport = (async (_input: unknown, options?: RequestInit) => {
        if (new URL(String(_input)).pathname === '/')
            return new Response('{}');
        return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
        });
    }) as typeof fetch;
    const run = await new VerifierRunner(fixture.store, { fetch: transport, browserWorker: async () => {
            browsed = true;
            throw new Error('must not run');
        } }).run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [], web, acceptance });
    expect(run.readyForReview).toBe(false);
    expect(browsed).toBe(false);
    const api = run.results.find(check => check.kind === 'api_smoke')!;
    expect(JSON.parse(fixture.store.get(api.artifactRefs[2]!).toString()).reason).toBe('timeout');
});
it('redacts request headers and URL query parameters from audit-safe configuration', () => {
    const web = config();
    web.baseUrl = 'http://127.0.0.1?token=private';
    web.apiSmoke!.requests[0]!.headers.Authorization = 'Bearer private-secret';
    web.apiSmoke!.requests[0]!.path = '/health?key=private-secret';
    const redacted = JSON.stringify(redactWebConfig(web));
    expect(redacted).not.toContain('private-secret');
    expect(redacted).not.toContain('token=private');
    expect(redacted).toContain('[REDACTED]');
    expect(web.apiSmoke!.requests[0]!.headers.Authorization).toContain('private-secret');
});
it('does not use optional-only web observations to bypass the mandatory-check gate', async () => {
    fixture = webFixture();
    const web = config();
    web.apiSmoke!.blocking = false;
    web.playwright!.blocking = false;
    for (const criterion of web.acceptance) {
        delete criterion.acceptanceIndex;
        criterion.required = false;
    }
    await expect(new VerifierRunner(fixture.store, { fetch: okFetch, browserWorker: fakeBrowser() }).run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [], web, acceptance })).rejects.toThrow('required check');
});
it('validates bound criteria and reserved names before starting command processes', async () => {
    fixture = webFixture();
    const web = config();
    web.acceptance[0]!.acceptanceIndex = 99;
    let contacted = false;
    const runner = new VerifierRunner(fixture.store, { fetch: (async () => {
            contacted = true;
            return new Response('{}');
        }) as typeof fetch });
    await expect(runner.run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [], web, acceptance })).rejects.toThrow('locked spec');
    delete web.acceptance[0]!.acceptanceIndex;
    await expect(runner.run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [], web, acceptance })).rejects.toThrow('locked spec');
    web.acceptance[0]!.acceptanceIndex = 0;
    await expect(runner.run({ worktreePath: fixture.root, baseCommit: fixture.context.baseCommit, checks: [{ name: 'web_acceptance', command: 'must not execute', blocking: true }], web, acceptance })).rejects.toThrow('Reserved');
    expect(contacted).toBe(false);
});
