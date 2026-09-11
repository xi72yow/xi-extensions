// Packs a directory into a signed CRX3 archive.
//
// Usage: node scripts/pack-crx.js <source-dir> <key.pem> <output.crx>
//
// Chrome itself can do this through --pack-extension, but that pulls the whole
// browser into the build image. The format is small enough to write out: the
// protobuf header only carries two fields, so it is encoded by hand rather
// than through a protobuf dependency.

import { createHash, createSign, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [sourceDir, keyPath, outputPath] = process.argv.slice(2)

if (!sourceDir || !keyPath || !outputPath) {
  console.error('usage: pack-crx.js <source-dir> <key.pem> <output.crx>')
  process.exit(1)
}

// protobuf wire type 2: a varint tag, a varint length, then the payload
function varint(value) {
  const bytes = []
  let rest = value

  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  bytes.push(rest)

  return Buffer.from(bytes)
}

function field(number, payload) {
  return Buffer.concat([varint((number << 3) | 2), varint(payload.length), payload])
}

const privateKey = readFileSync(keyPath, 'utf8')
const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })

// the manifest pins the public half, which is what fixes the extension id.
// signing with a different key would silently produce a package installing
// under an id nothing else refers to.
const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
if (manifest.key && manifest.key !== publicKeyDer.toString('base64')) {
  console.error(`error: ${keyPath} does not match the key pinned in manifest.json`)
  process.exit(1)
}

// the crx id is the first half of the digest over the public key, and the
// extension id is that same value mapped from hex onto a to p
const crxId = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16)
const extensionId = crxId
  .toString('hex')
  .replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + parseInt(character, 16)))

// zip -X drops extra attributes, which keeps the archive reproducible
const zipPath = join(tmpdir(), `crx-${process.pid}.zip`)
rmSync(zipPath, { force: true })
execFileSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: sourceDir })
const archive = readFileSync(zipPath)
rmSync(zipPath, { force: true })

const signedHeaderData = field(1, crxId)

// the signature covers a magic string, the length of the signed header and
// the archive, in that order
const signature = createSign('sha256')
  .update(Buffer.from('CRX3 SignedData\0', 'binary'))
  .update(
    ((length) => {
      const buffer = Buffer.alloc(4)
      buffer.writeUInt32LE(length)
      return buffer
    })(signedHeaderData.length),
  )
  .update(signedHeaderData)
  .update(archive)
  .sign(privateKey)

const proof = Buffer.concat([field(1, publicKeyDer), field(2, signature)])
const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)])

const prefix = Buffer.alloc(12)
prefix.write('Cr24', 0, 'binary')
prefix.writeUInt32LE(3, 4)
prefix.writeUInt32LE(header.length, 8)

writeFileSync(outputPath, Buffer.concat([prefix, header, archive]))

console.log(extensionId)
