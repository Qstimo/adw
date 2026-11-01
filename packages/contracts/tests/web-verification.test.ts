import { expect, it } from 'vitest';
import { WebVerificationSchema, CheckResultSchema, AdwConfigSchema } from '../src/index.js';
const value = { enabled: true, baseUrl: 'http://127.0.0.1:5179', apiSmoke: { enabled: true, requests: [{ title: 'health', path: '/health', jsonShape: { ok: 'boolean' } }] }, acceptance: [{ id: 'health', acceptanceIndex: 0, tests: ['health'] }] };
it('adds typed optional web verification without changing legacy config defaults', () => {
    const config = AdwConfigSchema.parse({ dataDir: '.adw', agents: ['codex'], verifier: { commands: { unit: 'pnpm test' }, web: value }, privacyMode: 'local-only' });
    expect(config.verifier.web?.apiSmoke?.requests[0]?.expectedStatus).toBe(200);
    expect(config.verifier.web?.acceptance[0]?.required).toBe(true);
});
it('rejects empty enabled suites, duplicate test titles and downgrades of locked acceptance', () => {
    for (const invalid of [{ ...value, baseUrl: 'ftp://127.0.0.1' }, { ...value, baseUrl: 'http://user:password@127.0.0.1' }, { enabled: true, baseUrl: value.baseUrl }, { ...value, apiSmoke: { enabled: true, requests: [] } }, { ...value, apiSmoke: { enabled: true, requests: [value.apiSmoke.requests[0], value.apiSmoke.requests[0]] } }, { ...value, acceptance: [{ ...value.acceptance[0], required: false }] }])
        expect(WebVerificationSchema.safeParse(invalid).success).toBe(false);
});
it('accepts only supported browser steps and same-origin relative request paths', () => {
    expect(WebVerificationSchema.safeParse({ ...value, playwright: { enabled: true, scenarios: [{ title: 'ui', path: '/', steps: [{ action: 'evaluate', script: 'evil()' }] }] } }).success).toBe(false);
    for (const path of ['//foreign/', '/path\\foreign'])
        expect(WebVerificationSchema.safeParse({ ...value, apiSmoke: { enabled: true, requests: [{ ...value.apiSmoke.requests[0], path }] } }).success).toBe(false);
});
