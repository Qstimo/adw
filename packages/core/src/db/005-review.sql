ALTER TABLE agent_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'executor' CHECK(role IN ('executor','reviewer'));
ALTER TABLE agent_sessions ADD COLUMN supervisor_run_id TEXT REFERENCES supervisor_runs(id);
ALTER TABLE agent_sessions ADD COLUMN runtime_session_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN provider_session_id TEXT;
CREATE TABLE review_runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), supervisor_run_id TEXT NOT NULL REFERENCES supervisor_runs(id),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), verdict_json TEXT NOT NULL CHECK(json_valid(verdict_json)),
 status TEXT NOT NULL CHECK(status IN ('approved','changes_requested','inconclusive')), evidence_ref TEXT NOT NULL, created_at TEXT NOT NULL,
 CHECK(json_extract(verdict_json,'$.status')=status),CHECK(json_extract(verdict_json,'$.taskId')=task_id),CHECK(json_extract(verdict_json,'$.id')=id)
);
CREATE INDEX reviews_task ON review_runs(task_id);
CREATE TABLE review_findings (
 review_id TEXT NOT NULL REFERENCES review_runs(id), remark_id TEXT NOT NULL, finding_id TEXT NOT NULL UNIQUE REFERENCES findings(id), PRIMARY KEY(review_id,remark_id)
);
CREATE TABLE review_acceptances (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), review_id TEXT NOT NULL REFERENCES review_runs(id), actor TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','accepted','failed')), acceptance_json TEXT CHECK(acceptance_json IS NULL OR json_valid(acceptance_json)), created_at TEXT NOT NULL, ended_at TEXT, id TEXT NOT NULL UNIQUE
);
CREATE TRIGGER review_runs_no_update BEFORE UPDATE ON review_runs BEGIN SELECT RAISE(ABORT,'Review verdicts are immutable'); END;
CREATE TRIGGER review_runs_no_delete BEFORE DELETE ON review_runs BEGIN SELECT RAISE(ABORT,'Review history is append-only'); END;
CREATE TRIGGER review_findings_no_update BEFORE UPDATE ON review_findings BEGIN SELECT RAISE(ABORT,'Review provenance is immutable'); END;
CREATE TRIGGER review_findings_no_delete BEFORE DELETE ON review_findings BEGIN SELECT RAISE(ABORT,'Review provenance is append-only'); END;
CREATE TRIGGER accepted_task_requires_review BEFORE UPDATE OF status ON tasks
WHEN NEW.status='accepted' AND EXISTS(SELECT 1 FROM supervisor_specs WHERE task_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM review_acceptances a JOIN review_runs r ON r.id=a.review_id WHERE a.task_id=NEW.id AND a.status='accepted' AND r.status='approved')
BEGIN SELECT RAISE(ABORT,'Independent approved review and human acceptance required'); END;
