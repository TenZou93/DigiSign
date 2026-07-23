const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const router = express.Router();
const { getDB } = require('../database');
const { generateLetterPDF } = require('../letter-generator');

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

    const pdfBuffer = await generateLetterPDF(template, fieldData);

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

// Admin: approve letter (dengan signer_id dari form)
router.post('/admin/:id/approve', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/auth/login');
  const db = getDB();
  const doc = db.prepare('SELECT * FROM generated_letters WHERE id = ?').get(req.params.id);
  if (!doc) return res.redirect('/surat/admin/list?error=Tidak ditemukan');
  const signerId = req.body.signer_id || doc.signer_id || null;
  db.prepare("UPDATE generated_letters SET status = 'approved', signer_id = ? WHERE id = ?").run(signerId, req.params.id);
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

module.exports = router;
