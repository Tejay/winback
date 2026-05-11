// Copies DATABASE_POSTGRES_URL → DATABASE_URL in .env.production.tmp so
// the existing scripts (which read DATABASE_URL) work against prod.
// Never prints the URL value.
// Run: npx tsx scripts/spec-56-bridge-prod-env.ts

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const ENV_PATH = join(__dirname, '..', '.env.production.tmp')

const env = readFileSync(ENV_PATH, 'utf8')
const lines = env.split('\n')

let postgresUrl: string | null = null
for (const line of lines) {
  if (line.startsWith('DATABASE_POSTGRES_URL=')) {
    postgresUrl = line.substring('DATABASE_POSTGRES_URL='.length)
    // Strip surrounding quotes if present
    postgresUrl = postgresUrl.replace(/^"/, '').replace(/"$/, '')
    break
  }
}
if (!postgresUrl) {
  console.error('DATABASE_POSTGRES_URL not found in .env.production.tmp')
  process.exit(1)
}

let foundLine = -1
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('DATABASE_URL=')) {
    foundLine = i
    break
  }
}
if (foundLine === -1) {
  console.error('DATABASE_URL line not found in .env.production.tmp')
  process.exit(1)
}

lines[foundLine] = `DATABASE_URL="${postgresUrl}"`
writeFileSync(ENV_PATH, lines.join('\n'))
console.log(`✓ DATABASE_URL bridged from DATABASE_POSTGRES_URL (length=${postgresUrl.length})`)
