const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDB } = require('../database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { user, success: null, error: null });
});

router.post('/', (req, res) => {
  const db = getDB();
  const { display_name, email, phone, organization, current_password, new_password, confirm_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  if (new_password) {
    if (!current_password) {
      return res.render('profile', { user, success: null, error: 'Password saat ini wajib diisi' });
    }
    const hash = crypto.createHash('sha256').update(current_password).digest('hex');
    if (hash !== user.password) {
      return res.render('profile', { user, success: null, error: 'Password saat ini salah' });
    }
    if (new_password !== confirm_password) {
      return res.render('profile', { user, success: null, error: 'Password baru tidak cocok' });
    }
    if (new_password.length < 6) {
      return res.render('profile', { user, success: null, error: 'Password minimal 6 karakter' });
    }
    const newHash = crypto.createHash('sha256').update(new_password).digest('hex');
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(newHash, req.session.user.id);
  }

  db.prepare('UPDATE users SET display_name = ?, email = ?, phone = ?, organization = ? WHERE id = ?')
    .run(display_name || user.username, email || null, phone || null, organization || null, req.session.user.id);

  req.session.user.display_name = display_name || user.username;
  req.session.user.email = email || null;
  req.session.user.phone = phone || null;
  req.session.user.organization = organization || null;

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { user: updated, success: 'Profil berhasil diperbarui', error: null });
});

module.exports = router;
