import { setTimeout as delay } from 'node:timers/promises';
import { startProcess, type ManagedProcess } from './process.js';
import { httpUrl, type WebCheckContext } from './common.js';
export interface WebServer {
    baseUrl: string;
    stop(): Promise<void>;
    failure: Promise<never>;
}
export async function startWebServer(context: WebCheckContext, input: {
    command: string;
    readyUrl?: string;
    timeoutMs: number;
    cwd: string;
    env?: NodeJS.ProcessEnv;
}): Promise<WebServer> {
    context.signal?.throwIfAborted();
    let marker: string | undefined, buffer = '', stopping = false;
    const child = startProcess({ cwd: input.cwd, command: input.command, env: { ...process.env, ...input.env, PORT: input.env?.PORT ?? '0' }, timeoutMs: 2147483647, signal: context.signal, onStdout: text => {
            buffer += text;
            let end;
            while ((end = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                if (line.startsWith('ADW_READY ')) {
                    const url = httpUrl(line.slice(10).trim());
                    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
                        throw new Error('Managed server announced a non-loopback URL');
                    marker = url.origin;
                }
            }
        } });
    const failure = child.done.then(result => {
        if (!stopping)
            throw new Error(`Managed web server exited: ${result.reason || result.code}; ${result.stderr}`);
        return new Promise<never>(() => {
        });
    });
    void failure.catch(() => {
    });
    const deadline = Date.now() + input.timeoutMs;
    const stop = async () => {
        stopping = true;
        await child.stop();
    };
    try {
        while (Date.now() < deadline) {
            context.signal?.throwIfAborted();
            if (!child.alive())
                await failure;
            const ready = input.readyUrl ?? (marker ? marker + '/health' : undefined);
            if (ready) {
                const url = httpUrl(ready);
                try {
                    const timeout = AbortSignal.timeout(Math.min(500, Math.max(1, deadline - Date.now()))), signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
                    const response = await (context.fetch ?? fetch)(url, { signal, redirect: 'error' });
                    const ok = response.ok;
                    await response.body?.cancel();
                    if (ok && child.alive())
                        return { baseUrl: marker ?? url.origin, stop, failure };
                }
                catch {
                    context.signal?.throwIfAborted();
                }
            }
            await delay(25, undefined, context.signal ? { signal: context.signal } : {});
        }
        throw new Error('timeout');
    }
    catch (error) {
        await stop();
        throw error;
    }
}
