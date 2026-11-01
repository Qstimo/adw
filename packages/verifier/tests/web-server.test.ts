import { afterEach, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startWebServer } from '../src/checks/server.js';
import { webFixture, okFetch } from './web-helpers.js';
let fixture: ReturnType<typeof webFixture>;
afterEach(() => fixture && rmSync(fixture.root, { recursive: true, force: true }));
function program(code: string): string {
    const path = join(fixture.root, 'server.cjs');
    writeFileSync(path, code);
    return `"${process.execPath}" "${path}"`;
}
it('uses an owned child readiness marker with a synthetic HTTP health transport and cleans it up', async () => {
    fixture = webFixture();
    const command = program('require("node:fs").writeSync(1,"ADW_READY http://127.0.0.1:8765\\n");setInterval(()=>{},1000)');
    const server = await startWebServer({ ...fixture.context, fetch: okFetch }, { command, cwd: fixture.root, timeoutMs: 3000 });
    expect(server.baseUrl).toBe('http://127.0.0.1:8765');
    await server.stop();
});
it('does not accept a dead server process as a healthy environment', async () => {
    fixture = webFixture();
    const command = program('require("node:fs").writeSync(2,"fixture boot error");process.exit(3)');
    await expect(startWebServer({ ...fixture.context, fetch: okFetch }, { command, cwd: fixture.root, timeoutMs: 3000 })).rejects.toThrow('fixture boot error');
});
it('times out startup without a readiness marker and stops the child', async () => {
    fixture = webFixture();
    const command = program('setInterval(()=>{},1000)');
    await expect(startWebServer({ ...fixture.context, fetch: okFetch }, { command, cwd: fixture.root, timeoutMs: 50 })).rejects.toThrow('timeout');
});
it('refuses a non-loopback readiness announcement without contacting that address', async () => {
    fixture = webFixture();
    let contacted = false;
    const command = program('require("node:fs").writeSync(1,"ADW_READY http://outside.invalid:9999\\n");setInterval(()=>{},1000)');
    await expect(startWebServer({ ...fixture.context, fetch: (async () => {
            contacted = true;
            return new Response('{}');
        }) as typeof fetch }, { command, cwd: fixture.root, timeoutMs: 3000 })).rejects.toThrow('protocol_error');
    expect(contacted).toBe(false);
});
it('propagates cancellation after startup as a lost environment rather than a successful observation', async () => {
    fixture = webFixture();
    const controller = new AbortController(), command = program('require("node:fs").writeSync(1,"ADW_READY http://127.0.0.1:8765\\n");setInterval(()=>{},1000)');
    const server = await startWebServer({ ...fixture.context, fetch: okFetch, signal: controller.signal }, { command, cwd: fixture.root, timeoutMs: 3000 });
    controller.abort();
    await expect(server.failure).rejects.toThrow('cancelled');
    await server.stop();
});
