const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const path = require('path');
const fs = require('fs');

function wrapText(text, font, fontSize, maxWidth) {
  const rawLines = text.split('\n');
  const result = [];
  for (const raw of rawLines) {
    const words = raw.split(' ');
    let line = '';
    for (const word of words) {
      const testLine = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(testLine, fontSize) > maxWidth) {
        if (line) result.push(line);
        line = word;
      } else {
        line = testLine;
      }
    }
    if (line) result.push(line);
  }
  return result;
}

async function generateLetterPDF(template, formData, options = {}) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  const pageWidth = 612;
  const pageHeight = 792;

  let margins = [60, 40, 60, 40];
  try { if (template.default_margins) margins = JSON.parse(template.default_margins); } catch (e) {}
  const [marginLeft, marginTop, marginRight, marginBottom] = margins;

  let styles = {};
  try { if (template.styles) styles = JSON.parse(template.styles); } catch (e) {}

  const bodySize = styles.bodyFontSize || 11;
  const kopSize = styles.kopFontSize || 9;
  const titleSize = styles.titleFontSize || 14;
  const sigSize = styles.signatureFontSize || 11;

  const contentWidth = pageWidth - marginLeft - marginRight;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - marginTop;

  function drawText(text, x, yPos, opts = {}) {
    const f = opts.bold ? fontBold : font;
    const size = opts.fontSize || bodySize;
    const align = opts.align || 'left';
    const maxW = opts.maxWidth || contentWidth;
    const color = opts.color || rgb(0, 0, 0);

    const lines = wrapText(text, f, size, maxW);

    let curX = x;
    for (const line of lines) {
      const lineW = f.widthOfTextAtSize(line, size);
      if (align === 'center') curX = x + (maxW - lineW) / 2;
      else if (align === 'right') curX = x + maxW - lineW;
      page.drawText(line, { x: curX, y: yPos, size, font: f, color });
      yPos -= size * 1.4;
    }
    return yPos;
  }

  function drawLine(x1, y1, x2, y2, opts = {}) {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: opts.thickness || 1, color: opts.color || rgb(0, 0, 0) });
  }

  function spacer(height) { y -= height; }

  function checkPage() {
    if (y < marginBottom + 60) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - marginTop;
      return true;
    }
    return false;
  }

  const dateStr = options.date || new Date().toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });
  const data = formData;

  // --- KOP SURAT ---
  const kopKiri = template.kop_kiri || 'IIK NU TUBAN';
  const kopKanan = template.kop_kanan || '';
  const logoPath = template.logo_path
    ? path.join(__dirname, '..', '..', template.logo_path)
    : null;

  // Logo (if exists and file exists)
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      const logoBytes = fs.readFileSync(logoPath);
      const ext = path.extname(logoPath).toLowerCase();
      let logoImg;
      if (ext === '.png') logoImg = await pdfDoc.embedPng(logoBytes);
      else logoImg = await pdfDoc.embedJpg(logoBytes);
      const logoDims = logoImg.scale(0.15);
      page.drawImage(logoImg, { x: marginLeft, y: y - logoDims.height, width: logoDims.width, height: logoDims.height });
      y -= logoDims.height + 4;
    } catch (e) {
      y = drawText('[Logo]', marginLeft, y, { fontSize: 14, bold: true });
    }
  } else {
    y = drawText(kopKiri, marginLeft, y, { fontSize: 14, bold: true });
  }

  // Kop kanan
  if (kopKanan) {
    const kananLines = kopKanan.split('\n');
    for (const line of kananLines) {
      y = drawText(line, marginLeft, y, { fontSize: kopSize, maxWidth: contentWidth, align: 'center' });
    }
  }
  spacer(4);
  drawLine(marginLeft, y, pageWidth - marginRight, y, { thickness: 3 });
  spacer(1);
  drawLine(marginLeft, y, pageWidth - marginRight, y, { thickness: 1 });
  spacer(20);

  // --- TITLE ---
  checkPage();
  y = drawText('SURAT KETERANGAN', marginLeft, y, { fontSize: titleSize, bold: true, align: 'center' });
  y = drawText('Nomor: ' + (data.nomor_surat || options.nomor || 'IIK/UN.01/SK/' + Date.now()), marginLeft, y, { fontSize: kopSize, align: 'center' });
  spacer(15);

  // --- OPENING ---
  y = drawText('Yang bertanda tangan di bawah ini:', marginLeft, y, { fontSize: bodySize });
  spacer(8);
  y = drawText(template.pejabat_nama || 'Nama Pejabat', marginLeft, y, { bold: true, fontSize: bodySize });
  y = drawText(template.pejabat_jabatan || 'Jabatan', marginLeft, y, { fontSize: bodySize });
  spacer(10);

  y = drawText('Menerangkan bahwa:', marginLeft, y, { fontSize: bodySize });
  spacer(8);

  // --- MAHASISWA DATA ---
  const fields = [
    { label: 'Nama', value: data.nama },
    { label: 'NIM', value: data.nim },
    { label: 'Program Studi', value: data.prodi },
    { label: 'Semester', value: data.semester },
  ];
  for (const f of fields) {
    const line = f.label + ' : ' + (f.value || '-');
    y = drawText(line, marginLeft, y, { fontSize: bodySize });
  }
  spacer(10);

  y = drawText('Adalah benar mahasiswa aktif pada Program Studi ' + (data.prodi || '-') + ' ' + (kopKiri || 'Institut Ilmu Kesehatan Nahdlatul Ulama Tuban') + '.', marginLeft, y, { fontSize: bodySize });
  spacer(8);
  y = drawText('Surat ini dibuat untuk keperluan ' + (data.keperluan || '-') + '.', marginLeft, y, { fontSize: bodySize });
  spacer(10);

  // --- CLOSING ---
  y = drawText('Demikian surat keterangan ini dibuat dengan sebenarnya untuk digunakan sebagaimana mestinya.', marginLeft, y, { fontSize: bodySize });
  spacer(30);

  // --- DATE ---
  checkPage();
  y = drawText('Tuban, ' + dateStr, marginLeft, y, { fontSize: bodySize, align: 'right' });
  spacer(5);

  // --- SIGNATURE ---
  checkPage();
  y = drawText('An. Rektor', marginLeft, y, { fontSize: bodySize, align: 'center' });
  y = drawText(template.pejabat_jabatan || 'Wakil Rektor III', marginLeft, y, { fontSize: bodySize, align: 'center' });
  spacer(40);
  y = drawText(template.pejabat_nama || '[Nama Pejabat]', marginLeft, y, { bold: true, fontSize: sigSize, align: 'center' });
  y = drawText(template.pejabat_nip || 'NIP. ..........................', marginLeft, y, { fontSize: kopSize, align: 'center' });

  // --- TTD ---
  spacer(15);
  y = drawText('Tanda Tangan Digital', marginLeft, y, { fontSize: kopSize, color: rgb(0.5, 0.5, 0.5), align: 'center' });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { generateLetterPDF };
