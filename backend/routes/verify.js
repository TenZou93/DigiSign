const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { getDB } = require('../database');
const { requireAuth } = require('../middleware/auth');

const upload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

router.use(requireAuth);

router.get('/', (req, res) => {
  res.render('verify', { user: req.session.user });
});

router.post('/check', upload.single('document'), (req, res) => {
  try {
    if (!req.file) {
      return res.json({ valid: false, status: 'error', message: 'Tidak ada file yang diupload', details: [] });
    }

    const db = getDB();
    const fileData = fs.readFileSync(req.file.path);
    const uploadedHash = crypto.createHash('sha256').update(fileData).digest('hex');

    try { fs.unlinkSync(req.file.path); } catch (e) {}

    let sig = db.prepare(`
      SELECT s.*, u.display_name as user_name,
             COALESCE(k.public_key, sn.public_key) as public_key,
             COALESCE(k.label, sn.label, '-') as key_label,
             COALESCE(k.algorithm, sn.algorithm) as algorithm,
             sn.display_name as signer_name, sn.organization as signer_org
      FROM signatures s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN key_pairs k ON s.key_id = k.id
      LEFT JOIN signers sn ON s.signer_id = sn.id
      WHERE s.signed_file_hash = ?
      ORDER BY s.signed_at DESC
      LIMIT 1
    `).get(uploadedHash);

    if (!sig) {
      sig = db.prepare(`
        SELECT s.*, u.display_name as user_name,
               COALESCE(k.public_key, sn.public_key) as public_key,
               COALESCE(k.label, sn.label, '-') as key_label,
               COALESCE(k.algorithm, sn.algorithm) as algorithm,
               sn.display_name as signer_name, sn.organization as signer_org
        FROM signatures s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN key_pairs k ON s.key_id = k.id
        LEFT JOIN signers sn ON s.signer_id = sn.id
        WHERE s.document_hash = ?
        ORDER BY s.signed_at DESC
        LIMIT 1
      `).get(uploadedHash);
    }

    if (!sig) {
      return res.json({
        valid: false,
        status: 'warning',
        message: 'Dokumen tidak ditemukan dalam database tanda tangan',
        details: [
          { label: 'File', value: req.file.originalname },
          { label: 'Hash (SHA-256)', value: uploadedHash },
          { label: 'Status', value: 'Tidak ada tanda tangan yang tercatat untuk dokumen ini' }
        ]
      });
    }

    let sigValid = false;
    let verifyMethod = 'database';

    const origDir = path.join(__dirname, '..', '..', 'uploads', 'originals');
    const origExt = path.extname(sig.document_name).toLowerCase();
    const origPath = path.join(origDir, `${sig.token}_original${origExt}`);

    if (fs.existsSync(origPath)) {
      const originalData = fs.readFileSync(origPath);
      const originalHash = crypto.createHash('sha256').update(originalData).digest('hex');
      if (originalHash === sig.document_hash) {
        const verifier = crypto.createVerify('sha256');
        verifier.update(originalData);
        verifier.end();
        sigValid = verifier.verify(sig.public_key, sig.signature, 'base64');
        verifyMethod = 'crypto';
      }
    } else {
      if (uploadedHash === sig.document_hash) {
        const verifier = crypto.createVerify('sha256');
        verifier.update(fileData);
        verifier.end();
        sigValid = verifier.verify(sig.public_key, sig.signature, 'base64');
        verifyMethod = 'crypto';
      } else if (uploadedHash === sig.signed_file_hash) {
        sigValid = true;
        verifyMethod = 'database';
      }
    }

    return res.json({
      valid: sigValid,
      status: sigValid ? 'valid' : 'invalid',
      message: sigValid ? 'Dokumen asli dan tanda tangan valid' : 'Tanda tangan tidak valid',
      details: [
        { label: 'File', value: sig.document_name },
        { label: 'Ditandatangani oleh', value: sig.signer_name || sig.user_name },
        { label: 'Waktu', value: sig.signed_at },
        { label: 'Kunci Digunakan', value: `${sig.key_label} (${sig.algorithm})` },
        { label: 'Hash Dokumen', value: `<span class="hash-text">${sig.document_hash}</span>` },
        { label: 'Metode Verifikasi', value: verifyMethod === 'crypto' ? 'Kriptografi (RSA)' : 'Database' },
        { label: 'Status', value: sigValid
          ? '<span class="badge bg-success">Valid — Dokumen asli, tidak ada perubahan</span>'
          : '<span class="badge bg-danger">Invalid — Dokumen telah dimodifikasi</span>' }
      ]
    });
  } catch (e) {
    console.error('Verify error:', e);
    return res.json({ valid: false, status: 'error', message: 'Error: ' + e.message, details: [] });
  }
});

module.exports = router;
