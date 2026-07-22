const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.db');
let rawDb = null;

function save() {
  if (rawDb) {
    fs.writeFileSync(DB_PATH, Buffer.from(rawDb.export()));
  }
}

class StmtWrapper {
  constructor(raw, sql) {
    this.raw = raw;
    this.sql = sql;
  }
  get(...params) {
    const stmt = this.raw.prepare(this.sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return undefined;
  }
  all(...params) {
    const stmt = this.raw.prepare(this.sql);
    if (params.length > 0) stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }
  run(...params) {
    const stmt = this.raw.prepare(this.sql);
    if (params.length > 0) stmt.bind(params);
    stmt.step();
    stmt.free();
    save();
    return this;
  }
}

let wrapper = null;

function getWrapper() {
  if (wrapper) return wrapper;
  wrapper = {
    prepare(sql) { return new StmtWrapper(rawDb, sql); },
    run(sql, params) {
      if (params) rawDb.run(sql, params);
      else rawDb.run(sql);
      save();
    },
    exec(sql) { rawDb.exec(sql); save(); }
  };
  return wrapper;
}

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    rawDb = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    rawDb = new SQL.Database();
  }
  getWrapper().exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS signers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      display_name TEXT NOT NULL,
      organization TEXT,
      email TEXT,
      phone TEXT,
      public_key TEXT,
      private_key_encrypted TEXT,
      algorithm TEXT DEFAULT 'RSA-2048',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS key_pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT 'default',
      public_key TEXT NOT NULL,
      private_key_encrypted TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'RSA-2048',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS signatures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      document_name TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      signature TEXT NOT NULL,
      qr_code TEXT,
      signed_file TEXT,
      signed_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (key_id) REFERENCES key_pairs(id)
    );
  `);
  // Migrasi untuk tabel yang sudah ada sebelumnya
  try { getWrapper().run('ALTER TABLE signatures ADD COLUMN qr_code TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE signatures ADD COLUMN signed_file TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE signatures ADD COLUMN token TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE signatures ADD COLUMN signed_file_hash TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE users ADD COLUMN email TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE users ADD COLUMN phone TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE users ADD COLUMN organization TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE users ADD COLUMN role TEXT DEFAULT \'admin\''); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE signatures ADD COLUMN signer_id INTEGER'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().exec('CREATE TABLE IF NOT EXISTS _migration_check (id INTEGER)'); } catch (e) {}
  try { getWrapper().exec(`
    CREATE TABLE IF NOT EXISTS guest_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_name TEXT,
      guest_email TEXT,
      filename TEXT NOT NULL,
      originalname TEXT NOT NULL,
      signer_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      signature_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (signer_id) REFERENCES signers(id),
      FOREIGN KEY (signature_id) REFERENCES signatures(id)
    );
  `); } catch (e) {}
  try { getWrapper().exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT UNIQUE NOT NULL,
      setting_value TEXT
    );
  `); } catch (e) {}
  try { getWrapper().run('INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)', ['site_name', 'DigiSign']); } catch (e) {}
  try { getWrapper().run('INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)', ['primary_color', '#3b82f6']); } catch (e) {}
  try { getWrapper().run('INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)', ['logo_text', 'DigiSign']); } catch (e) {}
  try { getWrapper().run('ALTER TABLE guest_docs ADD COLUMN admin_note TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE guest_docs ADD COLUMN tracking_code TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE guest_docs ADD COLUMN document_name TEXT'); } catch (e) { /* kolom sudah ada */ }
  try { getWrapper().run('ALTER TABLE guest_docs ADD COLUMN signed_file TEXT'); } catch (e) { /* kolom sudah ada */ }
  return getWrapper();
}

function getDB() {
  if (!wrapper) throw new Error('Database not initialized');
  return wrapper;
}

module.exports = { initDB, getDB };
