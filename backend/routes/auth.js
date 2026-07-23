const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDB } = require('../database');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('register', { error: null });
});

router.post('/register', (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password) {
    return res.render('register', { error: 'Username dan password wajib diisi' });
  }
  try {
    const db = getDB();
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get()?.c || 0;
    const role = userCount === 0 ? 'admin' : 'user';
    const displayName = display_name || username;
    db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)').run(username, hash, displayName, role);
    if (role !== 'admin') {
      const newUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      db.prepare('INSERT INTO signers (user_id, label, display_name, public_key, private_key_encrypted) VALUES (?, ?, ?, ?, ?)').run(newUser.id, displayName, displayName, publicKey, privateKey);
    }
    res.redirect('/auth/login');
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.render('register', { error: 'Username sudah digunakan' });
    }
    res.render('register', { error: e.message });
  }
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDB();
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, hash);
  if (!user) {
    if (req.is('json')) return res.json({ error: 'Username atau password salah' });
    return res.render('login', { error: 'Username atau password salah' });
  }
  req.session.user = { id: user.id, username: user.username, display_name: user.display_name, email: user.email, phone: user.phone, organization: user.organization, role: user.role };
  if (req.is('json')) return res.json({ redirect: '/dashboard' });
  res.redirect('/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;
