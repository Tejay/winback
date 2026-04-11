import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const KEY = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex')
if (KEY.length !== 16) throw new Error('ENCRYPTION_KEY must be exactly 32 hex chars (16 bytes)')

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-128-gcm', KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64')
  const iv  = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = createDecipheriv('aes-128-gcm', KEY, iv)
  decipher.setAuthTag(tag)
  return decipher.update(enc) + decipher.final('utf8')
}
