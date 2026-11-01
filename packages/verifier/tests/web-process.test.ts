import { afterEach, expect, it } from 'vitest';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startProcess } from '../src/checks/process.js';
import { webFixture } from './web-helpers.js';
let fixture: ReturnType<typeof webFixture>;
afterEach(() => fixture && rmSync(fixture.root, { recursive: true, force: true }));
it('does not spawn a pre-cancelled process', async () => {
    fixture = webFixture();
    const controller = new AbortController();
    controller.abort();
    const process = startProcess({ cwd: fixture.root, command: 'must_not_start', signal: controller.signal, timeoutMs: 100 });
    expect((await process.done).reason).toBe('cancelled');
});
it.skipIf(process.platform !== 'linux')('kills descendants that start their own process group on cancellation', async () => {
    fixture = webFixture();
    const pidFile = join(fixture.root, 'detached.pid'), parent = join(fixture.root, 'parent.cjs');
    writeFileSync(parent, `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
    const child = startProcess({ cwd: fixture.root, binary: process.execPath, args: [parent], timeoutMs: 5000 });
    const deadline = Date.now() + 3000;
    while (!existsSync(pidFile) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 5));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await child.stop('cancelled');
    try {
        expect(readFileSync(`/proc/${pid}/status`, 'utf8')).toMatch(/State:\s+Z/);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }
});
