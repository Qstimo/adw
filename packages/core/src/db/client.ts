import Database from 'better-sqlite3';
export { migrate } from './migrate.js';
export function openDb(filePath: string): Database.Database {
 const db = new Database(filePath);
 try {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
 } catch (error) { db.close(); throw error; }
}
