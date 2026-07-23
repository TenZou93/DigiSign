const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { getDB } = require('../database');

const guestTempDir = path.join(__dirname, '..', '..', 'uploads', 'guest_temp');
if (!fs.existsSync(guestTempDir)) fs.mkdirSync(guestTempDir, { recursive: true });

const upload = multer({
  dest: guestTempDir,
  limits: { fileSize: 50 * 1024 * 1024 }
});

function generateTracking() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

router.get('/', (req, res) => {
  const db = getDB();
  const signers = db.prepare('SELECT id, label, display_name, organization FROM signers').all();
  res.render('guest_upload', { signers, message: req.query.message, error: req.query.error });
});

router.post('/upload', upload.single('document'), (req, res) => {
  try {
    if (!req.file) return res.redirect('/?error=Pilih file terlebih dahulu');
    const filePath = path.join(guestTempDir, req.file.filename);
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return res.redirect('/?error=File kosong');
    const { guest_name, guest_email, signer_id, document_name } = req.body;
    const docName = (document_name && document_name.trim()) ? document_name.trim() : req.file.originalname;
    const db = getDB();
    const tracking = generateTracking();
    db.prepare(
      "INSERT INTO guest_docs (guest_name, guest_email, filename, originalname, signer_id, tracking_code, document_name) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(guest_name || null, guest_email || null, req.file.filename, req.file.originalname, signer_id || null, tracking, docName);
    res.redirect('/?success=' + tracking);
  } catch (e) {
    res.redirect('/?error=Gagal mengunggah: ' + e.message);
  }
});

router.get('/api/track/:code', (req, res) => {
  try {
    const db = getDB();
    const doc = db.prepare(`
      SELECT g.*, sn.display_name as signer_name
      FROM guest_docs g
      LEFT JOIN signers sn ON g.signer_id = sn.id
      WHERE g.tracking_code = ?
    `).get(req.params.code);
    if (!doc) return res.json({ error: 'Nomor tracking tidak ditemukan' });
    let download_url = null;
    if (doc.status === 'signed' && doc.signed_file) {
      download_url = '/guest/download/' + doc.tracking_code;
    }
    res.json({
      tracking_code: doc.tracking_code,
      guest_name: doc.guest_name,
      originalname: doc.originalname,
      document_name: doc.document_name || doc.originalname,
      signer_name: doc.signer_name,
      status: doc.status,
      created_at: doc.created_at,
      admin_note: doc.admin_note,
      download_url
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/download/:code', (req, res) => {
  const db = getDB();
  const doc = db.prepare('SELECT * FROM guest_docs WHERE tracking_code = ?').get(req.params.code);
  if (!doc || !doc.signed_file) return res.status(404).send('File tidak ditemukan');
  const signedDir = path.join(__dirname, '..', '..', 'uploads', 'signed');
  const filePath = path.join(signedDir, doc.signed_file);
  if (!fs.existsSync(filePath)) return res.status(404).send('File tidak ditemukan');
  const dlName = (doc.document_name || doc.originalname).replace(/\.[^.]+$/, '') + '_signed.pdf';
  res.download(filePath, dlName);
});

router.get('/prepare-sign/:id', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  const db = getDB();
  const doc = db.prepare('SELECT * FROM guest_docs WHERE id = ?').get(req.params.id);
  if (!doc || doc.status !== 'approved') return res.redirect('/documents?error=Dokumen tidak valid');
  const guestPath = path.join(guestTempDir, doc.filename);
  if (!fs.existsSync(guestPath)) return res.redirect('/documents?error=File asli tidak ditemukan');
  const destDir = path.join(__dirname, '..', '..', 'uploads');
  const ext = path.extname(doc.originalname) || '.pdf';
  const newFilename = `guest_${doc.id}_${Date.now()}${ext}`;
  fs.copyFileSync(guestPath, path.join(destDir, newFilename));
  const redir = req.query._redirect ? '&_redirect=' + encodeURIComponent(req.query._redirect) : '';
  res.redirect(`/sign?preload=${newFilename}&originalname=${encodeURIComponent(doc.originalname)}&guest_doc_id=${doc.id}${redir}`);
});

module.exports = router;
