const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

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
    if (options.tanggal) mergedData.tanggal = options.tanggal;
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
      ? `"${process.env.LIBREOFFICE_PATH || 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'}" --headless --convert-to pdf --outdir "${path.dirname(pdfPath)}" "${mergedPath}"`
      : `libreoffice --headless --convert-to pdf --outdir "${path.dirname(pdfPath)}" "${mergedPath}"`;

    exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        try { fs.unlinkSync(mergedPath); } catch (e2) {}
        return reject(new Error('Gagal convert ke PDF. Pastikan LibreOffice terinstall. Error: ' + (stderr || err.message)));
      }
      if (!fs.existsSync(pdfPath)) {
        try { fs.unlinkSync(mergedPath); } catch (e2) {}
        return reject(new Error('File PDF tidak ditemukan setelah konversi'));
      }
      const pdfBuffer = fs.readFileSync(pdfPath);
      try { fs.unlinkSync(mergedPath); } catch (e2) {}
      try { fs.unlinkSync(pdfPath); } catch (e2) {}
      resolve(pdfBuffer);
    });
  });
}

module.exports = { generateDocxPDF };
