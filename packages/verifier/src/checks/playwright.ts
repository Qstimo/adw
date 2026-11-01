import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, lstatSync, fstatSync, openSync, readSync, closeSync, constants, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { BrowserScenario } from '@adw/contracts';
import { startProcess, type ProcessOutcome } from './process.js';
import { finishWebCheck, httpUrl, type WebCheckContext, type WebCheckRun, type EvidenceArtifact } from './common.js';
const require = createRequire(import.meta.url);
const ReportSchema = z.object({ proves: z.literal('scenario_observation'), launchError: z.string().optional(), runtime: z.object({ playwrightVersion: z.string().max(100), browserVersion: z.string().max(200).optional(), executablePath: z.string().max(4096).optional() }).strict().optional(), observations: z.array(z.object({ title: z.string(), status: z.enum(['passed', 'failed', 'not_verified']), reason: z.string().optional() }).strict()).max(100), artifacts: z.array(z.object({ path: z.string(), mediaType: z.enum(['image/png', 'video/webm', 'text/html', 'application/json']), role: z.enum(['screenshot', 'video', 'dom', 'console', 'network']), scenario: z.string() }).strict()).max(500) }).strict();
export interface BrowserWorkerInput {
    outputDir: string;
    baseUrl: string;
    scenarios: BrowserScenario[];
    timeoutMs: number;
    browserExecutable?: string;
    failOnConsoleError: boolean;
    signal?: AbortSignal;
    cwd: string;
}
export type BrowserWorker = (input: BrowserWorkerInput) => Promise<ProcessOutcome>;
export const defaultBrowserWorker: BrowserWorker = async (input) => startProcess({ cwd: input.cwd, binary: process.execPath, args: [fileURLToPath(new URL('./playwright-worker.mjs', import.meta.url))], timeoutMs: input.timeoutMs, signal: input.signal, maxBytes: 65536, stdin: JSON.stringify({ ...input, signal: undefined, cwd: undefined, modulePath: require.resolve('playwright-core') }) }).done;
function readArtifact(root: string, path: string, max: number): Buffer {
    if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part === '.' || !part))
        throw new Error('Unsafe artifact path');
    const file = realpathSync(join(root, path)), rel = relative(realpathSync(root), file);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
        throw new Error('Artifact outside evidence directory');
    if (lstatSync(join(root, path)).isSymbolicLink())
        throw new Error('Symlinked artifact');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > max)
            throw new Error('Artifact type/size limit');
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, null);
            if (!count)
                throw new Error('Incomplete artifact');
            offset += count;
        }
        const after = fstatSync(fd);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
            throw new Error('Artifact changed while importing');
        return bytes;
    }
    finally {
        closeSync(fd);
    }
}
export async function runPlaywright(context: WebCheckContext, input: Omit<BrowserWorkerInput, 'outputDir' | 'signal'> & {
    blocking: boolean;
}, worker: BrowserWorker = defaultBrowserWorker): Promise<WebCheckRun> {
    httpUrl(input.baseUrl);
    const started = performance.now(), root = mkdtempSync(join(tmpdir(), 'adw-browser-evidence-'));
    const artifacts: EvidenceArtifact[] = [];
    let runtimeFingerprint = context.fingerprint;
    let observations: WebCheckRun['observations'] = [], reason: string | undefined;
    try {
        const processResult = await worker({ ...input, outputDir: root, signal: context.signal });
        if (processResult.reason) {
            reason = processResult.reason;
            throw new Error(reason);
        }
        const report = ReportSchema.parse(JSON.parse(readArtifact(root, 'report.json', 1024 * 1024).toString('utf8')));
        const expected = new Set(input.scenarios.map(scenario => scenario.title));
        if (report.observations.length !== expected.size || new Set(report.observations.map(test => test.title)).size !== expected.size || report.observations.some(test => !expected.has(test.title)))
            throw new Error('Incomplete/foreign browser report');
        observations = report.observations;
        if (report.runtime) {
            artifacts.push({ ref: context.store.put(JSON.stringify(report.runtime)), mediaType: 'application/json', role: 'browser_environment' });
            runtimeFingerprint = createHash('sha256').update(context.fingerprint + '\0' + JSON.stringify(report.runtime)).digest('hex');
        }
        if (processResult.code !== 0 && observations.every(test => test.status === 'passed'))
            throw new Error('Nonzero browser worker exit');
        if (report.launchError) {
            reason = 'browser_unavailable';
            artifacts.push({ ref: context.store.put(report.launchError), mediaType: 'text/plain', role: 'browser_launch_error' });
        }
        let total = 0;
        for (const artifact of report.artifacts) {
            if (!expected.has(artifact.scenario))
                throw new Error('Foreign artifact scenario');
            const bytes = readArtifact(root, artifact.path, 16 * 1024 * 1024);
            total += bytes.length;
            if (total > 32 * 1024 * 1024)
                throw new Error('Artifact total size limit');
            if (artifact.mediaType === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
                throw new Error('Invalid PNG evidence');
            if (artifact.mediaType === 'video/webm' && !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
                throw new Error('Invalid WebM evidence');
            artifacts.push({ ref: context.store.put(bytes), mediaType: artifact.mediaType, role: artifact.role, scenario: artifact.scenario });
        }
        for (const test of observations) {
            if ((test.status === 'passed' || test.status === 'failed') && !['screenshot', 'dom', 'console', 'network'].every(role => artifacts.some(artifact => artifact.scenario === test.title && artifact.role === role)))
                throw new Error('Scenario lacks observation evidence');
            if (test.status === 'failed' && !artifacts.some(artifact => artifact.scenario === test.title && artifact.role === 'video'))
                throw new Error('Failed scenario lacks retained video');
        }
    }
    catch (error) {
        reason ??= context.signal?.aborted ? 'cancelled' : 'browser_protocol_error';
        observations = input.scenarios.map(scenario => ({ title: scenario.title, status: 'not_verified', reason }));
        artifacts.push({ ref: context.store.put(String(error)), mediaType: 'text/plain', role: 'browser_error' });
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
    const status = reason || observations.some(test => test.status === 'not_verified') ? 'not_verified' : observations.some(test => test.status === 'failed') ? 'failed' : 'passed';
    return finishWebCheck({ ...context, fingerprint: runtimeFingerprint }, { name: 'playwright_e2e', kind: 'playwright_e2e', command: 'Playwright Chromium browser scenarios', blocking: input.blocking, started, status, observations, artifacts, ...(reason ? { reason } : {}) });
}
