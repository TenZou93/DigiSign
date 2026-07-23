const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { PDFDocument, rgb, StandardFonts, PDFName, PDFNumber, PDFHexString, PDFString } = require('pdf-lib');
const forge = require('node-forge');
const { SignPdf } = require('@signpdf/signpdf');
const { P12Signer } = require('@signpdf/signer-p12');
const { getCertificate } = require('../utils/certificate');
const { enhanceSignedPdf } = require('../utils/cms-enhance');
const router = express.Router();
const { getDB } = require('../database');
const { requireAuth } = require('../middleware/auth');
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3009}`;

const upload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

async function signPdfWithPades(pdfBuffer, p12Buffer, passphrase) {
  const buf = Buffer.from(pdfBuffer);
  const pdfStr = buf.toString('latin1');

  const brMatch = pdfStr.match(/\/ByteRange\s*\[\s*\d+\s+\d+\s+\d+\s+\d+\s*\]/);
  if (!brMatch) throw new Error('/ByteRange not found');

  const before = buf.slice(0, brMatch.index);
  const after = buf.slice(brMatch.index + brMatch[0].length);
  const brPlaceholder = '/ByteRange [0 /********** /********** /**********]';
  const shift = brPlaceholder.length - brMatch[0].length;

  let adjustedAfter = after;
  if (shift !== 0) {
    const afterStr = after.toString('latin1');
    const sfMatch = afterStr.match(/startxref\n(\d+)\n%%EOF/);
    if (sfMatch) {
      const oldVal = parseInt(sfMatch[1]);
      const newVal = oldVal + shift;
      const fixed = Buffer.alloc(after.length);
      after.copy(fixed);
      fixed.write(String(newVal), sfMatch.index + 10, 'latin1');
      if (String(newVal).length < sfMatch[1].length) {
        fixed.write(' '.repeat(sfMatch[1].length - String(newVal).length), sfMatch.index + 10 + String(newVal).length, 'latin1');
      }
      adjustedAfter = fixed;
    }
  }

  // Let @signpdf handle ByteRange + hash + CMS creation
  const prepared = Buffer.concat([before, Buffer.from(brPlaceholder, 'latin1'), adjustedAfter]);
  let signed = await new SignPdf().sign(Buffer.from(prepared), new P12Signer(p12Buffer, { passphrase }));

  // Post-process: replace zero padding with NULL nodes for fast DER parsing
  const sStr = signed.toString('latin1');
  const cm = sStr.match(/\/Contents\s*<([0-9a-fA-F]+?)>/);
  if (cm) {
    const hex = cm[1];
    const bytes = Buffer.from(hex, 'hex');
    // Parse outer SEQUENCE to find actual CMS DER length
    let derLen = 0;
    if (bytes[0] === 0x30) {
      const lb = bytes[1];
      if (lb < 0x80) { derLen = 2 + lb; }
      else {
        const nb = lb & 0x7f; let cl = 0;
        for (let i = 0; i < nb; i++) cl = (cl << 8) | bytes[2 + i];
        derLen = 2 + nb + cl;
      }
    }
    if (derLen > 0 && derLen < bytes.length) {
      const cmsPart = bytes.slice(0, derLen);
      const padBytes = bytes.slice(derLen);
      // Replace zeros with 0x05 0x00 (DER NULL) pairs
      const nullPad = Buffer.alloc(padBytes.length);
      for (let i = 0; i < padBytes.length; i += 2) {
        if (i + 1 < padBytes.length) {
          nullPad[i] = 0x05;
          nullPad[i + 1] = 0x00;
        } else {
          nullPad[i] = 0x00; // odd leftover
        }
      }
      const newBytes = Buffer.concat([cmsPart, nullPad]);
      const newHex = newBytes.toString('hex').toUpperCase();
      if (newHex.length === hex.length) {
        signed = Buffer.from(sStr.replace(hex, newHex), 'latin1');
      }
    }
  }

  fs.appendFileSync(path.join(__dirname, '..', '..', 'debug.log'),
    `Sign done: ${signed.length} bytes\n`);
  return signed;
}

router.use(requireAuth);

router.get('/', (req, res) => {
  const db = getDB();
  const keys = db.prepare('SELECT id, label, algorithm, created_at FROM key_pairs WHERE user_id = ?').all(req.session.user.id);
  let signers = db.prepare('SELECT id, label, display_name, organization FROM signers WHERE user_id = ?').all(req.session.user.id);
  const isAdmin = req.session.user.role === 'admin';
  if (!isAdmin && signers.length === 0) {
    signers = db.prepare('SELECT id, label, display_name, organization FROM signers WHERE user_id = ?').all(req.session.user.id);
  }
  const mySigner = !isAdmin && signers.length > 0 ? signers[0] : null;
  const error = req.query.error || null;
  res.render('sign', {
    keys, signers, message: null, error, isAdmin,
    mySigner,
    preload: req.query.preload || null,
    preloadName: req.query.originalname || null,
    preloadSignerId: mySigner ? mySigner.id : (req.query.signer_id || null),
    guestDocId: req.query.guest_doc_id || null,
    redirectAfterSign: req.query._redirect || null
  });
});

router.post('/delete/:id', (req, res) => {
  const db = getDB();
  const sig = db.prepare('SELECT * FROM signatures WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!sig) return res.redirect('/sign?error=Tanda tangan tidak ditemukan');
  try {
    const signedDir = path.join(__dirname, '..', '..', 'uploads', 'signed');
    const qrDir = path.join(__dirname, '..', '..', 'uploads', 'qr');
    const origDir = path.join(__dirname, '..', '..', 'uploads', 'originals');
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
    res.redirect('/sign?message=Riwayat berhasil dihapus');
  } catch (e) {
    res.redirect('/sign?error=Gagal menghapus: ' + e.message);
  }
});

router.get('/preview/:filename', (req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'uploads', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.sendFile(filePath);
});

router.post('/upload-preview', upload.single('document'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });
  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    preview_url: `/sign/preview/${req.file.filename}`
  });
});

router.post('/apply-sign', upload.none(), async (req, res) => {
  try {
    const { filename, originalname, display_name, key_id, signer_id, page_num, pos_x, pos_y, canvas_w, canvas_h, pdf_w, pdf_h, qr_size } = req.body;
    if (!filename || (!key_id && !signer_id)) return res.status(400).json({ error: 'Data tidak lengkap' });

    const db = getDB();

    let key, signerName, signerOrg, signerEmail;
    let signerRecord = null;

    let effectiveSignerId = signer_id;
    if (req.session.user.role !== 'admin') {
      const mySigner = db.prepare('SELECT id FROM signers WHERE user_id = ?').get(req.session.user.id);
      if (!mySigner) return res.status(403).json({ error: 'Anda belum memiliki signer. Hubungi admin.' });
      effectiveSignerId = String(mySigner.id);
    }

    if (effectiveSignerId) {
      signerRecord = db.prepare('SELECT * FROM signers WHERE id = ? AND user_id = ?').get(effectiveSignerId, req.session.user.id);
      if (!signerRecord) return res.status(404).json({ error: 'Signer tidak ditemukan' });
      key = { public_key: signerRecord.public_key, private_key_encrypted: signerRecord.private_key_encrypted, label: signerRecord.label };
      signerName = signerRecord.display_name;
      signerOrg = signerRecord.organization;
      signerEmail = signerRecord.email;
    } else {
      key = db.prepare('SELECT * FROM key_pairs WHERE id = ? AND user_id = ?').get(key_id, req.session.user.id);
      if (!key) return res.status(404).json({ error: 'Key tidak ditemukan' });
      signerName = req.session.user.display_name;
      signerOrg = req.session.user.organization;
      signerEmail = req.session.user.email;
    }

    const filePath = path.join(__dirname, '..', '..', 'uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan' });

    const fileData = fs.readFileSync(filePath);
    const docHash = crypto.createHash('sha256').update(fileData).digest('hex');

    const signer = crypto.createSign('sha256');
    signer.update(fileData);
    signer.end();
    const signatureB64 = signer.sign(key.private_key_encrypted, 'base64');

    const token = crypto.randomBytes(16).toString('hex');
    const signUrl = `${BASE_URL}/s/${token}`;

    const qrDir = path.join(__dirname, '..', '..', 'uploads', 'qr');
    if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
    const qrFilename = `${path.parse(originalname).name}_qr.png`;
    const qrPath = path.join(qrDir, qrFilename);
    await QRCode.toFile(qrPath, signUrl, { width: 250, margin: 1, color: { dark: '#000000', light: '#ffffff' } });

    const signedDir = path.join(__dirname, '..', '..', 'uploads', 'signed');
    if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });

    const ext = path.extname(originalname).toLowerCase();

    const docLabel = (display_name && display_name.trim()) ? display_name.trim() : path.parse(originalname).name;

    if (ext === '.pdf') {
      try {
        const pdfDoc = await PDFDocument.load(fileData, { ignoreEncryption: true });
        const qrImgBytes = fs.readFileSync(qrPath);
        const qrImage = await pdfDoc.embedPng(qrImgBytes);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        const pages = pdfDoc.getPages();
        const pageIndex = parseInt(page_num) || 0;
        const targetPage = pages[pageIndex] || pages[0];
        const { width: pdfPageW, height: pdfPageH } = targetPage.getSize();

        const qrSizeVal = Math.max(40, Math.min(150, parseFloat(qr_size) || 80));
        const px = parseFloat(pos_x) || 0;
        const py = parseFloat(pos_y) || 0;
        const cW = parseFloat(canvas_w) || pdfPageW;
        const cH = parseFloat(canvas_h) || pdfPageH;

        const scaleX = pdfPageW / cW;
        const scaleY = pdfPageH / cH;

        const signX = px * scaleX;
        const signY = pdfPageH - (py * scaleY) - qrSizeVal;

        const drawX = Math.max(0, Math.min(signX, pdfPageW - qrSizeVal));
        const drawY = Math.max(0, Math.min(signY, pdfPageH - qrSizeVal));

        targetPage.drawImage(qrImage, {
          x: drawX,
          y: drawY,
          width: qrSizeVal,
          height: qrSizeVal,
        });

        const signedByText = signerOrg
          ? `${signerName} - ${signerOrg}`
          : signerName;

        targetPage.drawText(`Ditandatangani: ${signedByText}`, {
          x: drawX,
          y: Math.max(0, drawY - 14),
          size: 7,
          font,
          color: rgb(0.2, 0.2, 0.2),
        });
        targetPage.drawText(new Date().toLocaleString('id-ID'), {
          x: drawX,
          y: Math.max(0, drawY - 24),
          size: 6,
          font,
          color: rgb(0.4, 0.4, 0.4),
        });

        const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

        try {
          const settings = res.locals.settings || {};
          const appName = settings.site_name || 'DigiSign';
          const dateStr = new Date().toLocaleString('id-ID');
          const wmX = 10, wmY = 10;
          const lines = [
            `Dokumen ini ditandatangani secara digital menggunakan ${appName}.`,
            `Ditandatangani pada: ${dateStr}`
          ];
          const fontSize = 7;
          const lineGap = 10;
          const paddingX = 6, paddingY = 4;
          let maxW = 0;
          for (const l of lines) {
            const w = font.widthOfTextAtSize(l, fontSize);
            if (w > maxW) maxW = w;
          }
          const boxW = maxW + paddingX * 2;
          const boxH = lines.length * lineGap + paddingY * 2;
          targetPage.drawRectangle({
            x: wmX, y: wmY, width: boxW, height: boxH,
            color: rgb(1, 1, 1),
            borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 0.5,
          });
          lines.forEach((l, i) => {
            targetPage.drawText(l, {
              x: wmX + paddingX, y: wmY + boxH - paddingY - fontSize - (i * lineGap),
              size: fontSize, font, color: rgb(0.15, 0.15, 0.15),
            });
          });
        } catch (wmErr) {}

        try {
          const sigDictRef = pdfDoc.context.register(pdfDoc.context.obj({
            Filter: PDFName.of('Adobe.PPKLite'),
            SubFilter: PDFName.of('adbe.pkcs7.detached'),
            ByteRange: pdfDoc.context.obj([PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0)]),
            Contents: PDFHexString.of('0'.repeat(4096)),
            Name: PDFString.of(signedByText),
            Reason: PDFString.of('Digital Signature'),
            M: PDFString.of(`D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`),
          }));

          const widgetDictRef = pdfDoc.context.register(pdfDoc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Widget'),
            FT: PDFName.of('Sig'),
            T: PDFString.of('DigiSign'),
            V: sigDictRef,
            Rect: pdfDoc.context.obj([
              PDFNumber.of(Math.round(drawX)),
              PDFNumber.of(Math.round(drawY)),
              PDFNumber.of(Math.round(drawX + qrSizeVal)),
              PDFNumber.of(Math.round(drawY + qrSizeVal))
            ]),
            F: PDFNumber.of(4),
            P: targetPage.ref,
          }));

          const existingAnnots = targetPage.node.get(PDFName.of('Annots'));
          if (existingAnnots && typeof existingAnnots.push === 'function') {
            existingAnnots.push(widgetDictRef);
          } else {
            targetPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj([widgetDictRef]));
          }

          pdfDoc.catalog.set(PDFName.of('AcroForm'), pdfDoc.context.obj({
            SigFlags: PDFNumber.of(3),
            Fields: pdfDoc.context.obj([widgetDictRef]),
            NeedAppearances: pdfDoc.context.obj(true),
          }));
        } catch (formErr) {
          console.error('Could not add signature form field:', formErr.message);
        }

        const pdfBytes = await pdfDoc.save({ useObjectStreams: false });

        const signedFilename = `${docLabel}_signed.pdf`;
        const signedPath = path.join(signedDir, signedFilename);

        const pdfStr = Buffer.from(pdfBytes).toString('latin1');
        const hasByteRange = /\/ByteRange/.test(pdfStr);
        const hasContents = /\/Contents\s*<[\da-fA-F]+>/.test(pdfStr);
        const debugLog = `PAdES check: ByteRange=${hasByteRange}, Contents=${hasContents}, ext=${ext}\n`;
        fs.appendFileSync(path.join(__dirname, '..', '..', 'debug.log'), debugLog);
        console.log(`PAdES check: ByteRange=${hasByteRange}, Contents=${hasContents}`);

        let finalSignedBytes;
        if (hasByteRange && hasContents) {
          try {
            const { p12, password } = getCertificate();
            fs.appendFileSync(path.join(__dirname, '..', '..', 'debug.log'), `Calling signPdfWithPades, p12 size=${p12.length}\n`);
            finalSignedBytes = await signPdfWithPades(pdfBytes, p12, password);
            const successLog = `PAdES forge CMS SUCCESS, size: ${finalSignedBytes.length}\n`;
            fs.appendFileSync(path.join(__dirname, '..', '..', 'debug.log'), successLog);
            console.log('PAdES forge CMS SUCCESS, size:', finalSignedBytes.length);
          } catch (padesErr) {
            const errLog = `PAdES forge CMS FAILED: ${padesErr.message}\n${padesErr.stack}\n`;
            fs.appendFileSync(path.join(__dirname, '..', '..', 'debug.log'), errLog);
            console.error('PAdES forge CMS FAILED:', padesErr.message);
            finalSignedBytes = pdfBytes;
          }
        } else {
          console.warn('ByteRange/Contents NOT found in pdf-lib output');
          finalSignedBytes = pdfBytes;
        }

        fs.writeFileSync(signedPath, finalSignedBytes);

        const signedFileHash = crypto.createHash('sha256').update(finalSignedBytes).digest('hex');

        const origDir = path.join(__dirname, '..', '..', 'uploads', 'originals');
        if (!fs.existsSync(origDir)) fs.mkdirSync(origDir, { recursive: true });
        const origExt = path.extname(originalname).toLowerCase();
        try { fs.renameSync(filePath, path.join(origDir, `${token}_original${origExt}`)); } catch (e) {}

        const result = db.prepare(
          'INSERT INTO signatures (user_id, key_id, signer_id, token, document_name, document_hash, signature, qr_code, signed_file, signed_file_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(req.session.user.id, signerRecord ? 0 : key.id, signerRecord ? signerRecord.id : null, token, docLabel, docHash, signatureB64, qrFilename, signedFilename, signedFileHash);

        const sigId = db.prepare('SELECT MAX(id) as id FROM signatures').get()?.id || 0;
        if (req.body.guest_doc_id) {
          if (String(req.body.guest_doc_id).startsWith('letter_')) {
            const letterId = parseInt(String(req.body.guest_doc_id).replace('letter_', ''));
            db.prepare("UPDATE generated_letters SET status = 'signed', signature_id = ?, signed_file = ? WHERE id = ?")
              .run(sigId, signedFilename, letterId);
          } else {
            db.prepare("UPDATE guest_docs SET status = 'signed', signature_id = ?, signed_file = ? WHERE id = ?")
              .run(sigId, signedFilename, req.body.guest_doc_id);
          }
        }

        try { fs.unlinkSync(qrPath); } catch (e) {}

        res.json({ success: true, signed_filename: signedFilename, sign_url: signUrl, message: 'Dokumen berhasil ditandatangani' });
      } catch (pdfErr) {
        console.error('PDF sign error:', pdfErr);
        res.status(500).json({ error: 'Gagal memproses PDF: ' + pdfErr.message });
      }
    } else {
      const signedFilename = qrFilename;
      const signedPath = path.join(signedDir, qrFilename);
      fs.copyFileSync(qrPath, signedPath);

      const signedFileHash = crypto.createHash('sha256').update(fs.readFileSync(signedPath)).digest('hex');

      const origDir = path.join(__dirname, '..', '..', 'uploads', 'originals');
      if (!fs.existsSync(origDir)) fs.mkdirSync(origDir, { recursive: true });
      try { fs.renameSync(filePath, path.join(origDir, `${token}_original${ext}`)); } catch (e) {}

      const result2 = db.prepare(
        'INSERT INTO signatures (user_id, key_id, signer_id, token, document_name, document_hash, signature, qr_code, signed_file, signed_file_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.session.user.id, signerRecord ? 0 : key.id, signerRecord ? signerRecord.id : null, token, docLabel, docHash, signatureB64, qrFilename, signedFilename, signedFileHash);

      const sigId2 = db.prepare('SELECT MAX(id) as id FROM signatures').get()?.id || 0;
      if (req.body.guest_doc_id) {
        if (String(req.body.guest_doc_id).startsWith('letter_')) {
          const letterId = parseInt(String(req.body.guest_doc_id).replace('letter_', ''));
          db.prepare("UPDATE generated_letters SET status = 'signed', signature_id = ?, signed_file = ? WHERE id = ?")
            .run(sigId2, signedFilename, letterId);
        } else {
          db.prepare("UPDATE guest_docs SET status = 'signed', signature_id = ?, signed_file = ? WHERE id = ?")
            .run(sigId2, signedFilename, req.body.guest_doc_id);
        }
      }

      try { fs.unlinkSync(qrPath); } catch (e) {}

      res.json({ success: true, signed_filename: signedFilename, sign_url: signUrl, message: 'Tanda tangan QR berhasil disimpan' });
    }
  } catch (e) {
    console.error('Apply sign error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/download/:id', (req, res) => {
  const db = getDB();
  const sig = db.prepare('SELECT * FROM signatures WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!sig) return res.status(404).send('Signature not found');

  const content = JSON.stringify({
    document_name: sig.document_name,
    document_hash: sig.document_hash,
    signature: sig.signature,
    signed_at: sig.signed_at,
    algorithm: 'RSA-2048/SHA-256'
  }, null, 2);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${sig.document_name}.signature.json"`);
  res.send(content);
});

router.get('/download-signed/:id', (req, res) => {
  const db = getDB();
  const sig = db.prepare('SELECT * FROM signatures WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!sig || !sig.signed_file) return res.status(404).send('Signed file not found');

  const signedDir = path.join(__dirname, '..', '..', 'uploads', 'signed');
  const qrDir = path.join(__dirname, '..', '..', 'uploads', 'qr');
  let filePath = path.join(signedDir, sig.signed_file);
  if (!fs.existsSync(filePath)) filePath = path.join(qrDir, sig.signed_file);
  if (!fs.existsSync(filePath)) return res.status(404).send('File tidak ditemukan');

  const ext = path.extname(sig.document_name).toLowerCase();
  const downloadName = ext === '.pdf'
    ? `${path.parse(sig.document_name).name}_signed.pdf`
    : sig.qr_code || 'qrcode.png';

  res.download(filePath, downloadName);
});

module.exports = router;
