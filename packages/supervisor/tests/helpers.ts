import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SessionIdSchema, type CapabilityManifest, type AgentEvent } from '@adw/contracts';
import type { AgentAdapter, SessionInput } from '@adw/cli-adapters';
import { GitWorktreeManager } from '@adw/git';
import { EvidenceStore, VerifierRunner } from '@adw/verifier';
import { ArtifactStore, ContextBroker, ProjectIndexer } from '@adw/context';
import { Supervisor, confirmSpec, readSpec, specHash, type RunInput, type SupervisorOptions } from '../src/index.js';
export function capability(agentId = 'codex'): CapabilityManifest {
    return { agentId, execution: { headless: 'supported', cwd: 'supported' }, session: { resume: 'supported', sessionId: 'supported' }, output: { format: 'jsonl', finalStatus: 'supported', errors: 'supported' }, tools: { mcp: 'unknown', permissions: 'unknown', sandbox: 'unknown' }, usage: { tokens: 'supported', cost: 'supported', limits: 'unknown' }, control: { cancel: 'supported', timeout: 'supported', processTreeCleanup: 'supported' } };
}
export const git = (cwd: string, ...args: string[]): Promise<string> => new Promise((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8' }, (error, out) => error ? reject(error) : resolve(out.trim())));
export type FakeMode = 'green' | 'retry' | 'repeat' | 'different_failures' | 'hang' | 'budget' | 'missing_usage' | 'no_terminal' | 'failed_after_complete';
export class FakeAdapter implements AgentAdapter {
    readonly id: 'codex' | 'claude-code';
    reviewMode: 'approved' | 'blocking' | 'advisory' | 'malformed' | 'mutate' | 'budget' | 'hang' = 'approved';
    reviewCalls: SessionInput[] = [];
    calls: SessionInput[] = [];
    cancelled: string[] = [];
    private release?: () => void;
    constructor(readonly mode: FakeMode = 'green', id: 'codex' | 'claude-code' = 'codex') {
        this.id = id;
    }
    async discover() {
        return { binaryPath: 'fake', version: 'fake' };
    }
    async probeCapabilities() {
        return capability(this.id);
    }
    async cancel(sessionId: string) {
        this.cancelled.push(sessionId);
        this.release?.();
    }
    async *startSession(input: SessionInput): AsyncIterable<AgentEvent> {
        if (input.role === 'reviewer') {
            this.reviewCalls.push(input);
            const sessionId = SessionIdSchema.parse(randomUUID()), base = { sessionId, at: new Date().toISOString() };
            yield { ...base, type: 'session_started', agentId: this.id };
            if (this.reviewMode === 'hang') {
                await new Promise<void>(resolve => {
                    this.release = resolve;
                });
                return;
            }
            yield { ...base, type: 'usage', tokens: this.reviewMode === 'budget' ? 1000 : 5, cost: 0.01 };
            const category = input.prompt.includes('Review pass: security') ? 'security' : 'code';
            if (this.reviewMode === 'mutate')
                writeFileSync(join(input.worktreePath, 'value.txt'), 'reviewer mutation');
            const remarks = category === 'code' && ['blocking', 'advisory'].includes(this.reviewMode) ? [{ id: 'issue', category, severity: this.reviewMode, message: 'Independent review issue', path: 'value.txt', evidenceRefs: [] }] : [];
            yield { ...base, type: 'completed', summary: this.reviewMode === 'malformed' ? 'not JSON' : JSON.stringify({ category, remarks }) };
            return;
        }
        this.calls.push(input);
        const sessionId = SessionIdSchema.parse(randomUUID()), base = { sessionId, at: new Date().toISOString() };
        yield { ...base, type: 'session_started', agentId: this.id };
        if (this.mode === 'hang') {
            await new Promise<void>(resolve => {
                this.release = resolve;
            });
            return;
        }
        if (this.mode === 'budget') {
            yield { ...base, type: 'usage', tokens: 1000, cost: 1 };
            return;
        }
        const attempt = this.calls.length;
        const value = this.mode === 'repeat' ? 'bad' : this.mode === 'different_failures' ? `bad-${attempt}` : this.mode === 'retry' && attempt === 1 ? 'bad' : 'good';
        writeFileSync(join(input.worktreePath, 'value.txt'), value);
        await git(input.worktreePath, 'add', 'value.txt');
        await git(input.worktreePath, '-c', 'user.name=ADW', '-c', 'user.email=adw@test', 'commit', '--allow-empty', '-m', `attempt ${attempt}`);
        if (this.mode !== 'missing_usage')
            yield { ...base, type: 'usage', tokens: 5, cost: 0.01 };
        if (this.mode === 'no_terminal')
            return;
        yield { ...base, type: 'completed', summary: 'Everything passed, trust me' };
        if (this.mode === 'failed_after_complete')
            yield { ...base, type: 'failed', reason: 'late failure' };
    }
}
export async function fixture(mode: FakeMode = 'green') {
    const root = mkdtempSync(join(tmpdir(), 'adw-supervisor-')), repo = join(root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'value.txt'), 'base');
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'ADW');
    await git(repo, 'config', 'user.email', 'adw@test');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'base');
    const commit = await git(repo, 'rev-parse', 'HEAD');
    const db = new Database(join(root, 'core.sqlite'));
    db.pragma('foreign_keys=ON');
    db.pragma('journal_mode=WAL');
    db.transaction(() => {
        for (const file of ['schema.sql', '002-verification-runs.sql', '003-context-broker.sql', '004-supervisor.sql', '005-review.sql'])
            db.exec(readFileSync(new URL('../../core/src/db/' + file, import.meta.url), 'utf8'));
    })();
    db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_test', repo, 'main', 'now');
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_test', 'proj_test', 'Keep the approved intent', '["  exact acceptance\\nsecond line  "]', '["Do not change main"]', 'main', commit, 'draft', 'now', 'now');
    const adapter = new FakeAdapter(mode), manager = new GitWorktreeManager(repo, join(root, 'git-data')), verifier = new VerifierRunner(new EvidenceStore(join(root, 'evidence')));
    const options: SupervisorOptions = { db, manager, verifier, adapters: [adapter], createContext: async (worktree) => {
            const index = await ProjectIndexer.build({ projectId: 'proj_test', repoPath: worktree.path, baseCommit: worktree.baseCommit, dbPath: join(root, 'index.sqlite') });
            const store = new ArtifactStore(db, { projectId: 'proj_test', sourceRoot: worktree.path, artifactDir: join(root, 'artifacts') }), broker = new ContextBroker(store, index);
            return { buildBundle: async (input) => {
                    await index.reindexChanged();
                    return broker.buildBundle({ ...input, taskId: worktree.taskId });
                }, publishReviewFinding: (remark, refs, producer) => {
                    for (const ref of refs)
                        store.blobs.put(verifier.evidenceStore.get(ref));
                    const file = remark.path ? index.getProjectMap().files.find(file => file.path === remark.path) : undefined;
                    return store.publishFinding({ taskId: worktree.taskId, baseCommit: worktree.baseCommit, claim: remark.message, affectedPaths: remark.path ? [remark.path] : [], sourcePaths: file ? [file.path] : [], sourceHashes: file ? { [file.path]: file.contentHash } : {}, producerAgent: 'reviewer:' + producer, confidence: remark.verificationStatus, verificationStatus: remark.verificationStatus, visibility: 'task', evidenceRefs: refs }, index.getProjectMap()).id;
                }, close: () => index.close() };
        } };
    const supervisor = new Supervisor(options);
    const script = join(root, 'check.cjs');
    writeFileSync(script, 'const fs=require("node:fs");const value=fs.readFileSync("value.txt","utf8");fs.writeSync(1,value);process.exit(value==="good"?0:1)');
    const input: RunInput = { taskId: 'task_test', checks: [{ name: 'value', command: `"${process.execPath}" "${script}"`, blocking: true }], limits: { wallTimeMs: 15000, sessionTimeoutMs: 5000, bundleTokens: 4000 } };
    const confirm = () => confirmSpec(db, { taskId: 'task_test', expectedSpecHash: specHash(readSpec(db, 'task_test')), approvedBy: 'user' });
    return { root, repo, db, adapter, manager, verifier, supervisor, options, input, confirm, close: () => {
            db.close();
            rmSync(root, { recursive: true, force: true });
        } };
}
