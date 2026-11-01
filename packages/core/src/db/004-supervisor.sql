CREATE TABLE supervisor_specs (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
 spec_hash TEXT NOT NULL, approved_by TEXT NOT NULL, locked_at TEXT NOT NULL
);
CREATE TABLE supervisor_runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL,
 state_json TEXT NOT NULL CHECK(json_valid(state_json)), active INTEGER NOT NULL CHECK(active IN (0,1)),
 started_at TEXT NOT NULL, ended_at TEXT
);
CREATE UNIQUE INDEX supervisor_active_task ON supervisor_runs(task_id) WHERE active=1;
CREATE TRIGGER supervisor_spec_no_update BEFORE UPDATE ON supervisor_specs
BEGIN SELECT RAISE(ABORT,'Approved spec is immutable'); END;
CREATE TRIGGER supervisor_spec_no_delete BEFORE DELETE ON supervisor_specs
BEGIN SELECT RAISE(ABORT,'Approved spec history is immutable'); END;
CREATE TRIGGER locked_task_spec_immutable BEFORE UPDATE ON tasks
WHEN EXISTS(SELECT 1 FROM supervisor_specs WHERE task_id=OLD.id) AND (
 NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.intent IS NOT OLD.intent
 OR NEW.acceptance_json IS NOT OLD.acceptance_json OR NEW.out_of_scope_json IS NOT OLD.out_of_scope_json
 OR NEW.base_branch IS NOT OLD.base_branch OR NEW.base_commit IS NOT OLD.base_commit)
BEGIN SELECT RAISE(ABORT,'Approved task spec is immutable'); END;
CREATE TRIGGER locked_task_no_delete BEFORE DELETE ON tasks
WHEN EXISTS(SELECT 1 FROM supervisor_specs WHERE task_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Approved task history is immutable'); END;
