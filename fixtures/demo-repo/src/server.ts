import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function handleDemoRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv = process.env): void {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'GET') {
        response.writeHead(405, { 'content-type': 'text/plain' });
        response.end('Method not allowed');
        return;
    }
    if (path === '/health') {
        response.writeHead(env.FAIL_API === '1' ? 500 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: env.FAIL_API !== '1' }));
        return;
    }
    if (path === '/' || path === '/index.html') {
        let html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
        if (env.FAIL_WEB === '1')
            html = html.replace('status.textContent = "ready"', 'status.textContent = "broken"');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
        return;
    }
    if (path === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
}
export const createDemoServer = (env: NodeJS.ProcessEnv = process.env) => createServer((request, response) => handleDemoRequest(request, response, env));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT ?? 5179);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Invalid PORT');
    const server = createDemoServer();
    server.on('error', error => {
        writeSync(2, String(error) + '\n');
        process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address !== 'string')
            writeSync(1, `ADW_READY http://127.0.0.1:${address.port}\n`);
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => server.close());
}
