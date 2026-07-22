const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const pdfPath = path.join(__dirname, '..', 'uploads', 'signed');
const signedFiles = fs.readdirSync(pdfPath).filter(f => f.endsWith('_signed.pdf'));

if (signedFiles.length === 0) {
  console.log('No signed PDFs found in uploads/signed/');
  process.exit(1);
}

const latestFile = process.argv[2] || signedFiles.sort().pop();
const pdfBuffer = fs.readFileSync(path.join(pdfPath, latestFile));
const pdfStr = pdfBuffer.toString('latin1');

console.log('File:', latestFile);
console.log('Size:', pdfBuffer.length, 'bytes');

const hexMatch = pdfStr.match(/\/Contents\s*<([0-9a-fA-F]+)>/);
if (!hexMatch) {
  const contentsIdx = pdfStr.indexOf('/Contents');
  if (contentsIdx !== -1) {
    console.log('Found /Contents at index:', contentsIdx);
    console.log('Context around /Contents:', JSON.stringify(pdfStr.substring(contentsIdx, contentsIdx + 200)));
  } else {
    console.log('/Contents NOT FOUND in file at all');
  }
  console.log('\nSearching for ByteRange...');
  const brIdx = pdfStr.indexOf('/ByteRange');
  if (brIdx !== -1) {
    console.log('Found /ByteRange at index:', brIdx);
    console.log('Context:', JSON.stringify(pdfStr.substring(brIdx, brIdx + 100)));
  } else {
    console.log('/ByteRange NOT FOUND');
  }
  console.log('\nSearching for signature markers...');
  console.log('Adobe.PPKLite:', pdfStr.includes('Adobe.PPKLite'));
  console.log('pkcs7.detached:', pdfStr.includes('pkcs7.detached'));
  console.log('SigFlags:', pdfStr.includes('SigFlags'));
  console.log('AcroForm:', pdfStr.includes('AcroForm'));
  process.exit(1);
}

const hexContent = hexMatch[1];
console.log('\n=== Contents Hex ===');
console.log('Length:', hexContent.length, 'hex chars');
console.log('First 100:', hexContent.substring(0, 100));
console.log('Last 100:', hexContent.substring(hexContent.length - 100));

const brMatch = pdfStr.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
if (!brMatch) {
  console.log('ERROR: /ByteRange not found');
  process.exit(1);
}

const byteRange = [parseInt(brMatch[1]), parseInt(brMatch[2]), parseInt(brMatch[3]), parseInt(brMatch[4])];
console.log('\n=== ByteRange ===');
console.log('[' + byteRange.join(' ') + ']');

const seg1Len = byteRange[1];
const seg2Start = byteRange[2];
const seg2Len = byteRange[3];
console.log('Segment 1: bytes 0 to', seg1Len - 1, '(', seg1Len, 'bytes)');
console.log('Segment 2: bytes', seg2Start, 'to', seg2Start + seg2Len - 1, '(', seg2Len, 'bytes)');
console.log('Total signed:', seg1Len + seg2Len);

const hexBytes = hexContent.length / 2;
console.log('Signature (hex->bytes):', hexBytes, 'bytes');

const derBytes = [];
for (let i = 0; i < hexContent.length; i += 2) {
  const byte = parseInt(hexContent.substring(i, i + 2), 16);
  if (byte !== 0) derBytes.push(byte);
}

console.log('\n=== CMS Structure ===');
if (derBytes.length === 0) {
  console.log('ERROR: CMS signature is ALL ZEROS!');
} else {
  const firstNonZero = hexContent.indexOf(/[^0]/);
  const lastNonZero = hexContent.length - 1 - [...hexContent].reverse().join('').indexOf(/[^0]/);
  console.log('First non-zero at hex pos:', firstNonZero);
  console.log('Last non-zero at hex pos:', lastNonZero);
  console.log('Non-zero content:', (lastNonZero - firstNonZero + 1), 'hex chars =', (lastNonZero - firstNonZero + 1) / 2, 'bytes');
  console.log('Trailing zeros:', (hexContent.length - lastNonZero - 1), 'hex chars');

  try {
    const derHex = hexContent.substring(firstNonZero, lastNonZero + 1);
    const derStr = derHex.match(/.{2}/g).map(h => String.fromCharCode(parseInt(h, 16))).join('');
    const asn1 = forge.asn1.fromDer(derStr);
    console.log('\nASN.1 structure parsed OK');
    console.log('Type:', asn1.type);
    console.log('Constructed:', asn1.constructed);
    console.log('Content length:', asn1.value.length);

    if (asn1.value.length > 0) {
      const firstByte = asn1.value.charCodeAt(0);
      console.log('First content byte:', '0x' + firstByte.toString(16));

      if (firstByte === 0x30) {
        console.log('-> SEQUENCE (ContentInfo wrapper)');
        const contentInfo = forge.asn1.fromDer(asn1.value);
        console.log('ContentInfo parsed OK');
        console.log('ContentInfo content length:', contentInfo.value.length);
      }
    }
  } catch (e) {
    console.log('ERROR parsing ASN.1:', e.message);
  }
}

console.log('\n=== Signature Field Check ===');
const hasAcroForm = pdfStr.includes('/AcroForm');
const hasSigFlags = pdfStr.includes('/SigFlags');
const hasSigDict = pdfStr.includes('/Filter /Adobe.PPKLite');
const hasSubFilter = pdfStr.includes('/SubFilter /adbe.pkcs7.detached');
const hasWidget = pdfStr.includes('/FT /Sig');

console.log('AcroForm:', hasAcroForm);
console.log('SigFlags:', hasSigFlags);
console.log('Filter /Adobe.PPKLite:', hasSigDict);
console.log('SubFilter /adbe.pkcs7.detached:', hasSubFilter);
console.log('Widget /FT /Sig:', hasWidget);
