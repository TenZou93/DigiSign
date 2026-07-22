const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDB } = require('../database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', (req, res) => {
  const db = getDB();
  const keys = db.prepare('SELECT id, label, algorithm, created_at FROM key_pairs WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  res.render('keys', { keys, message: null });
});

router.post('/generate', (req, res) => {
  try {
    const { label } = req.body;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const db = getDB();
    const result = db.prepare(
      'INSERT INTO key_pairs (user_id, label, public_key, private_key_encrypted, algorithm) VALUES (?, ?, ?, ?, ?)'
    ).run(req.session.user.id, label || 'default', publicKey, privateKey, 'RSA-2048');

    res.redirect('/keys');
  } catch (e) {
    const db = getDB();
    const keys = db.prepare('SELECT id, label, algorithm, created_at FROM key_pairs WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
    res.render('keys', { keys, message: { type: 'danger', text: 'Gagal generate key: ' + e.message } });
  }
});

router.post('/delete/:id', (req, res) => {
  const db = getDB();
  const key = db.prepare('SELECT id FROM key_pairs WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (key) {
    db.prepare('DELETE FROM signatures WHERE key_id = ?').run(key.id);
    db.prepare('DELETE FROM key_pairs WHERE id = ?').run(key.id);
  }
  res.redirect('/keys');
});

router.get('/export/:id', (req, res) => {
  const db = getDB();
  const key = db.prepare('SELECT public_key, label FROM key_pairs WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!key) return res.status(404).send('Key not found');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${key.label}_public.pem"`);
  res.send(key.public_key);
});

module.exports = router;
