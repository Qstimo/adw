import { expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleDemoRequest } from './server.js';
function request(path: string, env: NodeJS.ProcessEnv = {}, method = 'GET') {
    let status = 0, body = '', headers: Record<string, string> = {};
    const response = { writeHead(code: number, value: Record<string, string> = {}) {
            status = code;
            headers = value;
        }, end(value = '') {
            body += value;
        } };
    handleDemoRequest({ url: path, method } as IncomingMessage, response as unknown as ServerResponse, env);
    return { status, body, headers };
}
it('provides a health response and static interactive page without requiring a listening socket in unit tests', () => {
    expect(request('/health')).toMatchObject({ status: 200, body: '{"ok":true}' });
    const page = request('/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="go"');
    expect(page.body).toContain('id="status"');
    expect(page.body).toContain('status.textContent = "ready"');
});
it('supports deterministic red fixture modes and rejects unknown paths/methods', () => {
    expect(request('/health', { FAIL_API: '1' }).status).toBe(500);
    expect(request('/', { FAIL_WEB: '1' }).body).toContain('status.textContent = "broken"');
    expect(request('/unknown').status).toBe(404);
    expect(request('/health', {}, 'POST').status).toBe(405);
});
