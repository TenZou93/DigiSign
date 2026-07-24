const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

const ROMAWI = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

function bulanRomawi(n) { return ROMAWI[(n - 1) % 12] || 'I'; }

function generateDocxPDF(templatePath, formData, options = {}) {
  return new Promise((resolve, reject) => {
    let PizZip, Docxtemplater;
    try {
      PizZip = require('pizzip');
      Docxtemplater = require('docxtemplater');
    } catch (e) {
      return reject(new Error('docxtemplater/pizzip belum diinstall. Jalankan: npm install docxtemplater pizzip'));
    }

    let content;
    try {
      content = fs.readFileSync(templatePath, 'binary');
    } catch (e) {
      return reject(new Error('File template .docx tidak ditemukan: ' + templatePath));
    }

    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    const mergedData = { ...formData };
    const now = new Date();
    if (options.tanggal) mergedData.tanggal = options.tanggal;
    mergedData.bulan = now.toLocaleDateString('id-ID', { month: 'long' });
    mergedData.tahun = String(now.getFullYear());
    mergedData.bulan_angka = String(now.getMonth() + 1).padStart(2, '0');
    mergedData.bulan_romawi = bulanRomawi(now.getMonth() + 1);
    if (options.nomor_surat) mergedData.nomor_surat = options.nomor_surat;
    if (options.pejabat_nama) mergedData.pejabat_nama = options.pejabat_nama;
    if (options.pejabat_jabatan) mergedData.pejabat_jabatan = options.pejabat_jabatan;

    try {
      doc.render(mergedData);
    } catch (e) {
      return reject(new Error('Gagal merge data ke .docx: ' + e.message));
    }

    const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });

    const mergedPath = path.join(
      path.dirname(templatePath),
      'merged_' + path.basename(templatePath)
    );
    try { fs.writeFileSync(mergedPath, buf); } catch (e) {
      return reject(new Error('Gagal menulis file hasil merge: ' + e.message));
    }

    const pdfPath = mergedPath.replace(/\.docx$/i, '.pdf');

    const cmd = process.platform === 'win32'
      ? `"${process.env.LIBREOFFICE_PATH || 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'}" --headless --convert-to pdf:"writer_pdf_Export:{'EmbedStandardFonts':true,'ExportEmbeddedFonts':true}" --outdir "${path.dirname(pdfPath)}" "${mergedPath}"`
      : `libreoffice --headless --convert-to pdf:"writer_pdf_Export:{'EmbedStandardFonts':true,'ExportEmbeddedFonts':true}" --outdir "${path.dirname(pdfPath)}" "${mergedPath}"`;

    exec(cmd, { timeout: 60000 }, async (err, stdout, stderr) => {
      if (err) {
        try { fs.unlinkSync(mergedPath); } catch (e2) {}
        return reject(new Error('Gagal convert ke PDF. Pastikan LibreOffice terinstall. Error: ' + (stderr || err.message)));
      }
      if (!fs.existsSync(pdfPath)) {
        try { fs.unlinkSync(mergedPath); } catch (e2) {}
        return reject(new Error('File PDF tidak ditemukan setelah konversi'));
      }

      try {
        const rawPdf = fs.readFileSync(pdfPath);
        const result = await ensureA4(rawPdf);
        try { fs.unlinkSync(mergedPath); } catch (e2) {}
        try { fs.unlinkSync(pdfPath); } catch (e2) {}
        resolve(result);
      } catch (e) {
        try { fs.unlinkSync(mergedPath); } catch (e2) {}
        try { fs.unlinkSync(pdfPath); } catch (e2) {}
        reject(new Error('Gagal post-process PDF ke A4: ' + e.message));
      }
    });
  });
}

async function ensureA4(pdfBuffer) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  let needsResize = false;
  for (const page of pages) {
    const { width, height } = page.getSize();
    if (Math.abs(width - A4_WIDTH) > 2 || Math.abs(height - A4_HEIGHT) > 2) {
      needsResize = true;
      break;
    }
  }
  if (!needsResize) return pdfBuffer;

  const a4Doc = await PDFDocument.create();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const scale = Math.min(A4_WIDTH / width, A4_HEIGHT / height);
    const embed = await a4Doc.embedPage(page, {
      left: 0, right: width, bottom: 0, top: height,
      transform: [scale, 0, 0, scale, (A4_WIDTH - width * scale) / 2, (A4_HEIGHT - height * scale) / 2]
    });
    const newPage = a4Doc.addPage([A4_WIDTH, A4_HEIGHT]);
    newPage.drawPage(embed);
  }
  return Buffer.from(await a4Doc.save());
}

module.exports = { generateDocxPDF };
