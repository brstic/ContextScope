import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenedDb {
  sqlite: Database.Database;
  db: Db;
  close(): void;
}

/** apps/server/migrations, valid from both src/ (tests) and dist/ (built). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * Open (or create) the database, enable WAL + foreign keys, and apply pending
 * migrations. Each migration runs in its own transaction and is recorded in
 * schema_migrations, so a failed migration leaves the DB at the previous version.
 */
export const openDatabase = (path: string, migrationsDir = MIGRATIONS_DIR): OpenedDb => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite, migrationsDir);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db, close: () => sqlite.close() };
};

export const migrate = (sqlite: Database.Database, migrationsDir = MIGRATIONS_DIR): number[] => {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = new Set(
    (sqlite.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const done: number[] = [];
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (applied.has(version)) continue;
    const sqlText = readFileSync(join(migrationsDir, file), 'utf8');
    sqlite.transaction(() => {
      sqlite.exec(sqlText);
      sqlite.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, file);
    })();
    done.push(version);
  }
  return done;
};
