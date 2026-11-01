import { spawn, spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { CheckResultSchema, CommitSchema, type CheckResult, type WebVerificationInput, WebVerificationSchema } from '@adw/contracts';
import { EvidenceStore } from './evidence-store.js';
import { environmentFingerprint } from './fingerprint.js';
import { runWebPipeline, type WebDependencies } from './web-pipeline.js';
export interface CheckDefinition {
    name: string;
    command: string;
    blocking: boolean;
    timeoutMs?: number;
}
export interface VerificationRun {
    results: CheckResult[];
    readyForReview: boolean;
    warnings: string[];
}
export class VerifierRunner {
    constructor(readonly evidenceStore: EvidenceStore, private readonly webDependencies: WebDependencies = {}) {
    }
    async run(input: {
        worktreePath: string;
        baseCommit: string;
        checks: CheckDefinition[];
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
        maxOutputBytes?: number;
        signal?: AbortSignal;
        stopOnLimit?: boolean;
        web?: WebVerificationInput;
        acceptance?: readonly string[];
    }): Promise<VerificationRun> {
        input.signal?.throwIfAborted();
        const web = input.web ? WebVerificationSchema.parse(input.web) : undefined;
        if (web?.enabled) {
            for (const criterion of web.acceptance)
                if (input.acceptance&&criterion.required&&criterion.acceptanceIndex===undefined||criterion.acceptanceIndex !== undefined && (!input.acceptance || criterion.acceptanceIndex >= input.acceptance.length))
                    throw new Error('Web acceptance differs from locked spec');
            if (input.checks.some(check => ['web_environment', 'api_smoke', 'playwright_e2e', 'web_acceptance'].includes(check.name)))
                throw new Error('Reserved web check name');
        }
        CommitSchema.parse(input.baseCommit);
        const cwd = realpathSync(input.worktreePath);
        if (!statSync(cwd).isDirectory())
            throw new Error('Check cwd must be a directory');
        const env = { ...process.env, ...input.env };
        const timeoutMs = input.timeoutMs ?? 30000;
        const maxOutputBytes = input.maxOutputBytes ?? 8 * 1024 * 1024;
        if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
            throw new Error('Invalid output limit');
        const webRequired = web?.enabled && (web.apiSmoke?.enabled && web.apiSmoke.blocking || web.playwright?.enabled && web.playwright.blocking || web.acceptance.some(criterion => criterion.required) || !web.acceptance.length);
        if (!input.checks.some(check => check.blocking) && !webRequired)
            throw new Error('At least one required check is needed');
        for (const check of input.checks) {
            if (!check.name.trim() || !check.command.trim())
                throw new Error('Check name and command must be nonempty');
            const timeout = check.timeoutMs ?? timeoutMs;
            if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
                throw new Error('Invalid timeout');
        }
        const fingerprint = environmentFingerprint(cwd, env);
        const results: CheckResult[] = [];
        const warnings: string[] = [];
        let limitStopped = false;
        for (const check of input.checks) {
            input.signal?.throwIfAborted();
            const result = await this.runCheck(cwd, env, check, check.timeoutMs ?? timeoutMs, maxOutputBytes, fingerprint, input.baseCommit, input.signal);
            results.push(result);
            if (input.signal?.aborted)
                break;
            if (input.stopOnLimit && result.notVerified) {
                const metadata = JSON.parse(this.evidenceStore.get(result.artifactRefs[2]!).toString()) as {
                    reason?: string;
                };
                if (['timeout', 'output_limit'].includes(metadata.reason ?? '')) {
                    limitStopped = true;
                    break;
                }
            }
            if (result.notVerified)
                warnings.push(`${check.name}: check did not complete normally; see evidence`);
        }
        let webReady = true;
        if (web?.enabled && !input.signal?.aborted && !limitStopped) {
            const webRun = await runWebPipeline({ store: this.evidenceStore, baseCommit: input.baseCommit, fingerprint, signal: input.signal }, { config: web, cwd, env, acceptance: input.acceptance, precedingReady: results.every(result => !result.blocking || result.exitCode === 0 && !result.notVerified) }, this.webDependencies);
            results.push(...webRun.results);
            warnings.push(...webRun.warnings);
            webReady = webRun.readyForReview;
        }
        return { results, readyForReview: webReady && !limitStopped && !input.signal?.aborted && results.length >= input.checks.length && results.every(r => !r.blocking || (r.exitCode === 0 && !r.notVerified)), warnings };
    }
    private runCheck(cwd: string, env: NodeJS.ProcessEnv, check: CheckDefinition, timeoutMs: number, maxBytes: number, fingerprint: string, baseCommit: string, signal?: AbortSignal): Promise<CheckResult> {
        const start = performance.now();
        return new Promise((resolve, reject) => {
            const stdout: Buffer[] = [], stderr: Buffer[] = [];
            let captured = 0;
            let interrupted = false;
            let reason = '';
            const child = spawn(check.command, { cwd, env, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
            const killTree = () => {
                if (!child.pid)
                    return;
                try {
                    if (process.platform === 'win32')
                        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
                    else
                        process.kill(-child.pid, 'SIGKILL');
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                        reason += `; cleanup: ${String(error)}`;
                        interrupted = true;
                    }
                }
            };
            const abort = () => {
                interrupted = true;
                reason = 'cancelled';
                killTree();
            };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted)
                abort();
            const timer = setTimeout(() => {
                interrupted = true;
                reason = 'timeout';
                killTree();
            }, timeoutMs);
            const capture = (target: Buffer[], chunk: Buffer) => {
                const remaining = Math.max(0, maxBytes - captured);
                if (remaining)
                    target.push(chunk.subarray(0, remaining));
                captured += chunk.length;
                if (captured > maxBytes && !interrupted) {
                    interrupted = true;
                    reason = 'output_limit';
                    killTree();
                }
            };
            child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
            child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
            child.on('error', error => {
                interrupted = true;
                reason = error.message;
            });
            // exit can precede close when background descendants still hold stdout pipes.
            child.on('exit', () => {
                if (!interrupted)
                    killTree();
            });
            child.on('close', (code, exitSignal) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                killTree();
                try {
                    const artifactRefs = [this.evidenceStore.put(Buffer.concat(stdout)), this.evidenceStore.put(Buffer.concat(stderr)), this.evidenceStore.put(JSON.stringify({ name: check.name, command: check.command, code, signal: exitSignal, reason, timeoutMs, maxBytes }))];
                    resolve(CheckResultSchema.parse({ name: check.name, command: check.command, exitCode: code, durationMs: performance.now() - start, environmentFingerprint: fingerprint, artifactRefs, blocking: check.blocking, notVerified: interrupted || code === null || code === 127 || code === 126, baseCommit }));
                }
                catch (error) {
                    reject(error);
                }
            });
        });
    }
}
