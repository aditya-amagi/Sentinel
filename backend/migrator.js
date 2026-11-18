'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function initMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function getAppliedMigrations(db) {
  return new Set(
    db.prepare('SELECT name FROM _schema_migrations ORDER BY id ASC')
      .all()
      .map(r => r.name)
  );
}

function applyMigrations(db) {
  initMigrationTable(db);
  const applied = getAppliedMigrations(db);

  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const newlyApplied = [];

  const insertStmt = db.prepare('INSERT INTO _schema_migrations (name) VALUES (?)');

  for (const file of files) {
    if (!applied.has(file)) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        insertStmt.run(file);
      })();
      newlyApplied.push(file);
    }
  }

  return newlyApplied;
}

if (require.main === module) {
  const Database = require('better-sqlite3');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'atom_dashboard.db');
  console.log(`[migrator] Running migrations against: ${DB_PATH}`);
  const db = new Database(DB_PATH);
  const results = applyMigrations(db);
  if (results.length) {
    console.log(`[migrator] Successfully applied ${results.length} migration(s):`, results);
  } else {
    console.log('[migrator] Schema up to date. No pending migrations.');
  }
  db.close();
}

module.exports = {
  applyMigrations,
  getAppliedMigrations,
};
