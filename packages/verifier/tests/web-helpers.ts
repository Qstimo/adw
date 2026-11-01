import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../src/evidence-store.js';
import type { BrowserWorker } from '../src/checks/playwright.js';
export function webFixture() {
    const root = mkdtempSync(join(tmpdir(), 'adw-web-unit-'));
    const store = new EvidenceStore(join(root, 'evidence'));
    return { root, store, context: { store, baseCommit: 'a'.repeat(40), fingerprint: 'fixture-environment' } };
}
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64');
/** Synthetic worker protocol fixture, never evidence of an actual browser run. */
export function fakeBrowser(status: 'passed' | 'failed' | 'not_verified' = 'passed', mutate?: (report: any, outputDir: string) => void): BrowserWorker {
    return async (input) => {
        const report = { proves: 'scenario_observation', observations: input.scenarios.map(scenario => ({ title: scenario.title, status })), artifacts: [] as {
                path: string;
                mediaType: string;
                role: string;
                scenario: string;
            }[] };
        for (const [index, scenario] of input.scenarios.entries())
            for (const [suffix, mediaType, role, bytes] of [['png', 'image/png', 'screenshot', png], ['html', 'text/html', 'dom', Buffer.from('<p>synthetic fixture</p>')], ['console.json', 'application/json', 'console', Buffer.from('[]')], ['network.json', 'application/json', 'network', Buffer.from('[]')], ...(status === 'failed' ? [['webm', 'video/webm', 'video', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0])]] : [])] as [
                string,
                string,
                string,
                Buffer
            ][]) {
                const path = `${index}.${suffix}`;
                writeFileSync(join(input.outputDir, path), bytes);
                report.artifacts.push({ path, mediaType, role, scenario: scenario.title });
            }
        mutate?.(report, input.outputDir);
        writeFileSync(join(input.outputDir, 'report.json'), JSON.stringify(report));
        return { code: status === 'passed' ? 0 : status === 'failed' ? 1 : 2, reason: '', stdout: 'synthetic worker', stderr: '' };
    };
}
export const scenario = { title: 'click becomes ready', path: '/', steps: [{ action: 'click' as const, selector: '#go' }, { action: 'text' as const, selector: '#status', expected: 'ready' }] };
export const okFetch = (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
