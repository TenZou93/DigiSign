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
      role TEXT NOT NULL DEFAULT 'user',
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
  // Migrasi kolom letter_templates — pakai exec + catch error sql.js
  const ltColumns = ['body_pembuka', 'body_data_label', 'body_isi', 'body_penutup', 'judul_surat'];
  for (const col of ltColumns) {
    try { getWrapper().exec("ALTER TABLE letter_templates ADD COLUMN " + col + " TEXT"); } catch (e) {}
  }
  try { getWrapper().exec("ALTER TABLE letter_templates ADD COLUMN docx_template_path TEXT"); } catch (e) {}
  try { getWrapper().exec("ALTER TABLE generated_letters ADD COLUMN nomor_surat TEXT"); } catch (e) {}
  // Isi NULL dengan default untuk template existing (one-time migration)
  try {
    const defaults = {
      body_pembuka: 'Yang bertanda tangan di bawah ini:\n\n{{pejabat_nama}}\n{{pejabat_jabatan}}\n\nMenerangkan bahwa:\n',
      body_data_label: 'Nama : {{nama}}\nNIM : {{nim}}\nProgram Studi : {{prodi}}\nSemester : {{semester}}',
      body_isi: 'Adalah benar mahasiswa aktif pada Program Studi {{prodi}} {{institusi}}.\n\nSurat ini dibuat untuk keperluan {{keperluan}}.',
      body_penutup: 'Demikian surat keterangan ini dibuat dengan sebenarnya untuk digunakan sebagaimana mestinya.',
      judul_surat: 'SURAT KETERANGAN'
    };
    for (const [col, val] of Object.entries(defaults)) {
      try { getWrapper().run("UPDATE letter_templates SET " + col + " = ? WHERE " + col + " IS NULL", [val]); } catch (e) {}
    }
  } catch (e) {}
  try { getWrapper().exec(`
    CREATE TABLE IF NOT EXISTS letter_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      description TEXT,
      form_fields TEXT NOT NULL,
      styles TEXT,
      default_margins TEXT,
      logo_path TEXT,
      kop_kiri TEXT,
      kop_kanan TEXT,
      pejabat_nama TEXT,
      pejabat_jabatan TEXT,
      pejabat_nip TEXT,
      judul_surat TEXT,
      body_pembuka TEXT,
      body_data_label TEXT,
      body_isi TEXT,
      body_penutup TEXT,
      docx_template_path TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `); } catch (e) {}
  try { getWrapper().exec(`
    CREATE TABLE IF NOT EXISTS generated_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      tracking_code TEXT NOT NULL,
      guest_name TEXT,
      guest_email TEXT,
      guest_phone TEXT,
      field_data TEXT NOT NULL,
      filename TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      signer_id INTEGER,
      signature_id INTEGER,
      signed_file TEXT,
      admin_note TEXT,
      nomor_surat TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (template_id) REFERENCES letter_templates(id),
      FOREIGN KEY (signer_id) REFERENCES signers(id),
      FOREIGN KEY (signature_id) REFERENCES signatures(id)
    );
  `); } catch (e) {}
  // Seed default template if none exist
  try {
    const count = getWrapper().prepare('SELECT COUNT(*) as c FROM letter_templates').get().c;
    if (count === 0) {
      const defaultTemplate = {
        name: 'Surat Keterangan Kuliah',
        code: 'suket-kuliah',
        description: 'Surat keterangan aktif kuliah untuk mahasiswa',
        form_fields: JSON.stringify([
          { name: 'nama', label: 'Nama Lengkap', type: 'text', required: true },
          { name: 'nim', label: 'NIM', type: 'text', required: true },
          { name: 'prodi', label: 'Program Studi', type: 'text', required: true },
          { name: 'semester', label: 'Semester', type: 'text', required: true },
          { name: 'keperluan', label: 'Keperluan', type: 'textarea', required: true }
        ]),
        styles: JSON.stringify({
          bodyFontSize: 11,
          kopFontSize: 9,
          titleFontSize: 14,
          signatureFontSize: 11
        }),
        default_margins: JSON.stringify([60, 40, 60, 40]),
        kop_kiri: 'Institut Ilmu Kesehatan Nahdlatul Ulama Tuban',
        kop_kanan: 'KEMENTERIAN PENDIDIKAN, KEBUDAYAAN, RISET, DAN TEKNOLOGI\nINSTITUT ILMU KESEHATAN NAHDLATUL ULAMA TUBAN\nJl. Cendrawasih No. 31 Tuban - Jawa Timur\nTelp. (0356) 321456, Website: www.iiknujatim.ac.id',
        pejabat_nama: 'Nama Pejabat',
        pejabat_jabatan: 'Wakil Rektor III',
        pejabat_nip: 'NIP. ..........................',
        judul_surat: 'SURAT KETERANGAN',
        body_pembuka: 'Yang bertanda tangan di bawah ini:\n\n{{pejabat_nama}}\n{{pejabat_jabatan}}\n\nMenerangkan bahwa:\n',
        body_data_label: 'Nama : {{nama}}\nNIM : {{nim}}\nProgram Studi : {{prodi}}\nSemester : {{semester}}',
        body_isi: 'Adalah benar mahasiswa aktif pada Program Studi {{prodi}} {{institusi}}.\n\nSurat ini dibuat untuk keperluan {{keperluan}}.',
        body_penutup: 'Demikian surat keterangan ini dibuat dengan sebenarnya untuk digunakan sebagaimana mestinya.'
      };
      getWrapper().run(
        'INSERT INTO letter_templates (name, code, description, form_fields, styles, default_margins, kop_kiri, kop_kanan, pejabat_nama, pejabat_jabatan, pejabat_nip, judul_surat, body_pembuka, body_data_label, body_isi, body_penutup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [defaultTemplate.name, defaultTemplate.code, defaultTemplate.description, defaultTemplate.form_fields, defaultTemplate.styles, defaultTemplate.default_margins, defaultTemplate.kop_kiri, defaultTemplate.kop_kanan, defaultTemplate.pejabat_nama, defaultTemplate.pejabat_jabatan, defaultTemplate.pejabat_nip, defaultTemplate.judul_surat, defaultTemplate.body_pembuka, defaultTemplate.body_data_label, defaultTemplate.body_isi, defaultTemplate.body_penutup]
      );
    }
  } catch (e) { console.error('Seed template error:', e.message); }
  return getWrapper();
}

function getDB() {
  if (!wrapper) throw new Error('Database not initialized');
  return wrapper;
}

module.exports = { initDB, getDB };
