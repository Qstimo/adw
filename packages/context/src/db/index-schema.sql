CREATE TABLE context_index_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
INSERT INTO context_index_meta VALUES (1,1);
CREATE TABLE index_projects (project_id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, latest_snapshot_id TEXT);
CREATE TABLE index_snapshots (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES index_projects(project_id),
 base_commit TEXT NOT NULL CHECK(length(base_commit)=40), parser_version TEXT NOT NULL,
 limits_json TEXT NOT NULL CHECK(json_valid(limits_json)), warnings_json TEXT NOT NULL CHECK(json_valid(warnings_json)),
 stats_json TEXT NOT NULL CHECK(json_valid(stats_json)), created_at TEXT NOT NULL
);
CREATE INDEX index_snapshots_project ON index_snapshots(project_id,base_commit);
CREATE TABLE indexed_contents (content_hash TEXT PRIMARY KEY, size INTEGER NOT NULL, content TEXT NOT NULL);
CREATE VIRTUAL TABLE indexed_files_fts USING fts5(content_hash UNINDEXED, content, tokenize='unicode61');
CREATE TABLE indexed_files (
 snapshot_id TEXT NOT NULL REFERENCES index_snapshots(id), path TEXT NOT NULL,
 content_hash TEXT NOT NULL REFERENCES indexed_contents(content_hash), size INTEGER NOT NULL,
 language TEXT NOT NULL, symbol_status TEXT NOT NULL, updated_at TEXT NOT NULL,
 warnings_json TEXT NOT NULL CHECK(json_valid(warnings_json)), PRIMARY KEY(snapshot_id,path)
);
CREATE INDEX indexed_files_hash ON indexed_files(content_hash);
CREATE TABLE indexed_symbols (
 snapshot_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
 start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
 FOREIGN KEY(snapshot_id,path) REFERENCES indexed_files(snapshot_id,path)
);
CREATE INDEX indexed_symbols_snapshot ON indexed_symbols(snapshot_id,path);
CREATE TABLE indexed_imports (
 snapshot_id TEXT NOT NULL, path TEXT NOT NULL, specifier TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL,
 FOREIGN KEY(snapshot_id,path) REFERENCES indexed_files(snapshot_id,path)
);
CREATE INDEX indexed_imports_snapshot ON indexed_imports(snapshot_id,path);
CREATE TABLE project_manifests (
 snapshot_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL CHECK(json_valid(json)),
 FOREIGN KEY(snapshot_id,path) REFERENCES indexed_files(snapshot_id,path)
);
