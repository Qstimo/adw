CREATE TABLE desktop_project_settings(project_id TEXT PRIMARY KEY REFERENCES projects(id),privacy_mode TEXT NOT NULL CHECK(privacy_mode IN ('local-only','cli-subscription','api-provider')));
CREATE TABLE desktop_task_policies(task_id TEXT PRIMARY KEY REFERENCES tasks(id),policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),policy_hash TEXT NOT NULL,approved_at TEXT);
CREATE TRIGGER desktop_policy_locked BEFORE UPDATE ON desktop_task_policies
WHEN EXISTS(SELECT 1 FROM supervisor_specs WHERE task_id=OLD.task_id) AND (NEW.task_id IS NOT OLD.task_id OR NEW.policy_json IS NOT OLD.policy_json OR NEW.policy_hash IS NOT OLD.policy_hash OR (OLD.approved_at IS NOT NULL AND NEW.approved_at IS NOT OLD.approved_at))
BEGIN SELECT RAISE(ABORT,'Approved execution policy is immutable'); END;
CREATE TRIGGER desktop_policy_no_delete BEFORE DELETE ON desktop_task_policies
WHEN EXISTS(SELECT 1 FROM supervisor_specs WHERE task_id=OLD.task_id)
BEGIN SELECT RAISE(ABORT,'Approved execution policy history is immutable'); END;
CREATE TABLE desktop_rejections(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),status TEXT NOT NULL CHECK(status IN ('running','finished','failed')),previous_status TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,ended_at TEXT);
CREATE UNIQUE INDEX desktop_rejection_active_task ON desktop_rejections(task_id) WHERE status='running';
