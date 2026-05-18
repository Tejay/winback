// Build-time prompt inliner.
//
// Reads the markdown prompt files in /prompts/ and writes a TypeScript
// module that exports each prompt as a string constant. The generated
// file (src/winback/lib/prompts.generated.ts) is committed to git so
// the deploy doesn't depend on a build step on Vercel reading from disk.
//
// Usage:
//   npx tsx scripts/build-prompts.ts
//   npm run prompts:build      (alias)
//
// Wired into `prebuild` in package.json so `next build` always regenerates.
//
// Why a generated TS file (and not runtime fs.readFileSync)?
//   - No Vercel outputFileTracing config required
//   - No Edge-runtime fs incompatibility risk
//   - TS compiler still type-checks the exported constants
//   - Byte-for-byte traceable diff in PRs

import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '..')
const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts')
const OUTPUT = path.join(REPO_ROOT, 'src/winback/lib/prompts.generated.ts')

// Map: markdown filename → exported constant name in the .ts file
const PROMPTS: Array<readonly [string, string]> = [
  ['classifier-system.md',         'CLASSIFIER_SYSTEM_PROMPT'],
  ['match-system.md',              'MATCH_SYSTEM_PROMPT'],
  ['improvement-email-system.md',  'GENERATE_SYSTEM_PROMPT'],
  ['improvement-sanity-system.md', 'SANITY_SYSTEM_PROMPT'],
  ['promotion-email-system.md',    'GENERATE_PROMOTION_SYSTEM_PROMPT'],
  ['promotion-sanity-system.md',   'SANITY_PROMO_SYSTEM_PROMPT'],
  ['cluster-system.md',            'CLUSTER_SYSTEM_PROMPT'],
]

function loadPromptFile(filename: string): string {
  const filepath = path.join(PROMPTS_DIR, filename)
  if (!fs.existsSync(filepath)) {
    throw new Error(`Missing prompt file: ${filepath}`)
  }
  let content = fs.readFileSync(filepath, 'utf-8')
  // Editors often append a trailing newline. The original inline string
  // literals did not have one — strip it so the generated constants match
  // the previous behavior byte-for-byte.
  if (content.endsWith('\n')) content = content.slice(0, -1)
  return content
}

function generate(): string {
  const lines: string[] = [
    '// AUTO-GENERATED FILE — do not edit by hand.',
    '// Source of truth: /prompts/*.md',
    '// Regenerate with: npm run prompts:build',
    '//',
    '// This file is committed to git so production deploys never depend',
    '// on the markdown files being read at runtime.',
    '',
  ]
  for (const [filename, exportName] of PROMPTS) {
    const content = loadPromptFile(filename)
    // JSON.stringify produces a properly-escaped JS string literal — handles
    // newlines, backslashes, quotes, unicode without us having to think.
    lines.push(`export const ${exportName}: string = ${JSON.stringify(content)}`)
    lines.push('')
  }
  return lines.join('\n')
}

function main(): void {
  const output = generate()
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, output)
  const relativeOut = path.relative(REPO_ROOT, OUTPUT)
  console.log(`✓ Wrote ${PROMPTS.length} prompts to ${relativeOut}`)
  for (const [filename, exportName] of PROMPTS) {
    const bytes = loadPromptFile(filename).length
    console.log(`  - ${exportName.padEnd(36)} (${bytes.toString().padStart(5)} bytes) from ${filename}`)
  }
}

main()
