CREATE TABLE verification_runs (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 status TEXT NOT NULL CHECK(status IN ('running','passed','failed')),
 started_at TEXT NOT NULL,
 ended_at TEXT,
 snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
 error TEXT
);
CREATE UNIQUE INDEX verification_runs_active_task ON verification_runs(task_id) WHERE status='running';
ALTER TABLE check_results ADD COLUMN verification_run_id TEXT REFERENCES verification_runs(id);
CREATE INDEX check_results_run ON check_results(verification_run_id);
