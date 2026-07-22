const forge = require('node-forge');
const crypto = require('crypto');
const http = require('http');

const TSA_URL = 'http://timestamp.digicert.com';

function encodeDerLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  const buf = Buffer.alloc(3);
  buf[0] = 0x82;
  buf.writeUInt16BE(len, 1);
  return buf;
}

function encodeDerOid(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val < 0x80) { bytes.push(val); continue; }
    const tmp = [];
    while (val > 0) { tmp.unshift(val & 0x7f); val >>= 7; }
    for (let j = 0; j < tmp.length - 1; j++) tmp[j] |= 0x80;
    bytes.push(...tmp);
  }
  return Buffer.concat([Buffer.from([0x06, bytes.length]), Buffer.from(bytes)]);
}

function buildDerSequence() {
  const content = Buffer.concat(Array.from(arguments));
  return Buffer.concat([Buffer.from([0x30]), encodeDerLength(content.length), content]);
}

function buildDerOctetString(data) {
  return Buffer.concat([Buffer.from([0x04]), encodeDerLength(data.length), data]);
}

function queryTSA(signatureHash) {
  return new Promise((resolve, reject) => {
    const messageImprint = buildDerSequence(
      buildDerSequence(
        encodeDerOid('2.16.840.1.101.3.4.2.1'),
        Buffer.from([0x05, 0x00])
      ),
      buildDerOctetString(signatureHash)
    );
    const nonce = crypto.randomBytes(4);
    const req = buildDerSequence(
      Buffer.from([0x02, 0x01, 0x01]),
      messageImprint,
      Buffer.concat([Buffer.from([0x02, 0x04]), nonce]),
      Buffer.from([0x01, 0x01, 0xff])
    );
    const url = new URL(TSA_URL);
    const options = {
      hostname: url.hostname, port: 80, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query', 'Content-Length': req.length }
    };
    const httpReq = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const resp = Buffer.concat(chunks);
        if (resp[0] === 0x30) resolve(resp);
        else reject(new Error(`TSA error: status=${res.statusCode}`));
      });
    });
    httpReq.setTimeout(15000, () => { httpReq.destroy(); reject(new Error('TSA timeout')); });
    httpReq.on('error', reject);
    httpReq.write(req);
    httpReq.end();
  });
}

function parseDerNode(buf, offset) {
  if (offset >= buf.length) return null;
  const tag = buf[offset];
  let pos = offset + 1;
  let length = 0;
  let headerLen = 1;
  const lenByte = buf[pos];
  if (lenByte < 0x80) {
    length = lenByte;
    headerLen = 2;
  } else if (lenByte === 0x80) {
    throw new Error('Indefinite length');
  } else {
    const numBytes = lenByte & 0x7f;
    for (let i = 0; i < numBytes; i++) {
      length = (length << 8) | buf[pos + 1 + i];
    }
    headerLen = 1 + 1 + numBytes;
  }
  const isPrimitive = (tag & 0x20) === 0;
  const contentStart = offset + headerLen;
  const totalLen = headerLen + length;

  const node = { tag, offset, headerLen, contentStart, length, totalLen, children: [] };
  if (!isPrimitive && length > 0) {
    let childOffset = contentStart;
    while (childOffset < contentStart + length) {
      const child = parseDerNode(buf, childOffset);
      if (!child) break;
      node.children.push(child);
      childOffset += child.totalLen;
    }
  }
  return node;
}

function buildUnsignedAttrBytes(tsaToken) {
  const tsaAttrType = encodeDerOid('1.2.840.113549.1.9.16.2.14');
  const tsaAttrValue = buildDerOctetString(tsaToken);
  const tsaAttrValueWrapped = Buffer.concat([
    Buffer.from([0x31]), encodeDerLength(tsaAttrValue.length), tsaAttrValue
  ]);
  const tsaAttr = Buffer.concat([
    Buffer.from([0x30]), encodeDerLength(tsaAttrType.length + tsaAttrValueWrapped.length),
    tsaAttrType, tsaAttrValueWrapped
  ]);
  return Buffer.concat([
    Buffer.from([0xa1]), encodeDerLength(tsaAttr.length), tsaAttr
  ]);
}

function addUnsignedAttrsToCms(cmsDer, tsaToken) {
  const unsignedAttrs = buildUnsignedAttrBytes(tsaToken);
  const root = parseDerNode(Buffer.from(cmsDer), 0);
  const contentInfo = root;
  const signedData = contentInfo.children[1].children[0];
  const signerInfosSet = signedData.children[signedData.children.length - 1];
  const signerInfo = signerInfosSet.children[0];

  let sigValueNode = null;
  for (const child of signerInfo.children) {
    if (child.tag === 0x04) sigValueNode = child;
  }
  if (!sigValueNode) throw new Error('Signature OCTET STRING not found');

  const insertOffset = sigValueNode.offset + sigValueNode.totalLen;

  const before = cmsDer.slice(0, insertOffset);
  const after = cmsDer.slice(insertOffset);
  const newCms = Buffer.concat([before, unsignedAttrs, after]);

  const sizeIncrease = unsignedAttrs.length;
  function updateLengths(node) {
    let n = node;
    while (n) {
      const oldLenBytes = n.headerLen - 1;
      const newContentLen = n.length + sizeIncrease;
      const newLenBytes = encodeDerLength(newContentLen);
      if (newLenBytes.length === oldLenBytes) {
        newLenBytes.copy(newCms, n.offset + 1);
      } else {
        const shift = newLenBytes.length - oldLenBytes;
        const prefix = newCms.slice(0, n.offset + 1);
        const suffix = newCms.slice(n.offset + 1 + oldLenBytes);
        const temp = Buffer.concat([prefix, newLenBytes, suffix]);
        newCms.length = temp.length;
        temp.copy(newCms);
        return { shifted: shift };
      }
      n = null;
    }
    return { shifted: 0 };
  }

  const containers = [
    signerInfo,
    signerInfosSet,
    signedData,
    contentInfo.children[1],
    contentInfo
  ];

  for (const container of containers) {
    const oldLenBytes = container.headerLen - 1;
    const newContentLen = container.length + sizeIncrease;
    const newLenBytes = encodeDerLength(newContentLen);

    if (newLenBytes.length !== oldLenBytes) {
      throw new Error(`Length encoding size change not supported: ${oldLenBytes} -> ${newLenBytes.length} at offset ${container.offset}`);
    }
    newLenBytes.copy(newCms, container.offset + 1);
  }

  return newCms;
}

function extractCertChainFromP12(p12Buffer, passphrase) {
  try {
    const p12Der = forge.util.createBuffer(p12Buffer.toString('binary'), 'binary');
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, passphrase);
    const certBags = p12.getBags({ bagType: forge.oids.certBag });
    const certs = certBags[forge.oids.certBag] || [];
    return certs.map(c => {
      const pem = forge.pki.certificateToPem(c.cert);
      const reParsed = forge.pki.certificateFromPem(pem);
      const derHex = forge.asn1.toDer(forge.pki.certificateToAsn1(reParsed)).getBytes();
      return Buffer.from(derHex, 'binary');
    });
  } catch (e) {
    return [];
  }
}

async function enhanceSignedPdf(signedPdfBuffer, p12Buffer, passphrase) {
  const signedBuf = Buffer.from(signedPdfBuffer);
  const signedStr = signedBuf.toString('latin1');

  const contentsMatch = signedStr.match(/\/Contents\s*<([0-9a-fA-F\s]+?)>/);
  if (!contentsMatch) throw new Error('/Contents not found in signed PDF');

  const hexContent = contentsMatch[1].replace(/\s+/g, '');
  const fullCmsDer = Buffer.from(hexContent, 'hex');

  const root = parseDerNode(fullCmsDer, 0);
  const cmsDer = fullCmsDer.slice(0, root.totalLen);

  const brMatch = signedStr.match(/\[0\s+(\d+)\s+(\d+)\s+(\d+)\]/);
  if (!brMatch) throw new Error('ByteRange not found');

  const sigDataStart = parseInt(brMatch[1]);
  const sigDataLen = parseInt(brMatch[2]);
  const sigData = signedBuf.slice(sigDataStart, sigDataStart + sigDataLen);
  const sigHash = crypto.createHash('sha256').update(sigData).digest();

  let tsaToken;
  try {
    tsaToken = await queryTSA(sigHash);
  } catch (tsaErr) {
    throw new Error('TSA query failed: ' + tsaErr.message);
  }

  let enhancedCms;
  try {
    enhancedCms = addUnsignedAttrsToCms(cmsDer, tsaToken);
  } catch (embedErr) {
    throw new Error('CMS TSA embed failed: ' + embedErr.message);
  }

  const newHex = enhancedCms.toString('hex').toUpperCase();

  const paddedHex = newHex + '0'.repeat(Math.max(0, hexContent.length - newHex.length));
  if (paddedHex.length > hexContent.length) {
    throw new Error('Enhanced CMS exceeds placeholder capacity');
  }

  let resultStr = signedStr.replace(`<${hexContent}>`, `<${paddedHex}>`);

  return Buffer.from(resultStr, 'latin1');
}

module.exports = { enhanceSignedPdf, queryTSA, extractCertChainFromP12 };
