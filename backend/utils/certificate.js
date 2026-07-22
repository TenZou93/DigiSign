const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const CERT_DIR = path.join(__dirname, '..', '..', 'keys');
const CERT_FILE = path.join(CERT_DIR, 'certificate.p12');
const CERT_PASSWORD = 'digisign2026';

function generateCertificate() {
  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });
  if (fs.existsSync(CERT_FILE)) return;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

  const attrs = [
    { name: 'commonName', value: 'DigiSign Digital Signature' },
    { name: 'organizationName', value: 'DigiSign App' },
    { name: 'countryName', value: 'ID' }
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true }
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], CERT_PASSWORD, {
    algorithm: '3des',
    friendlyName: 'DigiSign Certificate'
  });

  const p12Buffer = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  fs.writeFileSync(CERT_FILE, p12Buffer);
  console.log('Self-signed certificate generated:', CERT_FILE);
}

function getCertificate() {
  if (!fs.existsSync(CERT_FILE)) generateCertificate();
  return {
    p12: fs.readFileSync(CERT_FILE),
    password: CERT_PASSWORD
  };
}

module.exports = { generateCertificate, getCertificate, CERT_FILE, CERT_PASSWORD };
