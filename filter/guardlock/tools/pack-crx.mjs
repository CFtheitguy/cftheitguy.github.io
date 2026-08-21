/* Packs the built extension into a signed .crx plus an update manifest, so a
 * browser policy can force-install GuardLock straight from your own web server.
 * No store account, no fee, no per-machine work.
 *
 *   node tools/pack-crx.mjs --base-url https://www.linearit.co/filter/guardlock/dist
 *
 * The signing key is generated once and written to .crx-key.pem, which is
 * gitignored. Keep it: the extension's identity is derived from it, so losing
 * it means a new id and a policy update everywhere. Anyone holding it can
 * publish an update that your machines will install, so treat it like a
 * password and never commit it. */
import { createHash, createSign, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'dist', 'edge');
const OUT = join(ROOT, 'dist');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args[a.slice(2)] = next; i++; }
  else args[a.slice(2)] = true;
}

const keyPath = args.key ? String(args.key) : join(ROOT, '.crx-key.pem');
const baseUrl = String(args['base-url'] || 'https://www.linearit.co/filter/guardlock/dist')
  .replace(/\/+$/, '');
const version = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8')).version;

/* ------------------------------------------------------------------ the key */

let privatePem;
if (existsSync(keyPath)) {
  privatePem = readFileSync(keyPath, 'utf8');
  console.log('using the existing key at', keyPath);
} else {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(keyPath, privatePem);
  chmodSync(keyPath, 0o600);
  console.log('generated a new signing key at', keyPath, '— back this up');
}

const publicDer = createPublicKey(privatePem).export({ type: 'spki', format: 'der' });

/** Chromium derives the extension id from the public key: the first 16 bytes
 *  of its SHA-256, with each nibble mapped onto a–p. */
const idBytes = createHash('sha256').update(publicDer).digest().subarray(0, 16);
const extensionId = [...idBytes]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
  .join('');

/* ------------------------------------------------------- minimal protobuf */

function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
/** One length-delimited protobuf field: tag, length, payload. */
function field(number, payload) {
  return Buffer.concat([varint((number << 3) | 2), varint(payload.length), payload]);
}

/* ----------------------------------------------------------------- the zip */

const zipPath = join(OUT, 'guardlock-crx-payload.zip');
rmSync(zipPath, { force: true });
mkdirSync(OUT, { recursive: true });
execFileSync('zip', ['-qr9', '-X', zipPath, '.'], { cwd: SRC });
const zip = readFileSync(zipPath);
rmSync(zipPath, { force: true });

/* --------------------------------------------------------------- the crx3 */

// SignedData { bytes crx_id = 1; }
const signedHeaderData = field(1, idBytes);

// Chromium signs a domain-separated join of the header and the archive, so a
// signature cannot be lifted from one crx onto another.
const signer = createSign('sha256');
const lengthPrefix = Buffer.alloc(4);
lengthPrefix.writeUInt32LE(signedHeaderData.length);
signer.update(Buffer.from('CRX3 SignedData\0', 'binary'));
signer.update(lengthPrefix);
signer.update(signedHeaderData);
signer.update(zip);
const signature = signer.sign(privatePem);

// AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
const proof = Buffer.concat([field(1, publicDer), field(2, signature)]);
// CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
//                 bytes signed_header_data = 10000; }
const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);

const magic = Buffer.from('Cr24', 'ascii');
const meta = Buffer.alloc(8);
meta.writeUInt32LE(3, 0);                 // crx format version
meta.writeUInt32LE(header.length, 4);

const crxPath = join(OUT, 'guardlock.crx');
writeFileSync(crxPath, Buffer.concat([magic, meta, header, zip]));

/* ------------------------------------------------------- update manifest */

const updateXml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${extensionId}'>
    <updatecheck codebase='${baseUrl}/guardlock.crx' version='${version}' />
  </app>
</gupdate>
`;
writeFileSync(join(OUT, 'update.xml'), updateXml);

console.log(`
  extension id   ${extensionId}
  version        ${version}
  crx            ${crxPath}
  update.xml     ${join(OUT, 'update.xml')}
  codebase       ${baseUrl}/guardlock.crx

Upload guardlock.crx and update.xml to that base url, then provision with:

  node tools/provision.mjs --pin <PIN> \\
    --edge-id ${extensionId} \\
    --edge-update ${baseUrl}/update.xml
`);
