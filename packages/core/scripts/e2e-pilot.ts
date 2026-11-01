import { mkdtempSync, mkdirSync, cpSync, writeFileSync, symlinkSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitWorktreeManager } from '@adw/git';
import { EvidenceStore, VerifierRunner, type WebDependencies } from '@adw/verifier';
import { WebVerificationSchema } from '@adw/contracts';
import { confirmSpec, readSpec, specHash } from '@adw/supervisor';
import { openDb, migrate } from '../src/db/client.js';
import { createSupervisor } from '../src/services/supervisor-facade.js';
import { FakePilotAdapter, pilotGit } from './fake-pilot-adapter.js';
export async function runPilot(options: {
    outputDir?: string;
    forceRed?: boolean;
    web?: boolean;
    signal?: AbortSignal;
    forceWebRed?: boolean;
    webDependencies?: WebDependencies;
    browserExecutable?: string;
} = {}) {
    const workspace = fileURLToPath(new URL('../../../', import.meta.url));
    const root = options.outputDir ? resolve(options.outputDir) : mkdtempSync(join(tmpdir(), 'adw-e2e-pilot-'));
    // A caller-supplied directory must be empty/new: mkdir prevents overwriting a previous pilot.
    mkdirSync(root, { recursive: true });
    if (readdirSync(root).length)
        throw new Error('Pilot output directory must be empty');
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: false });
    cpSync(join(workspace, 'fixtures/demo-repo/src'), join(repo, 'src'), { recursive: true });
    cpSync(join(workspace, 'fixtures/demo-repo/package.json'), join(repo, 'package.json'));
    for (const entry of ['public', 'e2e', 'acceptanceMap.json'])
        cpSync(join(workspace, 'fixtures/demo-repo', entry), join(repo, entry), { recursive: true });
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({ extends: join(workspace, 'tsconfig.base.json'), compilerOptions: { jsx: 'react-jsx' }, include: ['src'] }));
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    await pilotGit(repo, 'init', '-b', 'main');
    await pilotGit(repo, 'config', 'user.name', 'ADW Pilot');
    await pilotGit(repo, 'config', 'user.email', 'adw-pilot@test');
    await pilotGit(repo, 'add', '.');
    await pilotGit(repo, 'commit', '-m', 'demo base');
    const baseCommit = await pilotGit(repo, 'rev-parse', 'HEAD');
    const databasePath = join(root, 'core.sqlite'), db = openDb(databasePath);
    migrate(db);
    try {
        const now = new Date().toISOString();
        db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_pilot', repo, 'main', now);
        db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_pilot', 'proj_pilot', 'Add an explanatory comment to src/add.ts without changing behavior', JSON.stringify(options.web ? ['Health endpoint responds correctly', 'Clicking Go changes status to ready', 'Typecheck and arithmetic tests pass', 'Only src/add.ts changes; main remains untouched'] : ['TypeScript typecheck passes', 'Existing arithmetic unit tests pass', 'Only src/add.ts changes; main checkout remains untouched']), JSON.stringify(['No behavior changes', 'No automatic acceptance or merge']), 'main', baseCommit, 'draft', now, now);
        // Fixture-only approval: a real application must present this exact hash/spec to the user.
        confirmSpec(db, { taskId: 'task_pilot', expectedSpecHash: specHash(readSpec(db, 'task_pilot')), approvedBy: 'pilot-fixture-user' });
        const dataDir = join(root, 'data'), manager = new GitWorktreeManager(repo, dataDir), verifier = new VerifierRunner(new EvidenceStore(join(root, 'evidence')), options.webDependencies);
        // Dependency links are fixture setup, not agent edits. No npm/network access is needed.
        const links = [['react', join(workspace, 'fixtures/demo-repo/node_modules/react')], ['react-dom', join(workspace, 'fixtures/demo-repo/node_modules/react-dom')], ['@types/react', join(workspace, 'fixtures/demo-repo/node_modules/@types/react')], ['@types/react-dom', join(workspace, 'fixtures/demo-repo/node_modules/@types/react-dom')], ['vitest', join(workspace, 'node_modules/vitest')], ['@types/node', join(workspace, 'node_modules/@types/node')]];
        // Setup is performed inside a deterministic fake executor wrapper, before any snapshot/checks.
        const adapter = new FakePilotAdapter(), start = adapter.startSession.bind(adapter);
        adapter.startSession = async function* (input) {
            if (input.role === 'reviewer') {
                yield* start(input);
                return;
            }
            mkdirSync(join(input.worktreePath, 'node_modules/@types'), { recursive: true });
            for (const [name, target] of links)
                symlinkSync(target!, join(input.worktreePath, 'node_modules', name!), 'dir');
            yield* start(input);
        };
        const wired = createSupervisor({ db, manager, verifier, dataDir, adapters: [adapter] });
        const tsc = join(workspace, 'node_modules/typescript/bin/tsc'), vitest = join(workspace, 'node_modules/vitest/vitest.mjs');
        const web = options.web ? WebVerificationSchema.parse({ enabled: true, server: { command: `\"${process.execPath}\" --experimental-strip-types src/server.ts`, timeoutMs: 10000 }, apiSmoke: { enabled: true, requests: [{ title: 'health returns ok', path: '/health', jsonShape: { ok: 'boolean' } }] }, playwright: { enabled: true, scenarios: [JSON.parse(readFileSync(join(repo, 'e2e/smoke.scenario.json'), 'utf8'))], timeoutMs: 30000, ...(options.browserExecutable ? { browserExecutable: options.browserExecutable } : {}) }, acceptance: JSON.parse(readFileSync(join(repo, 'acceptanceMap.json'), 'utf8')) }) : undefined;
        const result = await wired.run({ web, signal: options.signal, taskId: 'task_pilot', checks: [{ name: 'typecheck', command: `"${process.execPath}" "${tsc}" --noEmit`, blocking: true }, { name: 'unit', command: `"${process.execPath}" "${vitest}" run --maxWorkers=1 --minWorkers=1`, blocking: true }], limits: { wallTimeMs: 60000, sessionTimeoutMs: 10000, bundleTokens: 8000, maxFixCycles: 0 }, env: { FAIL_UNIT: options.forceRed ? '1' : '0', FAIL_WEB: options.forceWebRed ? '1' : '0' } });
        const journalPath = join(root, 'journal.jsonl');
        writeFileSync(journalPath, (db.prepare('SELECT * FROM audit_events ORDER BY rowid').all()).map(event => JSON.stringify(event)).join('\n') + '\n');
        return { ...result, ...(options.web ? { webChecks: (db.prepare('SELECT name,exit_code,not_verified,coverage,artifacts_json FROM check_results ORDER BY rowid').all() as {
                    name: string;
                    exit_code: number | null;
                    not_verified: number;
                    coverage: string | null;
                    artifacts_json: string;
                }[]).map(check => ({ ...check, ...(check.not_verified || check.exit_code !== 0 ? { diagnostic: verifier.evidenceStore.get((JSON.parse(check.artifacts_json) as string[])[check.name === 'web_environment' ? 0 : 1]!).toString().slice(0, 4096), diagnosticLimitChars: 4096 } : {}) })) } : {}), root, databasePath, journalPath, mainClean: (await pilotGit(repo, 'status', '--porcelain')) === '', mainBaseUnchanged: (await pilotGit(repo, 'rev-parse', 'main')) === baseCommit };
    }
    finally {
        db.close();
    }
}
