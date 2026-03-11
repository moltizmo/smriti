import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export const EMBEDDING_DIM = 384; // all-MiniLM-L6-v2

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS thoughts (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      text TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'general',
      source TEXT,
      people TEXT NOT NULL DEFAULT '[]',
      topics TEXT NOT NULL DEFAULT '[]',
      actions TEXT NOT NULL DEFAULT '[]',
      sentiment TEXT NOT NULL DEFAULT 'neutral',
      tier TEXT NOT NULL DEFAULT 'working',
      consolidated_from TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_thoughts_type ON thoughts(type);
    CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts(created_at);
  `);

  // v0.2 migration: add tier + consolidated_from columns if they don't exist
  const cols = (db.prepare("PRAGMA table_info(thoughts)").all() as { name: string }[]).map(c => c.name);
  if (!cols.includes("tier")) {
    db.exec("ALTER TABLE thoughts ADD COLUMN tier TEXT NOT NULL DEFAULT 'working'");
  }
  if (!cols.includes("consolidated_from")) {
    db.exec("ALTER TABLE thoughts ADD COLUMN consolidated_from TEXT NOT NULL DEFAULT '[]'");
  }

  // Create tier index after migration (column guaranteed to exist)
  db.exec("CREATE INDEX IF NOT EXISTS idx_thoughts_tier ON thoughts(tier)");

  // Create virtual table for vector search if it doesn't exist
  const vtableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='thought_vectors'"
    )
    .get();

  if (!vtableExists) {
    db.exec(`
      CREATE VIRTUAL TABLE thought_vectors USING vec0(
        embedding float[${EMBEDDING_DIM}]
      );
    `);
  }

  return db;
}
