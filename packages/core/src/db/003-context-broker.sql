ALTER TABLE context_artifacts ADD COLUMN evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs_json));
ALTER TABLE context_artifacts ADD COLUMN session_id TEXT;
ALTER TABLE context_artifacts ADD COLUMN logical_key TEXT;
CREATE TABLE artifact_invalidations (
 artifact_id TEXT PRIMARY KEY REFERENCES context_artifacts(id), at TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE finding_artifacts (
 finding_id TEXT PRIMARY KEY REFERENCES findings(id), artifact_id TEXT NOT NULL UNIQUE REFERENCES context_artifacts(id)
);
CREATE TABLE artifact_promotions (
 source_artifact_id TEXT PRIMARY KEY REFERENCES context_artifacts(id), promoted_artifact_id TEXT NOT NULL UNIQUE REFERENCES context_artifacts(id)
);
CREATE TABLE context_bundles (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 base_commit TEXT NOT NULL, index_snapshot_id TEXT NOT NULL, agent_id TEXT NOT NULL, content_ref TEXT NOT NULL,
 cache_key TEXT NOT NULL, estimated_tokens INTEGER NOT NULL, over_budget INTEGER NOT NULL CHECK(over_budget IN (0,1)), created_at TEXT NOT NULL
);
CREATE INDEX context_bundles_task ON context_bundles(project_id,task_id);
CREATE TRIGGER context_artifacts_immutable BEFORE UPDATE ON context_artifacts
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.task_id IS NOT OLD.task_id
 OR NEW.kind IS NOT OLD.kind OR NEW.content_ref IS NOT OLD.content_ref OR NEW.summary_ref IS NOT OLD.summary_ref
 OR NEW.base_commit IS NOT OLD.base_commit OR NEW.source_paths_json IS NOT OLD.source_paths_json
 OR NEW.source_hashes_json IS NOT OLD.source_hashes_json OR NEW.producer_agent IS NOT OLD.producer_agent
 OR NEW.confidence IS NOT OLD.confidence OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR NEW.visibility IS NOT OLD.visibility OR NEW.token_estimate IS NOT OLD.token_estimate
 OR NEW.evidence_refs_json IS NOT OLD.evidence_refs_json OR NEW.session_id IS NOT OLD.session_id OR NEW.logical_key IS NOT OLD.logical_key
 OR (OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS NOT OLD.invalidated_at)
BEGIN SELECT RAISE(ABORT,'Context artifact snapshots are immutable'); END;
CREATE TRIGGER context_artifacts_no_delete BEFORE DELETE ON context_artifacts
BEGIN SELECT RAISE(ABORT,'Context artifact history is append-only'); END;
CREATE TRIGGER findings_no_update BEFORE UPDATE ON findings
BEGIN SELECT RAISE(ABORT,'Findings are immutable'); END;
CREATE TRIGGER findings_no_delete BEFORE DELETE ON findings
BEGIN SELECT RAISE(ABORT,'Finding history is append-only'); END;
CREATE TRIGGER context_bundles_no_update BEFORE UPDATE ON context_bundles
BEGIN SELECT RAISE(ABORT,'Context bundles are immutable'); END;
CREATE TRIGGER context_bundles_no_delete BEFORE DELETE ON context_bundles
BEGIN SELECT RAISE(ABORT,'Context bundle history is append-only'); END;
CREATE TRIGGER artifact_invalidations_no_update BEFORE UPDATE ON artifact_invalidations
BEGIN SELECT RAISE(ABORT,'Invalidation history is immutable'); END;
CREATE TRIGGER artifact_invalidations_no_delete BEFORE DELETE ON artifact_invalidations
BEGIN SELECT RAISE(ABORT,'Invalidation history is append-only'); END;
CREATE TRIGGER finding_artifacts_no_update BEFORE UPDATE ON finding_artifacts
BEGIN SELECT RAISE(ABORT,'Finding provenance is immutable'); END;
CREATE TRIGGER finding_artifacts_no_delete BEFORE DELETE ON finding_artifacts
BEGIN SELECT RAISE(ABORT,'Finding provenance is append-only'); END;
CREATE TRIGGER artifact_promotions_no_update BEFORE UPDATE ON artifact_promotions
BEGIN SELECT RAISE(ABORT,'Promotion history is immutable'); END;
CREATE TRIGGER artifact_promotions_no_delete BEFORE DELETE ON artifact_promotions
BEGIN SELECT RAISE(ABORT,'Promotion history is append-only'); END;
