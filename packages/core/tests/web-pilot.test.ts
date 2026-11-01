import { afterEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { runPilot } from '../scripts/e2e-pilot.js';
import { openDb } from '../src/db/client.js';
import { fakeBrowser, okFetch } from '../../verifier/tests/web-helpers.js';
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
const server = async () => ({ baseUrl: 'http://127.0.0.1:5179', stop: async () => {
    }, failure: new Promise<never>(() => {
    }) });
it('passes browser/API protocol observations through real Git, checks, coverage, persistence and independent review using synthetic transports', async () => {
    const result = await runPilot({ web: true, webDependencies: { fetch: okFetch, browserWorker: fakeBrowser(), startServer: server } });
    roots.push(result.root);
    expect(result.state).toBe('ready_for_human_review');
    expect(result.review?.status).toBe('approved');
    expect(result.mainClean).toBe(true);
    const db = openDb(result.databasePath);
    try {
        const rows = db.prepare('SELECT name,exit_code,coverage FROM check_results ORDER BY rowid').all() as {
            name: string;
            exit_code: number;
            coverage: string | null;
        }[];
        expect(rows.map(row => row.name)).toEqual(['typecheck', 'unit', 'web_environment', 'api_smoke', 'playwright_e2e', 'web_acceptance']);
        expect(rows.every(row => row.exit_code === 0)).toBe(true);
        expect(JSON.parse(rows.at(-1)!.coverage!)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'api.health', status: 'passed' }), expect.objectContaining({ id: 'web.button', status: 'passed' })]));
    }
    finally {
        db.close();
    }
}, 30000);
it('blocks independent review and acceptance for a required failed browser scenario despite a completed executor', async () => {
    const result = await runPilot({ web: true, webDependencies: { fetch: okFetch, browserWorker: fakeBrowser('failed'), startServer: server } });
    roots.push(result.root);
    expect(result.state).toBe('needs_human');
    expect(result.review).toBeUndefined();
    expect(result.verifiedSnapshot).toBeUndefined();
    const db = openDb(result.databasePath);
    try {
        expect(db.prepare("SELECT exit_code FROM check_results WHERE name='playwright_e2e'").get()).toEqual({ exit_code: 1 });
        expect(db.prepare('SELECT count(*) AS n FROM review_runs').get()).toEqual({ n: 0 });
    }
    finally {
        db.close();
    }
}, 30000);
