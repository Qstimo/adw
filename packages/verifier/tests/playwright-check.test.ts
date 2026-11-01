import { afterEach, expect, it } from 'vitest';
import { rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runPlaywright } from '../src/checks/playwright.js';
import { webFixture, fakeBrowser, scenario, png } from './web-helpers.js';
let fixture: ReturnType<typeof webFixture>;
afterEach(() => fixture && rmSync(fixture.root, { recursive: true, force: true }));
function input() {
    return { baseUrl: 'http://127.0.0.1:5179', cwd: fixture.root, scenarios: [scenario], timeoutMs: 1000, blocking: true, failOnConsoleError: true };
}
it('imports synthetic protocol artifacts into CAS with explicit scenario-observation labels', async () => {
    fixture = webFixture();
    const run = await runPlaywright(fixture.context, input(), fakeBrowser());
    expect(run.result.exitCode).toBe(0);
    const manifest = JSON.parse(fixture.store.get(run.result.evidenceManifestRef!).toString());
    expect(manifest.proves).toBe('scenario_observation');
    expect(manifest.artifacts.map((artifact: any) => artifact.role)).toEqual(['screenshot', 'dom', 'console', 'network']);
    expect(fixture.store.get(manifest.artifacts[0].ref)).toEqual(png);
});
it('keeps failure video evidence and a failed exit separate from infrastructure notVerified', async () => {
    fixture = webFixture();
    const run = await runPlaywright(fixture.context, input(), fakeBrowser('failed'));
    expect(run.result.exitCode).toBe(1);
    expect(run.result.notVerified).toBe(false);
    const manifest = JSON.parse(fixture.store.get(run.result.evidenceManifestRef!).toString());
    expect(manifest.artifacts.some((artifact: any) => artifact.mediaType === 'video/webm')).toBe(true);
});
it.each(['missing', 'foreign', 'nonzero', 'no_media'] as const)('rejects an incomplete/untrusted worker result: %s', async (mode) => {
    fixture = webFixture();
    const worker = fakeBrowser('passed', report => {
        if (mode === 'missing')
            report.observations = [];
        if (mode === 'foreign')
            report.observations[0].title = 'foreign';
        if (mode === 'no_media')
            report.artifacts = [];
    });
    const run = await runPlaywright(fixture.context, input(), async (options) => {
        const result = await worker(options);
        return { ...result, code: mode === 'nonzero' ? 1 : result.code };
    });
    expect(run.result.notVerified).toBe(true);
    expect(run.result.exitCode).toBeNull();
});
it.each(['traversal', 'symlink', 'invalid_png'] as const)('refuses unsafe evidence: %s', async (mode) => {
    fixture = webFixture();
    const outside = join(fixture.root, 'outside');
    writeFileSync(outside, 'private fixture');
    const run = await runPlaywright(fixture.context, input(), fakeBrowser('passed', (report, root) => {
        if (mode === 'traversal')
            report.artifacts[0].path = '../outside';
        if (mode === 'symlink') {
            rmSync(join(root, '0.png'));
            symlinkSync(outside, join(root, '0.png'));
        }
        if (mode === 'invalid_png')
            writeFileSync(join(root, '0.png'), 'not a PNG');
    }));
    expect(run.result.notVerified).toBe(true);
    for (const ref of run.result.artifactRefs)
        expect(fixture.store.get(ref).toString()).not.toContain('private fixture');
});
it('never certifies an unavailable browser or a timed-out worker', async () => {
    fixture = webFixture();
    const timeout = await runPlaywright(fixture.context, input(), async () => ({ code: null, reason: 'timeout', stdout: '', stderr: '' }));
    expect(timeout.result.notVerified).toBe(true);
    expect(JSON.parse(fixture.store.get(timeout.result.artifactRefs[2]!).toString()).reason).toBe('timeout');
    const unavailable = await runPlaywright(fixture.context, input(), async (options) => {
        writeFileSync(join(options.outputDir, 'report.json'), JSON.stringify({ proves: 'scenario_observation', launchError: 'Chrome unavailable', observations: [{ title: scenario.title, status: 'not_verified' }], artifacts: [] }));
        return { code: 2, reason: '', stdout: '', stderr: '' };
    });
    expect(unavailable.result.notVerified).toBe(true);
});
