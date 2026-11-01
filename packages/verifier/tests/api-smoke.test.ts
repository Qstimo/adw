import { afterEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { runApiSmoke } from '../src/checks/api-smoke.js';
import { webFixture, okFetch } from './web-helpers.js';
let fixture: ReturnType<typeof webFixture>;
afterEach(() => fixture && rmSync(fixture.root, { recursive: true, force: true }));
const request = { title: 'health', path: '/health', expectedStatus: 200, headers: {}, jsonShape: { ok: 'boolean' as const } };
it('checks actual HTTP response semantics using an injected transport and stores scoped evidence', async () => {
    fixture = webFixture();
    const run = await runApiSmoke({ ...fixture.context, fetch: okFetch }, { baseUrl: 'http://127.0.0.1:5179', requests: [request], blocking: true, timeoutMs: 1000 });
    expect(run.result.exitCode).toBe(0);
    expect(run.observations).toEqual([{ title: 'health', status: 'passed' }]);
    const manifest = JSON.parse(fixture.store.get(run.result.evidenceManifestRef!).toString());
    expect(manifest.proves).toBe('scenario_observation');
    expect(manifest.artifacts[0].role).toBe('api_response');
});
it.each([{ status: 500, body: '{"ok":true}' }, { status: 200, body: '{"ok":"wrong"}' }, { status: 200, body: 'not JSON' }])('fails a bad HTTP status or schema: %j', async (test) => {
    fixture = webFixture();
    const run = await runApiSmoke({ ...fixture.context, fetch: (async () => new Response(test.body, { status: test.status })) as typeof fetch }, { baseUrl: 'http://127.0.0.1', requests: [request], blocking: true, timeoutMs: 1000 });
    expect(run.result.exitCode).toBe(1);
    expect(run.result.notVerified).toBe(false);
});
it('redacts credential headers and values from stored response/errors and strips URL query metadata', async () => {
    fixture = webFixture();
    const token = 'super-secret-token';
    const run = await runApiSmoke({ ...fixture.context, fetch: (async () => new Response(JSON.stringify({ ok: true, echo: token }))) as typeof fetch }, { baseUrl: 'http://127.0.0.1', requests: [{ ...request, path: '/health?token=private', headers: { Authorization: 'Bearer ' + token } }], blocking: true, timeoutMs: 1000 });
    for (const ref of run.result.artifactRefs) {
        const content = fixture.store.get(ref).toString();
        expect(content).not.toContain(token);
        expect(content).not.toContain('token=private');
    }
    expect(run.result.exitCode).toBe(0);
});
it('treats transport failure and oversized responses as notVerified', async () => {
    fixture = webFixture();
    for (const transport of [(async () => {
            throw new Error('connection unavailable');
        }) as typeof fetch, (async () => new Response('x'.repeat(65537))) as typeof fetch]) {
        const run = await runApiSmoke({ ...fixture.context, fetch: transport }, { baseUrl: 'http://127.0.0.1', requests: [request], blocking: true, timeoutMs: 1000 });
        expect(run.result.notVerified).toBe(true);
        expect(run.result.exitCode).toBeNull();
    }
});
it('does not contact the endpoint after cancellation and rejects cross-origin/credential URLs', async () => {
    fixture = webFixture();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const run = await runApiSmoke({ ...fixture.context, signal: controller.signal, fetch: (async () => {
            calls++;
            return new Response('{}');
        }) as typeof fetch }, { baseUrl: 'http://127.0.0.1', requests: [request], blocking: true, timeoutMs: 1000 });
    expect(calls).toBe(0);
    expect(run.result.notVerified).toBe(true);
    await expect(runApiSmoke(fixture.context, { baseUrl: 'http://user:pass@127.0.0.1', requests: [request], blocking: true, timeoutMs: 1000 })).rejects.toThrow('credentials');
    await expect(runApiSmoke(fixture.context, { baseUrl: 'http://127.0.0.1', requests: [{ ...request, path: '//other-host/' }], blocking: true, timeoutMs: 1000 })).rejects.toThrow();
});
it('enforces elapsed timeout even when a transport blocks the event loop before resolving', async () => {
    fixture = webFixture();
    const transport = (async () => {
        const until = performance.now() + 10;
        while (performance.now() < until) {
        }
        return new Response('{"ok":true}');
    }) as typeof fetch;
    const run = await runApiSmoke({ ...fixture.context, fetch: transport }, { baseUrl: 'http://127.0.0.1', requests: [request], blocking: true, timeoutMs: 5 });
    expect(run.result.notVerified).toBe(true);
    expect(JSON.parse(fixture.store.get(run.result.artifactRefs[2]!).toString()).reason).toBe('timeout');
});
it('validates own JSON schema keys including __proto__ and rejects non-finite numeric values',async()=>{
 fixture=webFixture();const schema=Object.fromEntries([['__proto__','boolean' as const],['amount','number' as const]]);
 for(const [body,expectedCode] of [['{"amount":1}',1],['{"__proto__":true,"amount":1}',0],['{"__proto__":true,"amount":1e999}',1]] as const){const run=await runApiSmoke({...fixture.context,fetch:(async()=>new Response(body)) as typeof fetch},{baseUrl:'http://127.0.0.1',requests:[{...request,jsonShape:schema}],blocking:true,timeoutMs:1000});expect(run.result.exitCode).toBe(expectedCode);}
});
