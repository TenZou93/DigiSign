const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const { getDB } = require('../database');
const { generateLetterPDF } = require('../letter-generator');
const { generateDocxPDF } = require('../docx-generator');

const logoUpload = multer({ dest: path.join(__dirname, '..', '..', 'uploads', 'logos') });
const logoDir = path.join(__dirname, '..', '..', 'uploads', 'logos');
if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });

const docxUpload = multer({ dest: path.join(__dirname, '..', '..', 'uploads', 'docx_templates') });
const docxDir = path.join(__dirname, '..', '..', 'uploads', 'docx_templates');
if (!fs.existsSync(docxDir)) fs.mkdirSync(docxDir, { recursive: true });

const lettersDir = path.join(__dirname, '..', '..', 'uploads', 'letters');
if (!fs.existsSync(lettersDir)) fs.mkdirSync(lettersDir, { recursive: true });

function generateTracking() {
  return 'LT' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Guest: list available templates
router.get('/templates', (req, res) => {
  const db = getDB();
  const templates = db.prepare('SELECT id, name, code, description, form_fields FROM letter_templates ORDER BY name').all();
  res.render('letter_templates', { templates, user: req.session.user, message: req.query.message, error: req.query.error });
});

// Guest: fill form for a template
router.get('/templates/:code', (req, res) => {
  const db = getDB();
  const template = db.prepare('SELECT * FROM letter_templates WHERE code = ?').get(req.params.code);
  if (!template) return res.redirect('/surat/templates?error=Tidak ditemukan');
  let formFields = [];
  try { formFields = JSON.parse(template.form_fields); } catch (e) {}
  res.render('letter_form', { template, formFields, user: req.session.user, message: req.query.message, error: req.query.error });
});

// Guest: generate letter
router.post('/templates/:code/generate', async (req, res) => {
  try {
    const db = getDB();
    const template = db.prepare('SELECT * FROM letter_templates WHERE code = ?').get(req.params.code);
    if (!template) return res.redirect('/surat/templates?error=Tidak ditemukan');

    let formFields = [];
    try { formFields = JSON.parse(template.form_fields); } catch (e) {}

    const fieldData = {};
    for (const f of formFields) {
      fieldData[f.name] = (req.body[f.name] || '').trim();
    }

    const missing = formFields.filter(f => f.required && !fieldData[f.name]);
    if (missing.length > 0) {
      return res.redirect(`/surat/templates/${req.params.code}?error=Harap isi: ${missing.map(m => m.label).join(', ')}`);
    }

    const guestName = (req.body.guest_name || '').trim() || fieldData.nama || 'Anonim';
    const guestEmail = (req.body.guest_email || '').trim() || '';
    const guestPhone = (req.body.guest_phone || '').trim() || '';

    let pdfBuffer;
    if (template.docx_template_path) {
      const tmplPath = path.join(__dirname, '..', '..', template.docx_template_path);
      if (!fs.existsSync(tmplPath)) throw new Error('File template .docx tidak ditemukan');
      pdfBuffer = await generateDocxPDF(tmplPath, fieldData, {
        tanggal: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' }),
        nomor_surat: fieldData.nomor_surat || 'IIK/UN.01/SK/' + Date.now(),
        pejabat_nama: template.pejabat_nama || '',
        pejabat_jabatan: template.pejabat_jabatan || ''
      });
    } else {
      pdfBuffer = await generateLetterPDF(template, fieldData);
    }

    const tracking = generateTracking();
    const filename = `letter_${tracking}_${Date.now()}.pdf`;
    const filePath = path.join(lettersDir, filename);
    fs.writeFileSync(filePath, pdfBuffer);

    db.prepare(
      `INSERT INTO generated_letters (template_id, tracking_code, guest_name, guest_email, guest_phone, field_data, filename) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(template.id, tracking, guestName, guestEmail, guestPhone, JSON.stringify(fieldData), filename);

    res.redirect(`/surat/success?tracking=${tracking}`);
  } catch (e) {
    console.error('Generate letter error:', e);
    res.redirect(`/surat/templates/${req.params.code}?error=Gagal: ${e.message}`);
  }
});

// Guest: success page
router.get('/success', (req, res) => {
  res.render('letter_success', { tracking: req.query.tracking, user: req.session.user });
});

// Guest: track letter
router.get('/tracking/:code', (req, res) => {
  const db = getDB();
  let doc;
  if (!isNaN(parseInt(req.params.code))) {
    doc = db.prepare(`
      SELECT l.*, t.name as template_name, t.code as template_code
      FROM generated_letters l JOIN letter_templates t ON l.template_id = t.id
      WHERE l.id = ?
    `).get(parseInt(req.params.code));
  } else {
    doc = db.prepare(`
      SELECT l.*, t.name as template_name, t.code as template_code
      FROM generated_letters l JOIN letter_templates t ON l.template_id = t.id
      WHERE l.tracking_code = ?
    `).get(req.params.code);
  }
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const fieldData = JSON.parse(doc.field_data || '{}');
  const downloadUrl = doc.status === 'signed' && doc.signed_file ? `/surat/download/${doc.id}` : null;
  res.json({
    id: doc.id, tracking_code: doc.tracking_code, template_name: doc.template_name,
    guest_name: doc.guest_name, field_data: fieldData,
    status: doc.status, admin_note: doc.admin_note, created_at: doc.created_at, download_url: downloadUrl
  });
});

// Download signed letter
router.get('/download/:id', (req, res) => {
  const db = getDB();
  const doc = db.prepare('SELECT * FROM generated_letters WHERE id = ?').get(req.params.id);
  if (!doc || !doc.signed_file) return res.status(404).send('File tidak ditemukan');
  const signedDir = path.join(__dirname, '..', '..', 'uploads', 'signed');
  const filePath = path.join(signedDir, doc.signed_file);
  if (!fs.existsSync(filePath)) return res.status(404).send('File tidak ditemukan');
  const downloadName = `surat_${doc.tracking_code}_signed.pdf`;
  res.download(filePath, downloadName);
});

// Admin: list generated letters
router.get('/admin/list', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;
  const totalRow = db.prepare('SELECT COUNT(*) as count FROM generated_letters').get();
  const total = totalRow ? totalRow.count : 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const letters = db.prepare(`
    SELECT l.*, t.name as template_name, sn.display_name as signer_name
    FROM generated_letters l
    JOIN letter_templates t ON l.template_id = t.id
    LEFT JOIN signers sn ON l.signer_id = sn.id
    ORDER BY l.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const allSigners = db.prepare('SELECT id, display_name, label FROM signers ORDER BY display_name').all();
  res.render('admin_letters', { letters, page, total, totalPages, allSigners, user: req.session.user, message: req.query.message, error: req.query.error });
});

// Signer/Admin: view letters assigned to me
router.get('/my', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  const db = getDB();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  const signers = db.prepare('SELECT id FROM signers WHERE user_id = ?').all(req.session.user.id);
  let letters = [], total = 0, totalPages = 1;
  if (signers.length > 0) {
    const ids = signers.map(s => s.id).join(',');
    const totalRow = db.prepare(`SELECT COUNT(*) as count FROM generated_letters WHERE signer_id IN (${ids})`).get();
    total = totalRow ? totalRow.count : 0;
    totalPages = Math.max(1, Math.ceil(total / limit));
    letters = db.prepare(`
      SELECT l.*, t.name as template_name
      FROM generated_letters l
      JOIN letter_templates t ON l.template_id = t.id
      WHERE l.signer_id IN (${ids})
      ORDER BY l.created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }
  const isAdmin = req.session.user.role === 'admin';
  res.render('my_letters', { letters, page, total, totalPages, isAdmin, user: req.session.user, message: req.query.message, error: req.query.error });
});

// Admin: approve letter (dengan signer_id + nomor_surat dari form)
router.post('/admin/:id/approve', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  const doc = db.prepare('SELECT * FROM generated_letters WHERE id = ?').get(req.params.id);
  if (!doc) return res.redirect('/surat/admin/list?error=Tidak ditemukan');
  const signerId = req.body.signer_id || doc.signer_id || null;
  const nomorSurat = (req.body.nomor_surat || '').trim();
  db.prepare("UPDATE generated_letters SET status = 'approved', signer_id = ?, nomor_surat = ? WHERE id = ?").run(signerId, nomorSurat || null, req.params.id);

  // Re-generate PDF untuk .docx template dengan nomor_surat dari admin
  if (nomorSurat) {
    try {
      const template = db.prepare('SELECT * FROM letter_templates WHERE id = ?').get(doc.template_id);
      if (template && template.docx_template_path) {
        const fieldData = JSON.parse(doc.field_data || '{}');
        const tmplPath = path.join(__dirname, '..', '..', template.docx_template_path);
        if (fs.existsSync(tmplPath)) {
          const pdfBuffer = await generateDocxPDF(tmplPath, fieldData, {
            tanggal: new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' }),
            nomor_surat: nomorSurat,
            pejabat_nama: template.pejabat_nama || '',
            pejabat_jabatan: template.pejabat_jabatan || ''
          });
          const filename = `letter_${doc.tracking_code}_${Date.now()}.pdf`;
          const filePath = path.join(lettersDir, filename);
          fs.writeFileSync(filePath, pdfBuffer);
          db.prepare('UPDATE generated_letters SET filename = ? WHERE id = ?').run(filename, req.params.id);
        }
      }
    } catch (e) {
      console.error('Gagal re-generate PDF:', e.message);
    }
  }

  const dest = req.body._redirect || '/surat/admin/list';
  res.redirect(dest + '?message=Disetujui');
});

// Admin: reject letter
router.post('/admin/:id/reject', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  const doc = db.prepare('SELECT * FROM generated_letters WHERE id = ?').get(req.params.id);
  if (!doc) return res.redirect('/surat/admin/list?error=Tidak ditemukan');
  db.prepare("UPDATE generated_letters SET status = 'rejected', admin_note = ? WHERE id = ?").run(req.body.admin_note || null, req.params.id);
  const dest = req.body._redirect || '/surat/admin/list';
  res.redirect(dest + '?message=Ditolak');
});

// Admin/Signer: assign signer
router.post('/admin/:id/assign-signer', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  db.prepare('UPDATE generated_letters SET signer_id = ? WHERE id = ?').run(req.body.signer_id || null, req.params.id);
  res.redirect('/surat/admin/list?message=Signer ditetapkan');
});

// Signer: get letter signed (copy file and redirect to /sign)
router.get('/sign/:id', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  const db = getDB();
  const doc = db.prepare('SELECT * FROM generated_letters WHERE id = ?').get(req.params.id);
  const redirErr = req.query._redirect || '/surat/my';
  if (!doc || doc.status !== 'approved') return res.redirect(redirErr + '?error=Tidak valid');

  const signers = db.prepare('SELECT id FROM signers WHERE user_id = ?').all(req.session.user.id);
  const isAdmin = req.session.user.role === 'admin';
  if (!isAdmin && signers.length > 0 && !signers.some(s => s.id === doc.signer_id)) {
    return res.redirect(redirErr + '?error=Bukan untuk Anda');
  }

  const origPath = path.join(lettersDir, doc.filename);
  if (!fs.existsSync(origPath)) return res.redirect(redirErr + '?error=File tidak ditemukan');

  const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
  const ext = path.extname(doc.filename) || '.pdf';
  const newFilename = `letter_sign_${doc.id}_${Date.now()}${ext}`;
  const destPath = path.join(uploadsDir, newFilename);
  fs.copyFileSync(origPath, destPath);
  if (!fs.existsSync(destPath)) return res.redirect(redirErr + '?error=Gagal menyalin file');

  const redir = req.query._redirect ? '&_redirect=' + encodeURIComponent(req.query._redirect) : '';
  res.redirect(`/sign?preload=${newFilename}&originalname=${encodeURIComponent('surat_' + doc.tracking_code + '.pdf')}&guest_doc_id=letter_${doc.id}${redir}`);
});

// --- Admin: Template Management ---

router.get('/admin/templates', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  const templates = db.prepare('SELECT * FROM letter_templates ORDER BY name').all();
  res.render('admin_templates', { templates, user: req.session.user, message: req.query.message, error: req.query.error });
});

router.get('/admin/templates/new', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  res.render('admin_template_form', { template: null, user: req.session.user, message: null, error: req.query.error });
});

router.post('/admin/templates/new', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const { name, code, description, form_fields, pejabat_nama, pejabat_jabatan, pejabat_nip, kop_kiri, kop_kanan, body_font_size, kop_font_size, title_font_size, margin_left, margin_top, margin_right, margin_bottom, judul_surat, body_pembuka, body_data_label, body_isi, body_penutup } = req.body;
  if (!name || !code) return res.redirect('/surat/admin/templates/new?error=Nama dan kode wajib diisi');
  const db = getDB();
  let fields = [];
  try { fields = JSON.parse(form_fields || '[]'); } catch (e) { fields = []; }
  if (fields.length === 0) return res.redirect('/surat/admin/templates/new?error=Form fields tidak valid');
  const styles = JSON.stringify({
    bodyFontSize: parseInt(body_font_size) || 11,
    kopFontSize: parseInt(kop_font_size) || 9,
    titleFontSize: parseInt(title_font_size) || 14,
    signatureFontSize: 11
  });
  const margins = JSON.stringify([
    parseInt(margin_left) || 60,
    parseInt(margin_top) || 40,
    parseInt(margin_right) || 60,
    parseInt(margin_bottom) || 40
  ]);
  try {
    db.prepare(
      'INSERT INTO letter_templates (name, code, description, form_fields, styles, default_margins, kop_kiri, kop_kanan, pejabat_nama, pejabat_jabatan, pejabat_nip, judul_surat, body_pembuka, body_data_label, body_isi, body_penutup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, code, description || '', JSON.stringify(fields), styles, margins, kop_kiri || '', kop_kanan || '', pejabat_nama || '', pejabat_jabatan || '', pejabat_nip || '', judul_surat || '', body_pembuka || '', body_data_label || '', body_isi || '', body_penutup || '');
    res.redirect('/surat/admin/templates?message=Tersimpan');
  } catch (e) {
    res.redirect('/surat/admin/templates/new?error=' + encodeURIComponent(e.message));
  }
});

router.get('/admin/templates/:id/edit', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  const template = db.prepare('SELECT * FROM letter_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.redirect('/surat/admin/templates?error=Tidak ditemukan');
  // Convert NULL body fields to '' agar form tidak menampilkan null
  for (const col of ['judul_surat', 'body_pembuka', 'body_data_label', 'body_isi', 'body_penutup', 'kop_kiri', 'kop_kanan', 'pejabat_nama', 'pejabat_jabatan', 'pejabat_nip']) {
    if (template[col] === null) template[col] = '';
  }
  res.render('admin_template_form', { template, user: req.session.user, message: null, error: req.query.error });
});

router.post('/admin/templates/:id/edit', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const { name, code, description, form_fields, pejabat_nama, pejabat_jabatan, pejabat_nip, kop_kiri, kop_kanan, body_font_size, kop_font_size, title_font_size, margin_left, margin_top, margin_right, margin_bottom, judul_surat, body_pembuka, body_data_label, body_isi, body_penutup } = req.body;
  const db = getDB();
  let fields = [];
  try { fields = JSON.parse(form_fields || '[]'); } catch (e) { fields = []; }
  const styles = JSON.stringify({
    bodyFontSize: parseInt(body_font_size) || 11,
    kopFontSize: parseInt(kop_font_size) || 9,
    titleFontSize: parseInt(title_font_size) || 14,
    signatureFontSize: 11
  });
  const margins = JSON.stringify([
    parseInt(margin_left) || 60,
    parseInt(margin_top) || 40,
    parseInt(margin_right) || 60,
    parseInt(margin_bottom) || 40
  ]);
  try {
    db.prepare(
      'UPDATE letter_templates SET name=?, code=?, description=?, form_fields=?, styles=?, default_margins=?, kop_kiri=?, kop_kanan=?, pejabat_nama=?, pejabat_jabatan=?, pejabat_nip=?, judul_surat=?, body_pembuka=?, body_data_label=?, body_isi=?, body_penutup=? WHERE id=?'
    ).run(name, code, description || '', JSON.stringify(fields), styles, margins, kop_kiri || '', kop_kanan || '', pejabat_nama || '', pejabat_jabatan || '', pejabat_nip || '', judul_surat || '', body_pembuka || '', body_data_label || '', body_isi || '', body_penutup || '', req.params.id);
    res.redirect('/surat/admin/templates?message=Tersimpan');
  } catch (e) {
    res.redirect('/surat/admin/templates/' + req.params.id + '/edit?error=' + encodeURIComponent(e.message));
  }
});

router.post('/admin/templates/:id/logo', logoUpload.single('logo'), (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  if (!req.file) return res.redirect('/surat/admin/templates/' + req.params.id + '/edit?error=Pilih file logo');
  const db = getDB();
  const template = db.prepare('SELECT * FROM letter_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.redirect('/surat/admin/templates?error=Tidak ditemukan');
  const ext = path.extname(req.file.originalname).toLowerCase();
  const logoFilename = 'logo_' + req.params.id + ext;
  const finalPath = path.join(logoDir, logoFilename);
  fs.renameSync(req.file.path, finalPath);
  db.prepare('UPDATE letter_templates SET logo_path = ? WHERE id = ?').run('uploads/logos/' + logoFilename, req.params.id);
  res.redirect('/surat/admin/templates/' + req.params.id + '/edit?message=Logo tersimpan');
});

router.post('/admin/templates/:id/docx', docxUpload.single('docx_template'), (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  if (!req.file) return res.redirect('/surat/admin/templates/' + req.params.id + '/edit?error=Pilih file .docx');
  const db = getDB();
  const template = db.prepare('SELECT * FROM letter_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.redirect('/surat/admin/templates?error=Tidak ditemukan');
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (ext !== '.docx') return res.redirect('/surat/admin/templates/' + req.params.id + '/edit?error=Hanya file .docx');
  const docxFilename = 'tmpl_' + req.params.id + '.docx';
  const finalPath = path.join(docxDir, docxFilename);
  fs.renameSync(req.file.path, finalPath);
  db.prepare('UPDATE letter_templates SET docx_template_path = ? WHERE id = ?').run('uploads/docx_templates/' + docxFilename, req.params.id);
  res.redirect('/surat/admin/templates/' + req.params.id + '/edit?message=Template .docx tersimpan');
});

router.post('/admin/templates/:id/docx/delete', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  const template = db.prepare('SELECT * FROM letter_templates WHERE id = ?').get(req.params.id);
  if (template && template.docx_template_path) {
    const p = path.join(__dirname, '..', '..', template.docx_template_path);
    try { fs.unlinkSync(p); } catch (e) {}
  }
  db.prepare('UPDATE letter_templates SET docx_template_path = NULL WHERE id = ?').run(req.params.id);
  res.redirect('/surat/admin/templates/' + req.params.id + '/edit?message=Template .docx dihapus');
});

router.post('/admin/templates/:id/delete', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  const count = db.prepare('SELECT COUNT(*) as c FROM letter_templates').get().c;
  if (count <= 1) return res.redirect('/surat/admin/templates?error=Minimal satu template harus ada');
  db.prepare('DELETE FROM letter_templates WHERE id = ?').run(req.params.id);
  res.redirect('/surat/admin/templates?message=Template dihapus');
});

// --- Admin: Backup & Restore ---

router.get('/admin/backup', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  res.render('admin_backup', { user: req.session.user, message: req.query.message, error: req.query.error });
});

router.get('/admin/backup/export', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  const backup = {
    version: 1,
    exported_at: new Date().toISOString(),
    users: db.prepare('SELECT id, username, password, display_name, role, email, phone, organization, created_at FROM users').all(),
    signers: db.prepare('SELECT id, user_id, label, display_name, organization, email, phone, public_key, private_key_encrypted, algorithm, created_at FROM signers').all(),
    letter_templates: db.prepare('SELECT * FROM letter_templates').all(),
    app_settings: db.prepare('SELECT setting_key, setting_value FROM app_settings').all()
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="digisign_backup_' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json(backup);
});

const backupUpload = multer({ dest: path.join(__dirname, '..', '..', 'uploads', 'temp') });

router.post('/admin/backup/import', backupUpload.single('backup_file'), (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  if (!req.file) return res.redirect('/surat/admin/backup?error=Pilih file backup');
  try {
    const data = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
    if (!data.version) return res.redirect('/surat/admin/backup?error=Format backup tidak valid');
    const db = getDB();
    if (data.users && Array.isArray(data.users)) {
      for (const u of data.users) {
        try {
          db.prepare('INSERT OR REPLACE INTO users (id, username, password, display_name, role, email, phone, organization, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(u.id, u.username, u.password, u.display_name, u.role || 'user', u.email || null, u.phone || null, u.organization || null, u.created_at || null);
        } catch (e) {}
      }
    }
    if (data.signers && Array.isArray(data.signers)) {
      for (const s of data.signers) {
        try {
          db.prepare('INSERT OR REPLACE INTO signers (id, user_id, label, display_name, organization, email, phone, public_key, private_key_encrypted, algorithm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(s.id, s.user_id, s.label, s.display_name, s.organization || null, s.email || null, s.phone || null, s.public_key || null, s.private_key_encrypted || null, s.algorithm || 'RSA-2048', s.created_at || null);
        } catch (e) {}
      }
    }
    if (data.letter_templates && Array.isArray(data.letter_templates)) {
      for (const t of data.letter_templates) {
        try {
          db.prepare('INSERT OR REPLACE INTO letter_templates (id, name, code, description, form_fields, styles, default_margins, logo_path, kop_kiri, kop_kanan, pejabat_nama, pejabat_jabatan, pejabat_nip, judul_surat, body_pembuka, body_data_label, body_isi, body_penutup, docx_template_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(t.id, t.name, t.code, t.description || '', t.form_fields || '[]', t.styles || null, t.default_margins || null, t.logo_path || null, t.kop_kiri || null, t.kop_kanan || null, t.pejabat_nama || null, t.pejabat_jabatan || null, t.pejabat_nip || null, t.judul_surat || null, t.body_pembuka || null, t.body_data_label || null, t.body_isi || null, t.body_penutup || null, t.docx_template_path || null, t.created_at || null);
        } catch (e) {}
      }
    }
    if (data.app_settings && Array.isArray(data.app_settings)) {
      for (const s of data.app_settings) {
        try {
          db.prepare('INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?, ?)').run(s.setting_key, s.setting_value);
        } catch (e) {}
      }
    }
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.redirect('/surat/admin/backup?message=Import berhasil. Data users, signers, template & settings dipulihkan.');
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (e2) {}
    res.redirect('/surat/admin/backup?error=Gagal: ' + encodeURIComponent(e.message));
  }
});

module.exports = router;
