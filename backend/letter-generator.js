const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const testLine = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(testLine, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = testLine;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function generateLetterPDF(template, formData, options = {}) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const fontHelvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontHelveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612;
  const pageHeight = 792;
  const marginLeft = 60;
  const marginRight = 60;
  const marginTop = 40;
  const marginBottom = 40;
  const contentWidth = pageWidth - marginLeft - marginRight;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - marginTop;

  function drawText(text, x, yPos, opts = {}) {
    const f = opts.bold ? fontBold : font;
    const size = opts.fontSize || 11;
    const align = opts.align || 'left';
    const maxW = opts.maxWidth || contentWidth;
    const color = opts.color || rgb(0, 0, 0);

    let lines;
    if (opts.wrap !== false) {
      lines = wrapText(text, f, size, maxW);
    } else {
      lines = [text];
    }

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

  function spacer(height) {
    y -= height;
  }

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
  // Logo area (left)
  const logoTextLines = [
    'LOGO',
    'IIK NU TUBAN'
  ];
  y = drawText(logoTextLines.join('\n'), marginLeft, y, { fontSize: 16, bold: true, wrap: false });

  // Right side: institution info
  const institusiLines = [
    'KEMENTERIAN PENDIDIKAN, KEBUDAYAAN, RISET, DAN TEKNOLOGI',
    'INSTITUT ILMU KESEHATAN NAHDLATUL ULAMA TUBAN',
    'Jl. Cendrawasih No. 31 Tuban - Jawa Timur',
    'Telp. (0356) 321456, Website: www.iiknujatim.ac.id'
  ];
  y = drawText(institusiLines.join('\n'), marginLeft, y, { fontSize: 9, maxWidth: contentWidth, align: 'center' });
  y += 4;
  drawLine(marginLeft, y, pageWidth - marginRight, y, { thickness: 3 });
  y -= 4;
  drawLine(marginLeft, y, pageWidth - marginRight, y, { thickness: 1 });
  y -= 20;

  // --- TITLE ---
  checkPage();
  y = drawText('SURAT KETERANGAN', marginLeft, y, { fontSize: 14, bold: true, align: 'center' });
  y = drawText('Nomor: ' + (data.nomor_surat || options.nomor || 'IIK/UN.01/SK/' + Date.now()), marginLeft, y, { fontSize: 10, align: 'center' });
  spacer(15);

  // --- OPENING ---
  y = drawText('Yang bertanda tangan di bawah ini:', marginLeft, y, { fontSize: 11 });
  spacer(8);
  y = drawText(options.pejabat_nama || 'Nama Pejabat', marginLeft, y, { bold: true, fontSize: 11 });
  y = drawText(options.pejabat_jabatan || 'Jabatan', marginLeft, y, { fontSize: 11 });
  spacer(10);

  y = drawText('Menerangkan bahwa:', marginLeft, y, { fontSize: 11 });
  spacer(8);

  // --- MAHASISWA DATA ---
  const fields = [
    { label: 'Nama', value: data.nama },
    { label: 'NIM', value: data.nim },
    { label: 'Program Studi', value: data.prodi },
    { label: 'Semester', value: data.semester },
  ];
  for (const f of fields) {
    const line = `${f.label}\t: ${f.value || '-'}`;
    y = drawText(line, marginLeft, y, { fontSize: 11, maxWidth: contentWidth, wrap: true });
  }
  spacer(10);

  y = drawText(`Adalah benar mahasiswa aktif pada Program Studi ${data.prodi || '-'} Institut Ilmu Kesehatan Nahdlatul Ulama Tuban.`, marginLeft, y, { fontSize: 11 });
  spacer(8);

  y = drawText(`Surat ini dibuat untuk keperluan ${data.keperluan || '-'}.`, marginLeft, y, { fontSize: 11 });
  spacer(10);

  // --- CLOSING ---
  y = drawText('Demikian surat keterangan ini dibuat dengan sebenarnya untuk digunakan sebagaimana mestinya.', marginLeft, y, { fontSize: 11 });
  spacer(30);

  // --- DATE ---
  checkPage();
  y = drawText('Tuban, ' + dateStr, marginLeft, y, { fontSize: 11, align: 'right' });
  spacer(5);

  // --- SIGNATURE ---
  checkPage();
  y = drawText('An. Rektor', marginLeft, y, { fontSize: 11, align: 'center' });
  y = drawText(options.pejabat_jabatan || 'Wakil Rektor III', marginLeft, y, { fontSize: 11, align: 'center' });
  spacer(40);
  y = drawText(options.pejabat_nama || '[Nama Pejabat]', marginLeft, y, { bold: true, fontSize: 11, align: 'center' });
  y = drawText(options.pejabat_nip || 'NIP. ..........................', marginLeft, y, { fontSize: 10, align: 'center' });

  // --- TTD ---
  spacer(15);
  y = drawText('Tanda Tangan Digital', marginLeft, y, { fontSize: 9, color: rgb(0.5, 0.5, 0.5), align: 'center' });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { generateLetterPDF };
