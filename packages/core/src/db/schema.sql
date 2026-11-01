CREATE TABLE projects (
 id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, default_base_branch TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), intent TEXT NOT NULL,
 acceptance_json TEXT NOT NULL CHECK(json_valid(acceptance_json)), out_of_scope_json TEXT NOT NULL CHECK(json_valid(out_of_scope_json)),
 base_branch TEXT NOT NULL, base_commit TEXT NOT NULL CHECK(length(base_commit)=40),
 status TEXT NOT NULL CHECK(status IN ('draft','locked','queued','running','verifying','reviewing','ready_for_review','accepted','rejected','failed','cancelled','needs_human')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE context_artifacts (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES tasks(id),
 kind TEXT NOT NULL, content_ref TEXT NOT NULL, summary_ref TEXT,
 base_commit TEXT NOT NULL CHECK(length(base_commit)=40), source_paths_json TEXT NOT NULL CHECK(json_valid(source_paths_json)),
 source_hashes_json TEXT NOT NULL CHECK(json_valid(source_hashes_json)), producer_agent TEXT NOT NULL,
 confidence TEXT NOT NULL CHECK(confidence IN ('verified','inferred','unverified')), created_at TEXT NOT NULL,
 expires_at TEXT, invalidated_at TEXT, visibility TEXT NOT NULL CHECK(visibility IN ('project','task','session')),
 token_estimate INTEGER NOT NULL CHECK(token_estimate >= 0)
);
CREATE TABLE findings (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), claim TEXT NOT NULL,
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)), affected_paths_json TEXT NOT NULL CHECK(json_valid(affected_paths_json)),
 verification_status TEXT NOT NULL CHECK(verification_status IN ('verified','inferred','unverified')), created_at TEXT NOT NULL
);
CREATE TABLE agent_sessions (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
 status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE check_results (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), name TEXT NOT NULL, command TEXT NOT NULL,
 exit_code INTEGER, duration_ms REAL NOT NULL CHECK(duration_ms >= 0), env_fingerprint TEXT NOT NULL,
 artifacts_json TEXT NOT NULL CHECK(json_valid(artifacts_json)), coverage TEXT, base_commit TEXT CHECK(base_commit IS NULL OR length(base_commit)=40),
 not_verified INTEGER NOT NULL DEFAULT 0 CHECK(not_verified IN (0,1)), blocking INTEGER NOT NULL CHECK(blocking IN (0,1)),
 created_at TEXT NOT NULL, CHECK(exit_code IS NOT NULL OR not_verified=1)
);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);
CREATE INDEX tasks_project ON tasks(project_id);
CREATE INDEX artifacts_project_base ON context_artifacts(project_id,base_commit);
CREATE INDEX artifacts_task ON context_artifacts(task_id);
CREATE INDEX findings_task ON findings(task_id);
CREATE INDEX sessions_task ON agent_sessions(task_id);
CREATE INDEX checks_task ON check_results(task_id);
CREATE INDEX audit_at ON audit_events(at);
