import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
const migrations = [
 { version: 1, file: './schema.sql' },
 { version: 2, file: './002-verification-runs.sql' },
 { version: 3, file: './003-context-broker.sql' },
 { version: 4, file: './004-supervisor.sql' },
 { version: 5, file: './005-review.sql' },
 { version: 6, file: './006-desktop.sql' },
];
const currentVersion = 6;
export function migrate(db: Database.Database): void {
 db.transaction(() => {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const latest = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
  if ((latest.version ?? 0) > currentVersion) throw new Error('Database schema is newer than this application');
  for (const migration of migrations) {
   if ((latest.version ?? 0) >= migration.version) continue;
   db.exec(readFileSync(new URL(migration.file, import.meta.url), 'utf8'));
   db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
  }
 }).immediate();
}
