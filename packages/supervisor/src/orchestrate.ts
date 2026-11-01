import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { AgentEventSchema, type AgentEvent, type PatchSnapshot, type Worktree, type ReviewRemark, type ReviewVerdict,type WebVerificationInput,WebVerificationSchema } from '@adw/contracts';
import type { AgentAdapter } from '@adw/cli-adapters';
import { GitWorktreeManager, capturePatchSnapshot, samePatchSnapshot, resolveBaseCommit } from '@adw/git';
import { VerifierRunner, redactWebConfig,type CheckDefinition, type VerificationRun } from '@adw/verifier';
import type { BuiltBundle } from '@adw/context';
import { getLockedSpec, type LockedSpec } from './spec-lock.js';
import { validateDag, readyNodes, type PlanNode, type ScheduledNode } from './dag.js';
import { transition } from './machine.js';
import { taskStatus, type SupervisorState, type SupervisorEvent } from './states.js';
import { routeAgent, type RouteCandidate } from './router.js';
import { RetryPolicy, failureFingerprint } from './retry.js';
import { ReviewEngine, type SessionIdentity, type SessionOutcome } from './review/engine.js';
export interface RunLimits {
    wallTimeMs: number;
    sessionTimeoutMs: number;
    bundleTokens: number;
    maxTokens?: number;
    maxCost?: number;
    maxFixCycles?: number;
}
export interface ContextHandle {
    buildBundle(input: {
        agentId: string;
        tokenBudget: number;
        query?: string;
    }): Promise<BuiltBundle>;
    publishReviewFinding(remark: ReviewRemark, evidenceRefs: string[], producerAgent: string): string;
    close(): void;
}
export interface SupervisorOptions {
    db: Database.Database;
    manager: GitWorktreeManager;
    verifier: VerifierRunner;
    adapters: readonly AgentAdapter[];
    createContext(worktree: Worktree): Promise<ContextHandle>;
    // Normalized policy estimates, not measured cost/quality claims.
    routeMetrics?: Partial<Record<string, Partial<Pick<RouteCandidate, 'available' | 'costEstimate' | 'locality' | 'risk' | 'quality'>>>>;
}
export interface RunInput {
    taskId: string;
    nodes?: readonly PlanNode[];
    checks: CheckDefinition[];
    web?:WebVerificationInput;
    limits: RunLimits;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}
export interface SupervisorResult {
    runId: string;
    taskId: string;
    state: SupervisorState;
    nodes: ScheduledNode[];
    worktree?: Worktree;
    verifiedSnapshot?: PatchSnapshot;
    diffRef?: string;
    review?: ReviewVerdict;
    reason?: string;
    tokens: number;
    cost: number;
    usageComplete: {
        tokens: boolean;
        cost: boolean;
    };
}
class StopRun extends Error {
    constructor(readonly code: 'timeout' | 'budget' | 'cancelled', message: string) {
        super(message);
    }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        void promise.catch(() => {
        });
        return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
export class Supervisor {
    private active = false;
    constructor(private readonly options: SupervisorOptions) {
    }
    private audit(action: string, payload: unknown) {
        this.options.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(), new Date().toISOString(), 'supervisor', action, JSON.stringify(payload));
    }
    async run(input: RunInput): Promise<SupervisorResult> {
        if (this.active)
            throw new Error('Supervisor already running; scheduler is serial');
        // Copy policy at the service boundary so callers cannot mutate limits/plans mid-run.
        const limits = structuredClone(input.limits), checks = structuredClone(input.checks), env = input.env ? { ...input.env } : undefined;
        for (const value of [limits.wallTimeMs, limits.sessionTimeoutMs, limits.bundleTokens])
            if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
                throw new Error('Invalid run limits');
        if (limits.bundleTokens > 1000000)
            throw new Error('Invalid bundle token budget');
        for (const value of [limits.maxTokens, limits.maxCost])
            if (value !== undefined && (!Number.isFinite(value) || value <= 0))
                throw new Error('Invalid usage budget');
        if (checks.length > 100 || checks.some(check => check.name.length > 256 || check.command.length > 64000))
            throw new Error('Verification suite exceeds metadata limits');
        if (!checks.length || !checks.some(check => check.blocking) || checks.some(check => !check.name.trim() || !check.command.trim() || check.timeoutMs !== undefined && (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 2147483647)))
            throw new Error('Required valid verification checks needed');
        const web=input.web?WebVerificationSchema.parse(structuredClone(input.web)):undefined;
        const retry = new RetryPolicy(limits.maxFixCycles ?? 3), spec = getLockedSpec(this.options.db, input.taskId);
        if(web?.enabled)for(const criterion of web.acceptance)if(criterion.required&&criterion.acceptanceIndex===undefined||criterion.acceptanceIndex!==undefined&&criterion.acceptanceIndex>=spec.acceptance.length)throw new Error('Web acceptance differs from locked spec');
        const nodes = validateDag(input.nodes ?? [{ id: 'implement', dependsOn: [], instruction: spec.intent }]);
        const runId = randomUUID(), result: SupervisorResult = { runId, taskId: spec.id, state: 'spec_locked', nodes, tokens: 0, cost: 0, usageComplete: { tokens: true, cost: true } };
        const { db, manager, verifier } = this.options;
        const row = db.prepare('SELECT path FROM projects WHERE id=?').get(spec.projectId) as {
            path: string;
        };
        if (realpathSync(row.path) !== manager.repoPath)
            throw new Error('Task belongs to another repository');
        if (new Set(this.options.adapters.map(adapter => adapter.id)).size !== this.options.adapters.length)
            throw new Error('Duplicate adapters');
        db.transaction(() => {
            if (db.prepare("SELECT 1 FROM verification_runs WHERE task_id=? AND status='running'").get(spec.id))
                throw new Error('Task verification already active');
            const claimed = db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=? AND status='locked'").run(new Date().toISOString(), spec.id);
            if (claimed.changes !== 1)
                throw new Error('Task is not available for execution');
            db.prepare('INSERT INTO supervisor_runs VALUES (?,?,?,?,?,?,?)').run(runId, spec.id, result.state, JSON.stringify(result), 1, new Date().toISOString(), null);
            this.audit('supervisor_started', { runId, taskId: spec.id, spec, nodes, limits, checks,web:redactWebConfig(web) });
        }).immediate();
        this.active = true;
        const controller = new AbortController();
        const externalAbort = () => controller.abort(new StopRun('cancelled', 'Cancelled by caller'));
        input.signal?.addEventListener('abort', externalAbort, { once: true });
        if (input.signal?.aborted)
            externalAbort();
        const deadline = setTimeout(() => controller.abort(new StopRun('timeout', 'Supervisor wall time exceeded')), limits.wallTimeMs);
        let context: ContextHandle | undefined;
        const executorSessions: SessionIdentity[] = [];
        let lastChecks: VerificationRun | undefined;
        const hasOwnership = () => (db.prepare('SELECT active FROM supervisor_runs WHERE id=?').get(runId) as {
            active: number;
        } | undefined)?.active === 1;
        const owned = () => {
            if (!hasOwnership())
                throw new Error('Supervisor run lost ownership');
        };
        const persist = (event?: SupervisorEvent) => db.transaction(() => {
            owned();
            if (event)
                result.state = transition(result.state, event);
            db.prepare('UPDATE supervisor_runs SET state=?,state_json=? WHERE id=? AND active=1').run(result.state, JSON.stringify(result), runId);
            db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(taskStatus(result.state), new Date().toISOString(), spec.id);
            if (event)
                this.audit('supervisor_transition', { runId, taskId: spec.id, event, state: result.state });
        }).immediate();
        try {
            controller.signal.throwIfAborted();
            persist({ type: 'plan' });
            persist({ type: 'schedule' });
            if (await resolveBaseCommit(manager.repoPath, spec.baseBranch) !== spec.baseCommit)
                throw new Error('Base branch has drifted');
            controller.signal.throwIfAborted();
            result.worktree = await manager.createTaskWorktree({ taskId: spec.id, baseBranch: spec.baseBranch });
            if (result.worktree.baseCommit !== spec.baseCommit)
                throw new Error('Base changed while creating task worktree');
            persist();
            this.audit('supervisor_worktree_created', { runId, worktree: result.worktree });
            controller.signal.throwIfAborted();
            context = await this.options.createContext(result.worktree);
            controller.signal.throwIfAborted();
            const candidates: RouteCandidate[] = [];
            for (const adapter of this.options.adapters) {
                try {
                    const discovered = await abortable(adapter.discover(controller.signal), controller.signal);
                    const capabilities = await abortable(adapter.probeCapabilities(discovered.version, controller.signal), controller.signal);
                    candidates.push({ agentId: adapter.id, capabilities, available: true, costEstimate: 0.5, locality: 0, risk: 0.5, quality: 0.5, ...this.options.routeMetrics?.[adapter.id] });
                }
                catch (error) {
                    controller.signal.throwIfAborted();
                    this.audit('agent_discovery_failed', { runId, agentId: adapter.id, error: String(error) });
                }
            }
            while (nodes.some(node => node.status !== 'passed')) {
                controller.signal.throwIfAborted();
                const ready = readyNodes(nodes);
                if (!ready[0])
                    throw new Error('No schedulable DAG node');
                this.audit('dag_scheduled', { runId, ready: ready.map(node => node.id), wouldParallelize: ready.length > 1 });
                const node = ready[0];
                node.status = 'running';
                const route = routeAgent(candidates, { tokens: limits.maxTokens !== undefined, cost: limits.maxCost !== undefined }, node.agentHint);
                this.audit('agent_routed', { runId, nodeId: node.id, ...route });
                const adapter = this.options.adapters.find(adapter => adapter.id === route.agentId)!;
                persist({ type: 'start' });
                let feedback = '';
                while (true) {
                    controller.signal.throwIfAborted();
                    const bundle = await context.buildBundle({ agentId: adapter.id, tokenBudget: limits.bundleTokens });
                    controller.signal.throwIfAborted();
                    const prompt = this.prompt(spec, node, bundle.bundlePath, feedback);
                    this.audit('agent_bundle_attached', { runId, nodeId: node.id, contentRef: bundle.contentRef, overBudget: bundle.bundle.overBudget });
                    const executed = await this.executeAgent(adapter, { worktreePath: result.worktree.path, prompt, bundlePath: bundle.bundlePath, timeoutMs: Math.min(limits.sessionTimeoutMs, limits.wallTimeMs), signal: controller.signal }, controller, limits, result, node.id, owned);
                    executorSessions.push(executed);
                    controller.signal.throwIfAborted();
                    persist({ type: 'agent_completed' });
                    // Agent must commit its edits; snapshot capture refuses untracked/dirty content.
                    const verified = await this.verify(result.worktree, checks, env, controller.signal, runId, owned,web,spec.acceptance);
                    controller.signal.throwIfAborted();
                    if (verified.run.readyForReview && verified.snapshot) {
                        lastChecks = verified.run;
                        node.status = 'passed';
                        result.verifiedSnapshot = verified.snapshot;
                        result.diffRef = verified.diffRef;
                        persist({ type: 'verification_passed', allNodesComplete: nodes.every(item => item.status === 'passed') });
                        break;
                    }
                    result.verifiedSnapshot = undefined;
                    result.diffRef = undefined;
                    persist({ type: 'verification_failed' });
                    const fingerprint = failureFingerprint(verified.run.results), decision = retry.failure(fingerprint);
                    let inlineBytes = 0;
                    const diagnostics = verified.run.results.map(check => ({ name: check.name, output: check.artifactRefs.slice(0, 2).map((ref, stream) => {
                            const bytes = verifier.evidenceStore.get(ref), hash = ref.slice(7), path = join(verifier.evidenceStore.root, hash.slice(0, 2), hash);
                            const include = inlineBytes + bytes.length <= 256 * 1024;
                            if (include)
                                inlineBytes += bytes.length;
                            const text = bytes.toString('utf8'), encoding = Buffer.from(text).equals(bytes) ? 'utf8' : 'base64';
                            return { stream: stream === 0 ? 'stdout' : 'stderr', ref, path, bytes: bytes.length, encoding, ...(include ? { content: encoding === 'utf8' ? text : bytes.toString('base64') } : { inlineOmitted: true }) };
                        }) }));
                    const feedbackValue = { type: 'verification_feedback', nodeId: node.id, fingerprint, results: verified.run.results, diagnostics, warnings: verified.run.warnings, decision };
                    const rawFeedback = JSON.stringify(feedbackValue), ref = verifier.evidenceStore.put(rawFeedback), hash = ref.slice(7);
                    const evidencePath = join(verifier.evidenceStore.root, hash.slice(0, 2), hash);
                    feedback = JSON.stringify({ ...Buffer.byteLength(rawFeedback) <= 512 * 1024 ? feedbackValue : { type: 'verification_feedback', inlineOmitted: true }, evidenceRef: ref, evidencePath, instruction: 'Read full feedback and original output files at the supplied paths; omitted inline bytes are not a summary.' });
                    this.audit('fix_cycle', { runId, taskId: spec.id, feedbackRef: ref, ...decision });
                    if (decision.action === 'needs_human') {
                        result.reason = decision.reason;
                        persist({ type: 'escalate', reason: decision.reason });
                        break;
                    }
                    persist({ type: 'retry' });
                }
                if (result.state === 'needs_human')
                    break;
            }
            if (result.state === 'reviewing' && result.verifiedSnapshot && lastChecks) {
                const engine = new ReviewEngine(manager, verifier.evidenceStore);
                const lastExecutor = executorSessions.at(-1)!;
                const review = await engine.review({ task: spec, worktree: result.worktree, snapshot: result.verifiedSnapshot, checks: lastChecks.results, executorSessions, signal: controller.signal,
                    selectReviewer: category => {
                        const others = candidates.filter(candidate => candidate.agentId !== lastExecutor.agentId);
                        let route;
                        try {
                            route = routeAgent(others, { tokens: limits.maxTokens !== undefined, cost: limits.maxCost !== undefined });
                        }
                        catch {
                            route = routeAgent(candidates, { tokens: limits.maxTokens !== undefined, cost: limits.maxCost !== undefined });
                        }
                        this.audit('reviewer_routed', { runId, category, ...route });
                        return this.options.adapters.find(adapter => adapter.id === route.agentId)!;
                    },
                    buildBundle: agentId => context!.buildBundle({ agentId, tokenBudget: limits.bundleTokens }),
                    runSession: (adapter, request) => this.executeAgent(adapter, { worktreePath: result.worktree!.path, prompt: request.prompt, bundlePath: request.bundlePath, timeoutMs: Math.min(limits.sessionTimeoutMs, limits.wallTimeMs), signal: controller.signal, role: 'reviewer' }, controller, limits, result, 'review_' + request.category, owned, request.forbiddenSessions)
                });
                controller.signal.throwIfAborted();
                owned();
                const evidenceRef = verifier.evidenceStore.put(JSON.stringify(review));
                db.transaction(() => {
                    owned();
                    db.prepare('INSERT INTO review_runs VALUES (?,?,?,?,?,?,?,?)').run(review.id, spec.id, runId, JSON.stringify(review.snapshot), JSON.stringify(review), review.status, evidenceRef, new Date().toISOString());
                    for (const remark of review.remarks) {
                        const findingId = context!.publishReviewFinding(remark, [...new Set([...review.evidenceRefs, evidenceRef])], review.reviewerSessions.find(session => session.category === remark.category)?.agentId ?? 'reviewer');
                        db.prepare('INSERT INTO review_findings VALUES (?,?,?)').run(review.id, remark.id, findingId);
                    }
                    this.audit('review_finished', { runId, reviewId: review.id, status: review.status, evidenceRef });
                }).immediate();
                result.review = review;
                if (review.status === 'approved')
                    persist({ type: 'review_approved' });
                else {
                    result.reason = review.status === 'changes_requested' ? 'Independent review requests changes' : review.reason ?? 'Independent review is inconclusive';
                    if (review.status === 'changes_requested')
                        persist({ type: 'review_changes_requested' });
                    persist({ type: 'escalate', reason: result.reason });
                }
            }
        }
        catch (error) {
            const stop = controller.signal.aborted ? controller.signal.reason : error;
            result.reason = String(stop);
            result.verifiedSnapshot = undefined;
            result.diffRef = undefined;
            if (hasOwnership())
                persist({ type: stop instanceof StopRun && stop.code === 'cancelled' ? 'cancel' : 'fail', reason: result.reason });
            else {
                result.state = 'failed';
                this.audit('supervisor_discarded', { runId, reason: result.reason });
            }
        }
        finally {
            clearTimeout(deadline);
            input.signal?.removeEventListener('abort', externalAbort);
            try {
                context?.close();
            }
            finally {
                try {
                    db.transaction(() => {
                        if (!hasOwnership())
                            return;
                        db.prepare('UPDATE supervisor_runs SET active=0,state=?,state_json=?,ended_at=? WHERE id=?').run(result.state, JSON.stringify(result), new Date().toISOString(), runId);
                        this.audit('supervisor_finished', result);
                    }).immediate();
                }
                finally {
                    this.active = false;
                }
            }
        }
        return structuredClone(result);
    }
    private prompt(spec: LockedSpec, node: PlanNode, bundlePath: string, feedback: string): string {
        return `${spec.intent}\nAcceptance (all clauses remain mandatory):\n${JSON.stringify(spec.acceptance)}\nOut of scope:\n${JSON.stringify(spec.outOfScope)}\nSubtask ${node.id}: ${node.instruction}\nRead context bundle: ${bundlePath}\nWork only in the supplied task worktree. Commit all task edits before completing. Do not change the primary checkout. Your completed event requests independent verification; it does not certify acceptance.\n${feedback ? 'Independent verification feedback:\n' + feedback : ''}`;
    }
    private async executeAgent(adapter: AgentAdapter, sessionInput: Parameters<AgentAdapter['startSession']>[0], controller: AbortController, limits: RunLimits, result: SupervisorResult, nodeId: string, owned: () => void, forbiddenSessions: SessionIdentity[] = []): Promise<SessionOutcome> {
        const { db } = this.options;
        const recordId = randomUUID();
        let sessionId: string | undefined, providerSessionId: string | undefined, terminal: AgentEvent | undefined;
        let tokens = 0, cost = 0, usageSeen = false, costSeen = false, count = 0, eventBytes = 0;
        db.prepare('INSERT INTO agent_sessions (id,task_id,agent_id,worktree_path,status,started_at,ended_at,role,supervisor_run_id) VALUES (?,?,?,?,?,?,?,?,?)').run(recordId, result.taskId, adapter.id, sessionInput.worktreePath, 'running', new Date().toISOString(), null, sessionInput.role ?? 'executor', result.runId);
        const stop = () => {
            if (sessionId)
                void adapter.cancel(sessionId).catch(() => {
                });
        };
        controller.signal.addEventListener('abort', stop, { once: true });
        const timeout = setTimeout(() => controller.abort(new StopRun('timeout', 'Agent session timed out')), sessionInput.timeoutMs);
        let status = 'failed';
        try {
            const consume = (async () => {
                for await (const raw of adapter.startSession(sessionInput)) {
                    if (controller.signal.aborted) {
                        if (raw.sessionId)
                            await adapter.cancel(raw.sessionId);
                        controller.signal.throwIfAborted();
                    }
                    owned();
                    const event = AgentEventSchema.parse(raw);
                    if (++count > 100000 || (eventBytes += Buffer.byteLength(JSON.stringify(event))) > 16 * 1024 * 1024)
                        throw new Error('Agent event journal limit exceeded');
                    if (terminal)
                        throw new Error('Event received after terminal agent event');
                    if (sessionId && event.sessionId !== sessionId)
                        throw new Error('Agent changed session identity');
                    if (forbiddenSessions.some(previous => previous.sessionId === event.sessionId || previous.agentId === adapter.id && previous.providerSessionId !== undefined && previous.providerSessionId === event.providerSessionId))
                        throw new Error('Reviewer session is not independent');
                    sessionId = event.sessionId;
                    if (event.providerSessionId)
                        providerSessionId = event.providerSessionId;
                    this.audit('agent_event', { runId: result.runId, nodeId, recordId, event });
                    if (event.type === 'usage') {
                        if (event.tokens !== undefined) {
                            usageSeen = true;
                            const next = Math.max(tokens, event.tokens);
                            result.tokens += next - tokens;
                            tokens = next;
                        }
                        if (event.cost !== undefined) {
                            costSeen = true;
                            const next = Math.max(cost, event.cost);
                            result.cost += next - cost;
                            cost = next;
                        }
                        if (limits.maxTokens !== undefined && result.tokens >= limits.maxTokens || limits.maxCost !== undefined && result.cost >= limits.maxCost) {
                            controller.abort(new StopRun('budget', 'Agent usage budget exhausted'));
                            controller.signal.throwIfAborted();
                        }
                    }
                    if (event.type === 'failed' || event.type === 'completed')
                        terminal = event;
                }
            })();
            await abortable(consume, controller.signal);
            if (!terminal || terminal.type !== 'completed')
                throw new Error(terminal?.type === 'failed' ? `Agent failed: ${terminal.reason}` : 'Agent ended without completed event');
            if (limits.maxTokens !== undefined && !usageSeen || limits.maxCost !== undefined && !costSeen)
                throw new Error('Required usage telemetry missing; result not verified');
            status = 'completed';
            return { agentId: adapter.id, sessionId: sessionId!, ...(providerSessionId ? { providerSessionId } : {}), summary: terminal.summary };
        }
        finally {
            if (!usageSeen)
                result.usageComplete.tokens = false;
            if (!costSeen)
                result.usageComplete.cost = false;
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', stop);
            if (status !== 'completed' && sessionId)
                await adapter.cancel(sessionId);
            db.prepare('UPDATE agent_sessions SET status=?,ended_at=?,runtime_session_id=?,provider_session_id=? WHERE id=?').run(status, new Date().toISOString(), sessionId ?? null, providerSessionId ?? null, recordId);
            this.audit('agent_session_finished', { runId: result.runId, recordId, sessionId, providerSessionId, status, tokens, cost });
        }
    }
    private async verify(worktree: Worktree, checks: CheckDefinition[], env: NodeJS.ProcessEnv | undefined, signal: AbortSignal, supervisorRunId: string, owned: () => void,web?:WebVerificationInput,acceptance?:readonly string[]): Promise<{
        run: VerificationRun;
        snapshot?: PatchSnapshot;
        diffRef: string;
    }> {
        const { db, manager, verifier } = this.options;
        signal.throwIfAborted();
        owned();
        const before = await capturePatchSnapshot(manager, worktree), verificationId = randomUUID();
        signal.throwIfAborted();
        db.prepare("INSERT INTO verification_runs (id,task_id,status,started_at,snapshot_json) VALUES (?,?,'running',?,?)").run(verificationId, worktree.taskId, new Date().toISOString(), JSON.stringify(before));
        this.audit('verification_started', { supervisorRunId, runId: verificationId, taskId: worktree.taskId, snapshot: before });
        try {
            const run = await verifier.run({ worktreePath: worktree.path, baseCommit: worktree.baseCommit, checks, env, signal, stopOnLimit: true,web,acceptance });
            let after: PatchSnapshot | undefined;
            try {
                after = await capturePatchSnapshot(manager, worktree);
            }
            catch (error) {
                run.warnings.push(String(error));
            }
            const diff = await manager.diff(worktree), diffRef = verifier.evidenceStore.put(diff);
            const stable = after !== undefined && samePatchSnapshot(before, after) && createHash('sha256').update(diff).digest('hex') === before.patchHash;
            if (!stable) {
                run.readyForReview = false;
                run.results = run.results.map(item => ({ ...item, notVerified: true }));
                run.warnings.push('Task snapshot changed during verification');
            }
            if (signal.aborted)
                run.readyForReview = false;
            db.transaction(() => {
                owned();
                const insert = db.prepare('INSERT INTO check_results (id,task_id,name,command,exit_code,duration_ms,env_fingerprint,artifacts_json,coverage,base_commit,not_verified,blocking,created_at,verification_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
                for (const r of run.results)
                    insert.run(randomUUID(), worktree.taskId, r.name, r.command, r.exitCode, r.durationMs, r.environmentFingerprint, JSON.stringify(r.artifactRefs), r.coverage ?? null, r.baseCommit ?? null, Number(r.notVerified), Number(r.blocking), new Date().toISOString(), verificationId);
                db.prepare('UPDATE verification_runs SET status=?,ended_at=? WHERE id=?').run(run.readyForReview ? 'passed' : 'failed', new Date().toISOString(), verificationId);
                this.audit('verification_finished', { supervisorRunId, runId: verificationId, readyForReview: run.readyForReview, before, after, diffRef, warnings: run.warnings });
            }).immediate();
            for (const check of run.results) {
                const metadata = JSON.parse(verifier.evidenceStore.get(check.artifactRefs[2]!).toString()) as {
                    reason?: string;
                };
                if (metadata.reason === 'timeout')
                    throw new StopRun('timeout', 'Verification check timed out');
                if (metadata.reason === 'output_limit')
                    throw new StopRun('budget', 'Verification output budget exhausted');
            }
            return { run, snapshot: run.readyForReview ? before : undefined, diffRef };
        }
        catch (error) {
            db.prepare("UPDATE verification_runs SET status='failed',ended_at=?,error=? WHERE id=? AND status='running'").run(new Date().toISOString(), String(error), verificationId);
            throw error;
        }
    }
}
