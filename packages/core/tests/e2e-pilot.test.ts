import { afterEach, expect, it } from 'vitest';
import { rmSync, readFileSync } from 'node:fs';
import { runPilot } from '../scripts/e2e-pilot.js';
import { EvidenceStore } from '@adw/verifier';
import { join } from 'node:path';
import { openDb } from '../src/db/client.js';
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
it('executes the demo pilot through real Git, context, SQLite and independent typecheck/unit checks', async () => {
    const result = await runPilot();
    roots.push(result.root);
    expect(result.state).toBe('ready_for_human_review');
    expect(result.review?.status).toBe('approved');
    expect(result.review?.reviewerSessions).toHaveLength(2);
    expect(result.usageComplete).toEqual({ tokens: false, cost: false });
    expect(result.diffRef).toMatch(/^sha256:/);
    expect(result.mainClean).toBe(true);
    expect(result.mainBaseUnchanged).toBe(true);
    expect(result.verifiedSnapshot?.headCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(new EvidenceStore(join(result.root, 'evidence')).get(result.diffRef!).toString()).toContain('Headless ADW pilot');
    const journal = readFileSync(result.journalPath, 'utf8');
    for (const action of ['spec_locked', 'agent_routed', 'context_bundle_built', 'verification_finished', 'supervisor_finished'])
        expect(journal).toContain(action);
    const db = openDb(result.databasePath);
    try {
        expect(db.prepare('SELECT name,exit_code,not_verified FROM check_results ORDER BY rowid').all()).toEqual([{ name: 'typecheck', exit_code: 0, not_verified: 0 }, { name: 'unit', exit_code: 0, not_verified: 0 }]);
        expect(db.prepare('SELECT count(*) AS n FROM context_bundles').get()).toEqual({ n: 3 });
        expect(db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'ready_for_review' });
    }
    finally {
        db.close();
    }
}, 30000);
it('never declares the known-red demo ready even when the fake executor completes', async () => {
    const result = await runPilot({ forceRed: true });
    roots.push(result.root);
    expect(result.state).toBe('needs_human');
    expect(result.verifiedSnapshot).toBeUndefined();
    expect(result.mainClean).toBe(true);
    const db = openDb(result.databasePath);
    try {
        expect(db.prepare("SELECT exit_code FROM check_results WHERE name='unit'").get()).toEqual({ exit_code: 1 });
    }
    finally {
        db.close();
    }
}, 30000);
