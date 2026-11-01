import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../src/db/client.js';
let dir: string;
let db: Database.Database;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'adw-db-')); db = openDb(join(dir, 'adw.sqlite')); });
afterEach(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });
it('creates all tables with WAL and enabled foreign keys', () => {
 migrate(db);
 const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => (row as { name: string }).name);
 expect(tables).toEqual(expect.arrayContaining(['projects','tasks','context_artifacts','findings','agent_sessions','check_results','audit_events','schema_migrations','verification_runs']));
 expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
 expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
});
it('is idempotent and preserves data after reopening', () => {
 migrate(db);
 db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_1','/repo','main','2026-10-31T00:00:00Z');
 migrate(db);
 db.close(); db = openDb(join(dir, 'adw.sqlite')); migrate(db);
 expect(db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 });
 expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 6 });
});
it('rolls back initial DDL and version record on migration failure', () => {
 db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
 expect(() => migrate(db)).toThrow();
 expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('projects','schema_migrations')").all()).toEqual([]);
});
it('rejects foreign-key violations and invalid persisted JSON', () => {
 migrate(db);
 expect(() => db.prepare('INSERT INTO findings VALUES (?,?,?,?,?,?,?)').run('f','missing','claim','[]','[]','unverified','now')).toThrow();
 expect(() => db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run('evt','now','user','test','invalid json')).toThrow();
});
it('refuses a database from a newer application', () => {
 migrate(db);
 db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(99,'now');
 expect(() => migrate(db)).toThrow('newer');
});

it('upgrades a version 1 database without losing projects, tasks or historical check results', () => {
 db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
 db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
 db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(1,'then');
 db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_1','/repo','main','then');
 db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_1','proj_1','intent','["pass"]','[]','main','a'.repeat(40),'locked','then','then');
 db.prepare('INSERT INTO check_results (id,task_id,name,command,exit_code,duration_ms,env_fingerprint,artifacts_json,not_verified,blocking,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('check_1','task_1','unit','pnpm test',0,1,'env','[]',0,1,'then');
 migrate(db);migrate(db);
 expect(db.prepare('SELECT id,verification_run_id FROM check_results').get()).toEqual({id:'check_1',verification_run_id:null});
 expect(db.prepare('SELECT id,status FROM tasks').get()).toEqual({id:'task_1',status:'locked'});
 expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{version:1},{version:2},{version:3},{version:4},{version:5},{version:6}]);
 db.prepare("INSERT INTO verification_runs (id,task_id,status,started_at) VALUES ('run_1','task_1','running','now')").run();
 expect(()=>db.prepare("INSERT INTO verification_runs (id,task_id,status,started_at) VALUES ('run_2','task_1','running','now')").run()).toThrow();
});
it('rolls back the version 2 migration on failure and leaves version 1 data intact', () => {
 db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
 db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
 db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(1,'then');
 db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_1','/repo','main','then');
 db.exec('CREATE TABLE verification_runs (existing TEXT)');
 expect(()=>migrate(db)).toThrow();
 expect(db.prepare('SELECT id FROM projects').get()).toEqual({id:'proj_1'});
 expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{version:1}]);
 expect((db.prepare('PRAGMA table_info(check_results)').all() as {name:string}[]).some(c=>c.name==='verification_run_id')).toBe(false);
});
it('upgrades v2 artifact/finding history to v3 without rewriting their content',()=>{
 db.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../src/db/002-verification-runs.sql',import.meta.url),'utf8'));db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');db.exec("INSERT INTO schema_migrations VALUES (1,'then'),(2,'then')");
 db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_1','/repo','main','then');db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_1','proj_1','intent','["pass"]','[]','main','a'.repeat(40),'locked','then','then');
 db.prepare('INSERT INTO context_artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('art_1','proj_1','task_1','decision','sha256:historical',null,'a'.repeat(40),'[]','{}','codex','inferred','then',null,null,'task',4);
 db.prepare('INSERT INTO findings VALUES (?,?,?,?,?,?,?)').run('legacy','task_1','Historical','[]','[]','inferred','then');migrate(db);migrate(db);
 expect(db.prepare('SELECT content_ref,evidence_refs_json,session_id FROM context_artifacts').get()).toEqual({content_ref:'sha256:historical',evidence_refs_json:'[]',session_id:null});expect(db.prepare('SELECT claim FROM findings').get()).toEqual({claim:'Historical'});
 expect(()=>db.prepare("UPDATE context_artifacts SET content_ref='changed'").run()).toThrow('immutable');expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{version:1},{version:2},{version:3},{version:4},{version:5},{version:6}]);
});
it('upgrades v3 to v4 without changing legacy tasks and rolls back a conflicting v4 migration',()=>{
 for(const file of ['schema.sql','002-verification-runs.sql','003-context-broker.sql'])db.exec(readFileSync(new URL('../src/db/'+file,import.meta.url),'utf8'));
 db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1,'then'),(2,'then'),(3,'then')");
 db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_1','/repo','main','then');db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_1','proj_1','legacy intent','["pass"]','[]','main','a'.repeat(40),'locked','then','then');
 db.exec('CREATE TABLE supervisor_runs (conflict TEXT)');expect(()=>migrate(db)).toThrow();expect(db.prepare("SELECT name FROM sqlite_master WHERE name='supervisor_specs'").get()).toBeUndefined();expect(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({version:3});
 db.exec('DROP TABLE supervisor_runs');migrate(db);expect(db.prepare('SELECT intent,status FROM tasks').get()).toEqual({intent:'legacy intent',status:'locked'});expect(db.prepare('SELECT count(*) AS n FROM supervisor_specs').get()).toEqual({n:0});
});
it('upgrades v4 sessions to v5 preserving history and rolls back all review DDL on conflict',()=>{
 for(const file of ['schema.sql','002-verification-runs.sql','003-context-broker.sql','004-supervisor.sql'])db.exec(readFileSync(new URL('../src/db/'+file,import.meta.url),'utf8'));
 db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1,'then'),(2,'then'),(3,'then'),(4,'then')");
 db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_1','/repo','main','then');db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_1','proj_1','legacy intent','["pass"]','[]','main','a'.repeat(40),'locked','then','then');db.prepare('INSERT INTO agent_sessions VALUES (?,?,?,?,?,?,?)').run('session-old','task_1','codex','/old-worktree','completed','then','then');
 db.exec('CREATE TABLE review_runs (conflict TEXT)');expect(()=>migrate(db)).toThrow();expect((db.prepare('PRAGMA table_info(agent_sessions)').all() as {name:string}[]).some(column=>column.name==='role')).toBe(false);expect(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({version:4});
 db.exec('DROP TABLE review_runs');migrate(db);migrate(db);expect(db.prepare('SELECT id,role,runtime_session_id,supervisor_run_id FROM agent_sessions').get()).toEqual({id:'session-old',role:'executor',runtime_session_id:null,supervisor_run_id:null});expect(db.prepare('SELECT count(*) AS n FROM review_runs').get()).toEqual({n:0});
});

it('upgrades v5 to v6 preserving tasks and rolls back desktop policy DDL on conflict',()=>{
 for(const file of ['schema.sql','002-verification-runs.sql','003-context-broker.sql','004-supervisor.sql','005-review.sql'])db.exec(readFileSync(new URL('../src/db/'+file,import.meta.url),'utf8'));
 db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1,'then'),(2,'then'),(3,'then'),(4,'then'),(5,'then')");
 db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_1','/repo','main','then');db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task_1','proj_1','legacy intent','["pass"]','[]','main','a'.repeat(40),'locked','then','then');
 db.exec('CREATE TABLE desktop_task_policies (conflict TEXT)');expect(()=>migrate(db)).toThrow();expect(db.prepare("SELECT name FROM sqlite_master WHERE name='desktop_project_settings'").get()).toBeUndefined();expect(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({version:5});
 db.exec('DROP TABLE desktop_task_policies');migrate(db);migrate(db);expect(db.prepare('SELECT intent,status FROM tasks').get()).toEqual({intent:'legacy intent',status:'locked'});expect(db.prepare('SELECT count(*) AS n FROM desktop_task_policies').get()).toEqual({n:0});expect(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({version:6});
});
