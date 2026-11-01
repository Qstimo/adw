import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { ReviewVerdictSchema, PatchAcceptanceSchema, type Worktree, type PatchAcceptance } from '@adw/contracts';
import { acceptPatch, samePatchSnapshot, type GitWorktreeManager } from '@adw/git';
import type { EvidenceStore } from '@adw/verifier';
import { stableJson } from '@adw/context';
/** Trusted local-core boundary. Call only after showing this exact review/snapshot to the user. */
export async function acceptReviewedPatch(input: {
    db: Database.Database;
    manager: GitWorktreeManager;
    evidenceStore: EvidenceStore;
    taskId: string;
    reviewId: string;
    approvedBy: string;
    worktree: Worktree;
}): Promise<PatchAcceptance> {
    const { db, manager } = input;
    const acceptanceRunId=randomUUID();
    if (!input.approvedBy.trim())
        throw new Error('Explicit human approval actor required');
    if (input.worktree.taskId !== input.taskId)
        throw new Error('Worktree belongs to another task');
    const audit = (action: string, payload: unknown) => db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(), new Date().toISOString(), input.approvedBy, action, JSON.stringify(payload));
    const gate = db.transaction(() => {
        const prior = db.prepare('SELECT * FROM review_acceptances WHERE task_id=?').get(input.taskId) as {
            status: string;
            review_id: string;
            acceptance_json: string | null;
        } | undefined;
        if (prior?.status === 'accepted' && prior.review_id === input.reviewId && prior.acceptance_json)
            return { receipt: PatchAcceptanceSchema.parse(JSON.parse(prior.acceptance_json)) };
        if (prior?.status === 'running' || prior?.status === 'accepted')
            throw new Error('Acceptance already claimed');
        const row = db.prepare('SELECT r.*,s.state,s.state_json,s.active,t.status AS task_status,t.base_branch,p.path FROM review_runs r JOIN supervisor_runs s ON s.id=r.supervisor_run_id JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id WHERE r.id=? AND r.task_id=?').get(input.reviewId, input.taskId) as {
            id: string;
            supervisor_run_id: string;
            verdict_json: string;
            snapshot_json: string;
            evidence_ref: string;
            status: string;
            state: string;
            state_json: string;
            active: number;
            task_status: string;
            base_branch: string;
            path: string;
        } | undefined;
        if (!row || row.status !== 'approved' || row.state !== 'ready_for_human_review' || row.active || row.task_status !== 'ready_for_review')
            throw new Error('An independently approved completed review is required');
        if (realpathSync(row.path) !== manager.repoPath)
            throw new Error('Project repository mismatch');
        const latest = db.prepare('SELECT id FROM review_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(input.taskId) as {
            id: string;
        };
        if (latest.id !== row.id)
            throw new Error('Review is superseded');
        const review = ReviewVerdictSchema.parse(JSON.parse(row.verdict_json));
        if (stableJson(JSON.parse(input.evidenceStore.get(row.evidence_ref).toString())) !== stableJson(review))
            throw new Error('Review evidence differs from stored verdict');
        const run = JSON.parse(row.state_json);
        if (run.review?.id !== review.id || !run.verifiedSnapshot || !samePatchSnapshot(run.verifiedSnapshot, review.snapshot) || stableJson(JSON.parse(row.snapshot_json)) !== stableJson(review.snapshot))
            throw new Error('Review snapshot differs from completed verification');
        if (input.worktree.baseCommit !== review.snapshot.baseCommit)
            throw new Error('Worktree base differs from review');
        const executors = db.prepare("SELECT agent_id,runtime_session_id,provider_session_id FROM agent_sessions WHERE supervisor_run_id=? AND role='executor'").all(row.supervisor_run_id) as {
            agent_id: string;
            runtime_session_id: string | null;
            provider_session_id: string | null;
        }[];
        if (!executors.length || review.reviewerSessions.some(reviewer => executors.some(executor => executor.runtime_session_id === reviewer.sessionId || executor.agent_id === reviewer.agentId && executor.provider_session_id !== null && executor.provider_session_id === reviewer.providerSessionId)))
            throw new Error('Review is not independent from executor');
        const now = new Date().toISOString();
        if (db.prepare("UPDATE tasks SET status='reviewing',updated_at=? WHERE id=? AND status='ready_for_review'").run(now, input.taskId).changes !== 1)
            throw new Error('Task acceptance already claimed');
        if (prior)
            db.prepare("UPDATE review_acceptances SET id=?,review_id=?,actor=?,status='running',acceptance_json=NULL,created_at=?,ended_at=NULL WHERE task_id=? AND status='failed'").run(acceptanceRunId,review.id, input.approvedBy, now, input.taskId);
        else
            db.prepare("INSERT INTO review_acceptances (task_id,review_id,actor,status,acceptance_json,created_at,ended_at,id) VALUES (?,?,?,'running',NULL,?,NULL,?)").run(input.taskId, review.id, input.approvedBy, now,acceptanceRunId);
        audit('human_acceptance_started', { taskId: input.taskId, reviewId: review.id, acceptanceRunId,snapshot: review.snapshot });
        return { review, baseBranch: row.base_branch };
    }).immediate();
    if (gate.receipt)
        return gate.receipt;
    let receipt: PatchAcceptance | undefined;
    try {
        receipt = await acceptPatch(manager, { worktree: input.worktree, baseBranch: gate.baseBranch!, expectedSnapshot: gate.review!.snapshot });
        db.transaction(() => {
            if (db.prepare("UPDATE review_acceptances SET status='accepted',acceptance_json=?,ended_at=? WHERE task_id=? AND review_id=? AND id=? AND status='running'").run(JSON.stringify(receipt), new Date().toISOString(), input.taskId, input.reviewId,acceptanceRunId).changes !== 1)
                throw new Error('Acceptance lease lost; reconcile Git receipt before retry');
            if (db.prepare("UPDATE tasks SET status='accepted',updated_at=? WHERE id=? AND status='reviewing'").run(new Date().toISOString(), input.taskId).changes !== 1)
                throw new Error('Task state changed during acceptance; reconcile Git receipt');
            audit('human_patch_accepted', { taskId: input.taskId, reviewId: input.reviewId, receipt });
        }).immediate();
        return receipt;
    }
    catch (error) {
        if (!receipt)
            db.transaction(() => {
                const released=db.prepare("UPDATE review_acceptances SET status='failed',ended_at=? WHERE task_id=? AND review_id=? AND id=? AND status='running'").run(new Date().toISOString(), input.taskId, input.reviewId,acceptanceRunId);
                if(released.changes===1)db.prepare("UPDATE tasks SET status='ready_for_review',updated_at=? WHERE id=? AND status='reviewing'").run(new Date().toISOString(), input.taskId);
                audit('human_acceptance_failed', { taskId: input.taskId, reviewId: input.reviewId, error: String(error) });
            }).immediate();
        throw error;
    }
}
