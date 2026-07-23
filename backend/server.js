const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { initDB, getDB } = require('./database');
const { generateCertificate } = require('./utils/certificate');
const authRoutes = require('./routes/auth');
const keyRoutes = require('./routes/keys');
const signRoutes = require('./routes/sign');
const verifyRoutes = require('./routes/verify');
const profileRoutes = require('./routes/profile');
const adminRoutes = require('./routes/admin');
const guestRoutes = require('./routes/guest');
const letterRoutes = require('./routes/letters');

const app = express();
const PORT = process.env.PORT || 3009;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'digital-signature-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'frontend', 'views'));
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  try {
    const db = getDB();
    const rows = db.prepare('SELECT setting_key, setting_value FROM app_settings').all();
    const settings = { site_name: 'DigiSign', logo_text: 'DigiSign', primary_color: '#3b82f6' };
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    res.locals.settings = settings;
  } catch (e) {
    res.locals.settings = { site_name: 'DigiSign', logo_text: 'DigiSign', primary_color: '#3b82f6' };
  }
  next();
});

app.use('/auth', authRoutes);
app.use('/keys', keyRoutes);
app.use('/sign', signRoutes);
app.use('/verify', verifyRoutes);
app.use('/profile', profileRoutes);
app.use('/guest', guestRoutes);
app.use('/surat', letterRoutes);
app.use('/admin', adminRoutes);

app.get('/documents', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  const db = getDB();
  const sigPage = Math.max(1, parseInt(req.query.sig_page) || 1);
  const guestPage = Math.max(1, parseInt(req.query.guest_page) || 1);
  const limit = 10;

  const sigTotalRow = db.prepare('SELECT COUNT(*) as count FROM signatures WHERE user_id = ?').get(req.session.user.id);
  const sigTotal = sigTotalRow ? sigTotalRow.count : 0;
  const sigTotalPages = Math.max(1, Math.ceil(sigTotal / limit));
  const sigOffset = (sigPage - 1) * limit;
  const signatures = db.prepare(`
    SELECT s.id, s.token, s.document_name, s.signed_at, s.qr_code, s.signed_file,
           COALESCE(k.label, sn.label, '-') as key_label
    FROM signatures s
    LEFT JOIN key_pairs k ON s.key_id = k.id
    LEFT JOIN signers sn ON s.signer_id = sn.id
    WHERE s.user_id = ? ORDER BY s.signed_at DESC LIMIT ? OFFSET ?
  `).all(req.session.user.id, limit, sigOffset);

  let guestDocs = [];
  let guestTotal = 0;
  let guestTotalPages = 1;
  const isAdmin = req.session.user.role === 'admin';
  if (isAdmin) {
    const guestTotalRow = db.prepare('SELECT COUNT(*) as count FROM guest_docs').get();
    guestTotal = guestTotalRow ? guestTotalRow.count : 0;
    guestTotalPages = Math.max(1, Math.ceil(guestTotal / limit));
    const guestOffset = (guestPage - 1) * limit;
    guestDocs = db.prepare(`
      SELECT g.*, sn.display_name as signer_name, sn.label as signer_label
      FROM guest_docs g
      LEFT JOIN signers sn ON g.signer_id = sn.id
      ORDER BY g.created_at DESC LIMIT ? OFFSET ?
    `).all(limit, guestOffset);
  } else {
    const mySigners = db.prepare('SELECT id FROM signers WHERE user_id = ?').all(req.session.user.id);
    if (mySigners.length > 0) {
      const ids = mySigners.map(s => s.id).join(',');
      const guestTotalRow = db.prepare(`SELECT COUNT(*) as count FROM guest_docs WHERE signer_id IN (${ids})`).get();
      guestTotal = guestTotalRow ? guestTotalRow.count : 0;
      guestTotalPages = Math.max(1, Math.ceil(guestTotal / limit));
      const guestOffset = (guestPage - 1) * limit;
      guestDocs = db.prepare(`
        SELECT g.*, sn.display_name as signer_name, sn.label as signer_label
        FROM guest_docs g
        LEFT JOIN signers sn ON g.signer_id = sn.id
        WHERE g.signer_id IN (${ids})
        ORDER BY g.created_at DESC LIMIT ? OFFSET ?
      `).all(limit, guestOffset);
    }
  }

  res.render('documents', {
    user: req.session.user,
    signatures, sigPage, sigTotal, sigTotalPages,
    guestDocs, guestPage, guestTotal, guestTotalPages,
    message: req.query.message, error: req.query.error
  });
});

app.post('/documents/delete-signature/:id', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  const db = getDB();
  const sig = db.prepare('SELECT * FROM signatures WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!sig) return res.redirect('/documents?error=Tanda tangan tidak ditemukan');
  try {
    const signedDir = path.join(__dirname, '..', 'uploads', 'signed');
    const qrDir = path.join(__dirname, '..', 'uploads', 'qr');
    const origDir = path.join(__dirname, '..', 'uploads', 'originals');
    if (sig.signed_file) {
      const sf = path.join(signedDir, sig.signed_file);
      try { if (fs.existsSync(sf)) fs.unlinkSync(sf); } catch (e) {}
    }
    if (sig.qr_code) {
      const qf = path.join(qrDir, sig.qr_code);
      try { if (fs.existsSync(qf)) fs.unlinkSync(qf); } catch (e) {}
    }
    const origFile = path.join(origDir, `${sig.token}_original.pdf`);
    try { if (fs.existsSync(origFile)) fs.unlinkSync(origFile); } catch (e) {}
    db.prepare('DELETE FROM signatures WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
    res.redirect('/documents?message=Riwayat berhasil dihapus');
  } catch (e) {
    res.redirect('/documents?error=Gagal menghapus: ' + e.message);
  }
});

app.get('/', (req, res) => {
  if (req.session.user && !req.query.success) return res.redirect('/dashboard');
  const db = getDB();
  const signers = db.prepare('SELECT id, label, display_name, organization FROM signers').all();
  res.render('landing', { signers, message: req.query.message, error: req.query.error, successCode: req.query.success });
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  const db = getDB();
  const totalSigned = db.prepare('SELECT COUNT(*) as c FROM signatures WHERE user_id = ?').get(req.session.user.id)?.c || 0;
  const totalPending = db.prepare("SELECT COUNT(*) as c FROM guest_docs WHERE status = 'pending'").get()?.c || 0;
  const totalSigners = db.prepare('SELECT COUNT(*) as c FROM signers WHERE user_id = ?').get(req.session.user.id)?.c || 0;
  const totalKeys = db.prepare('SELECT COUNT(*) as c FROM key_pairs WHERE user_id = ?').get(req.session.user.id)?.c || 0;
  const recentSigs = db.prepare(`
    SELECT s.id, s.document_name, s.signed_at, COALESCE(k.label, sn.label, '-') as key_label
    FROM signatures s
    LEFT JOIN key_pairs k ON s.key_id = k.id
    LEFT JOIN signers sn ON s.signer_id = sn.id
    WHERE s.user_id = ? ORDER BY s.signed_at DESC LIMIT 5
  `).all(req.session.user.id);
  res.render('dashboard', { user: req.session.user, totalSigned, totalPending, totalSigners, totalKeys, recentSigs });
});

app.get('/s/:token', (req, res) => {
  const db = getDB();
  const sig = db.prepare(`
    SELECT s.*, u.display_name as user_name, k.label as key_label, k.algorithm,
           sn.display_name as signer_name, sn.organization as signer_org, sn.label as signer_label
    FROM signatures s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN key_pairs k ON s.key_id = k.id
    LEFT JOIN signers sn ON s.signer_id = sn.id
    WHERE s.token = ?
  `).get(req.params.token);
  if (!sig) return res.status(404).render('signature_detail', { sig: null, token: req.params.token });
  sig.display_name = sig.signer_name || sig.user_name;
  res.render('signature_detail', { sig, token: req.params.token });
});

initDB().then(() => {
  generateCertificate();
  app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Gagal initialize database:', err);
  process.exit(1);
});
