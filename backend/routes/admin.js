const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDB } = require('../database');
const { requireAuth } = require('../middleware/auth');

const logoUpload = multer({ dest: path.join(__dirname, '..', '..', 'frontend', 'public', 'uploads') });

router.use(requireAuth);

function requireAdmin(req, res, next) {
  if (req.session.user.role !== 'admin') return res.status(403).send('Akses ditolak');
  next();
}

router.get('/', requireAdmin, (req, res) => {
  const db = getDB();
  const signers = db.prepare('SELECT * FROM signers WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  res.render('admin', { signers, success: req.query.success, error: req.query.error });
});

router.post('/signers', requireAdmin, (req, res) => {
  const db = getDB();
  const { label, display_name, organization, email, phone } = req.body;
  if (!label || !display_name) {
    return res.redirect('/admin?error=Label dan nama wajib diisi');
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  db.prepare(
    'INSERT INTO signers (user_id, label, display_name, organization, email, phone, public_key, private_key_encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.session.user.id, label, display_name, organization || null, email || null, phone || null, publicKey, privateKey);

  res.redirect('/admin?success=Signer berhasil ditambahkan');
});

router.post('/signers/:id/edit', requireAdmin, (req, res) => {
  const db = getDB();
  const signer = db.prepare('SELECT * FROM signers WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!signer) return res.redirect('/admin?error=Signer tidak ditemukan');

  const { label, display_name, organization, email, phone } = req.body;
  db.prepare('UPDATE signers SET label = ?, display_name = ?, organization = ?, email = ?, phone = ? WHERE id = ?')
    .run(label, display_name, organization || null, email || null, phone || null, req.params.id);

  res.redirect('/admin?success=Signer berhasil diperbarui');
});

router.post('/signers/:id/delete', requireAdmin, (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM signers WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
  res.redirect('/admin?success=Signer berhasil dihapus');
});

router.get('/guests', requireAdmin, (req, res) => {
  const db = getDB();
  const docs = db.prepare(`
    SELECT g.*, sn.display_name as signer_name, sn.label as signer_label
    FROM guest_docs g
    LEFT JOIN signers sn ON g.signer_id = sn.id
    ORDER BY g.created_at DESC
  `).all();
  res.render('admin_guests', { docs, success: req.query.success, error: req.query.error });
});

router.post('/guests/:id/approve', requireAdmin, (req, res) => {
  const db = getDB();
  const doc = db.prepare('SELECT * FROM guest_docs WHERE id = ?').get(req.params.id);
  if (!doc) return res.redirect('/admin/guests?error=Dokumen tidak ditemukan');
  if (doc.status !== 'pending') return res.redirect('/admin/guests?error=Dokumen sudah diproses');
  db.prepare("UPDATE guest_docs SET status = 'approved' WHERE id = ?").run(req.params.id);
  const dest = req.body._redirect || '/admin/guests';
  res.redirect(dest + '?success=Dokumen disetujui');
});

router.post('/guests/:id/mark-signed', requireAdmin, (req, res) => {
  const db = getDB();
  const doc = db.prepare('SELECT * FROM guest_docs WHERE id = ?').get(req.params.id);
  if (!doc) return res.redirect('/admin/guests?error=Dokumen tidak ditemukan');
  const { signature_id } = req.body;
  if (!signature_id) return res.redirect('/admin/guests?error=ID Signature diperlukan');
  const sig = db.prepare('SELECT * FROM signatures WHERE id = ?').get(signature_id);
  if (!sig) return res.redirect('/admin/guests?error=Signature tidak ditemukan');
  db.prepare("UPDATE guest_docs SET status = 'signed', signature_id = ?, signed_file = ? WHERE id = ?")
    .run(signature_id, sig.signed_file, req.params.id);
  const dest = req.body._redirect || '/admin/guests';
  res.redirect(dest + '?success=Dokumen ditandai sebagai sudah ditandatangani');
});

router.post('/guests/:id/reject', requireAdmin, (req, res) => {
  const db = getDB();
  const doc = db.prepare('SELECT * FROM guest_docs WHERE id = ?').get(req.params.id);
  if (!doc) return res.redirect('/admin/guests?error=Dokumen tidak ditemukan');
  const { admin_note } = req.body;
  db.prepare("UPDATE guest_docs SET status = 'rejected', admin_note = ? WHERE id = ?").run(admin_note || null, req.params.id);
  const dest = req.body._redirect || '/admin/guests';
  res.redirect(dest + '?success=Dokumen ditolak');
});

router.get('/guests/:id/sign', requireAdmin, (req, res) => {
  const db = getDB();
  const doc = db.prepare('SELECT * FROM guest_docs WHERE id = ?').get(req.params.id);
  if (!doc || doc.status !== 'approved') return res.redirect('/admin/guests?error=Dokumen tidak valid');
  const tempPath = path.join(__dirname, '..', '..', 'uploads', 'guest_temp', doc.filename);
  if (!fs.existsSync(tempPath)) return res.redirect('/admin/guests?error=File asli tidak ditemukan');
  const stat = fs.statSync(tempPath);
  if (stat.size === 0) return res.redirect('/admin/guests?error=File asli kosong (0 bytes)');
  const destDir = path.join(__dirname, '..', '..', 'uploads');
  const ext = path.extname(doc.originalname) || '.pdf';
  const newFilename = `guest_${doc.id}_${Date.now()}${ext}`;
  const destPath = path.join(destDir, newFilename);
  fs.copyFileSync(tempPath, destPath);
  const destStat = fs.statSync(destPath);
  if (destStat.size === 0) return res.redirect('/admin/guests?error=Gagal menyalin file');
  const signer = doc.signer_id ? db.prepare('SELECT id, display_name FROM signers WHERE id = ?').get(doc.signer_id) : null;
  const redir = req.query._redirect ? '&_redirect=' + encodeURIComponent(req.query._redirect) : '';
  res.redirect(`/sign?preload=${newFilename}&originalname=${encodeURIComponent(doc.originalname)}&signer_id=${signer ? signer.id : ''}&guest_doc_id=${doc.id}${redir}`);
});

router.get('/signers/:id/keys', requireAdmin, (req, res) => {
  const db = getDB();
  const signer = db.prepare('SELECT id, label, display_name, public_key, algorithm FROM signers WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!signer) return res.status(404).json({ error: 'Signer tidak ditemukan' });
  res.json({ signer });
});

router.get('/settings', requireAdmin, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT setting_key, setting_value FROM app_settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
  res.render('admin_settings', { settings, success: req.query.success, error: req.query.error });
});

router.post('/settings', requireAdmin, logoUpload.single('logo_file'), (req, res) => {
  const db = getDB();
  const { site_name, primary_color, logo_text, menu_items } = req.body;
  try {
    if (site_name !== undefined) db.prepare('UPDATE app_settings SET setting_value = ? WHERE setting_key = ?').run(site_name, 'site_name');
    if (primary_color !== undefined) {
      let color = primary_color.trim();
      if (!color.startsWith('#')) color = '#' + color;
      db.prepare('UPDATE app_settings SET setting_value = ? WHERE setting_key = ?').run(color, 'primary_color');
    }
    if (logo_text !== undefined) db.prepare('UPDATE app_settings SET setting_value = ? WHERE setting_key = ?').run(logo_text, 'logo_text');
    if (menu_items !== undefined) db.prepare('UPDATE app_settings SET setting_value = ? WHERE setting_key = ?').run(menu_items, 'menu_items');
    if (req.file) {
      db.prepare('UPDATE app_settings SET setting_value = ? WHERE setting_key = ?').run('/uploads/' + req.file.filename, 'logo_url');
    }
    res.redirect('/admin/settings?success=Pengaturan berhasil disimpan');
  } catch (e) {
    res.redirect('/admin/settings?error=Gagal menyimpan: ' + e.message);
  }
});

module.exports = router;
