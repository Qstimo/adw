import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { TaskIdSchema, type CheckResult, type PatchSnapshot, type Worktree,type WebVerificationInput } from '@adw/contracts';
import { GitWorktreeManager, resolveBaseCommit, capturePatchSnapshot, samePatchSnapshot } from '@adw/git';
import { VerifierRunner, type CheckDefinition } from '@adw/verifier';

interface ClaimedTask { acceptance_json:string; base_branch: string; base_commit: string; project_path: string; status: string }
export class GitVerifierFacade {
  constructor(private readonly db: Database.Database, readonly manager: GitWorktreeManager, readonly verifier: VerifierRunner) {}
  private audit(action: string, payload: unknown): void {
    this.db.prepare('INSERT INTO audit_events (id,at,actor,action,payload_json) VALUES (?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),'git-verifier',action,JSON.stringify(payload));
  }
  private ownsRun(taskId: string, runId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM verification_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=? AND r.task_id=? AND r.status='running' AND t.status='verifying'").get(runId,taskId);
  }
  private storeResults(taskId: string, runId: string, results: CheckResult[]): void {
    const insert = this.db.prepare('INSERT INTO check_results (id,task_id,name,command,exit_code,duration_ms,env_fingerprint,artifacts_json,coverage,base_commit,not_verified,blocking,created_at,verification_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of results) insert.run(randomUUID(),taskId,r.name,r.command,r.exitCode,r.durationMs,r.environmentFingerprint,JSON.stringify(r.artifactRefs),r.coverage ?? null,r.baseCommit ?? null,Number(r.notVerified),Number(r.blocking),new Date().toISOString(),runId);
  }
  async verifyTask(input: { taskId: string; checks: CheckDefinition[]; env?: NodeJS.ProcessEnv; timeoutMs?: number;web?:WebVerificationInput }) {
    TaskIdSchema.parse(input.taskId);
    const runId = randomUUID();
    // No await before this transaction: claim and audit are durable and atomic.
    // The partial unique index also fences another process with its own DB connection.
    const task = this.db.transaction(() => {
      const row = this.db.prepare('SELECT tasks.*, projects.path AS project_path FROM tasks JOIN projects ON projects.id=tasks.project_id WHERE tasks.id=?').get(input.taskId) as ClaimedTask | undefined;
      if (!row) throw new Error('Task not found');
      if (this.db.prepare("SELECT 1 FROM supervisor_runs WHERE task_id=? AND active=1").get(input.taskId)) throw new Error('Task is owned by Supervisor');
      if (!['locked','queued'].includes(row.status)) throw new Error('Task must be locked or queued before verification');
      if (realpathSync(row.project_path) !== this.manager.repoPath) throw new Error('Task belongs to another repository');
      const now = new Date().toISOString();
      const claim = this.db.prepare("UPDATE tasks SET status='verifying',updated_at=? WHERE id=? AND status IN ('locked','queued')").run(now,input.taskId);
      if (claim.changes !== 1) throw new Error('Task is already claimed');
      this.db.prepare("INSERT INTO verification_runs (id,task_id,status,started_at) VALUES (?,?,'running',?)").run(runId,input.taskId,now);
      this.audit('verification_started',{ taskId: input.taskId, runId, baseCommit: row.base_commit });
      return row;
    }).immediate();
    let worktree: Worktree | undefined;
    try {
      if (await resolveBaseCommit(this.manager.repoPath, task.base_branch) !== task.base_commit) throw new Error('Base branch has drifted');
      worktree = await this.manager.createTaskWorktree({ taskId: input.taskId, baseBranch: task.base_branch });
      if (worktree.baseCommit !== task.base_commit) throw new Error('Base changed while creating worktree');
      const before = await capturePatchSnapshot(this.manager,worktree);
      this.db.transaction(() => {
        if (!this.ownsRun(input.taskId,runId)) throw new Error('Verification run no longer owns the task');
        this.db.prepare('UPDATE verification_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(before),runId);
        this.audit('verification_worktree_created',{ taskId: input.taskId, runId, worktree, snapshot: before });
      })();
      const run = await this.verifier.run({ ...input,acceptance:JSON.parse((task as ClaimedTask).acceptance_json), worktreePath: worktree.path, baseCommit: task.base_commit });
      let after: PatchSnapshot | undefined;
      let snapshotError: string | undefined;
      try { after = await capturePatchSnapshot(this.manager,worktree); }
      catch (error) { snapshotError = String(error); }
      const stable = after !== undefined && samePatchSnapshot(before,after);
      const readyForReview = stable && run.readyForReview;
      const results = stable ? run.results : run.results.map(result => ({ ...result, notVerified: true }));
      const warnings = stable ? run.warnings : [...run.warnings, `Task snapshot changed during verification${snapshotError ? `: ${snapshotError}` : ''}`];
      const diff = await this.manager.diff(worktree);
      this.db.transaction(() => {
        if (!this.ownsRun(input.taskId,runId)) throw new Error('Verification run no longer owns the task');
        this.storeResults(input.taskId,runId,results);
        const now = new Date().toISOString();
        // Passing checks alone still cannot bypass the future independent reviewer.
        this.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(readyForReview ? 'verifying' : 'failed',now,input.taskId);
        this.db.prepare('UPDATE verification_runs SET status=?,ended_at=?,error=? WHERE id=?').run(readyForReview ? 'passed' : 'failed',now,stable ? null : 'Task snapshot changed during verification',runId);
        this.audit('verification_finished',{ taskId: input.taskId, runId, worktree, checksPassed: readyForReview, snapshot: before, finalSnapshot: after, warnings, diffRef: this.verifier.evidenceStore.put(diff) });
      })();
      return { ...run, runId, results, warnings, readyForReview, worktree, diff, verifiedSnapshot: readyForReview ? before : undefined };
    } catch (error) {
      this.db.transaction(() => {
        if (!this.ownsRun(input.taskId,runId)) {
          // Release only this obsolete run, even when an external cancellation
          // changed the task state without yet closing its lease.
          this.db.prepare("UPDATE verification_runs SET status='failed',ended_at=?,error=? WHERE id=? AND status='running'").run(new Date().toISOString(),String(error),runId);
          this.audit('verification_discarded',{ taskId: input.taskId, runId, error: String(error) });
          return;
        }
        const now = new Date().toISOString();
        this.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('failed',now,input.taskId);
        this.db.prepare("UPDATE verification_runs SET status='failed',ended_at=?,error=? WHERE id=?").run(now,String(error),runId);
        this.audit('verification_failed',{ taskId: input.taskId, runId, worktree, error: String(error) });
      })();
      throw error;
    }
  }
}
