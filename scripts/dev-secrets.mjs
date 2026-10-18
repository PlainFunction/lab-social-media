// Writes the secrets `wrangler dev` needs into .dev.vars.
//
//   npm run dev:secrets
//
// Generates KEYRING and SIGNING_KEY, and adds blank lines for the Slack values
// to fill in. Never replaces a value that's already there: a new KEYRING would
// lose everything sealed with the old one. Prints names, never values.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../.dev.vars', import.meta.url))
const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
const have = new Set(text.split(/\r?\n/).map(line => line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1]).filter(Boolean))

const generated = {
  // Same shape as core's AesGcmCipher expects. To rotate, add k2 and point current at it.
  KEYRING: () => JSON.stringify({ current: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
  SIGNING_KEY: () => randomBytes(32).toString('base64url'),
}
const fromSlack = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN']

const lines = []
for (const [name, make] of Object.entries(generated)) if (!have.has(name)) lines.push(`${name}=${make()}`)
const blanks = fromSlack.filter(name => !have.has(name))
if (blanks.length) lines.push('# From your Slack app: Basic Information and OAuth & Permissions', ...blanks.map(name => `${name}=`))
if (!have.has('CREDENTIAL_ZERNIO')) lines.push('# A Zernio API key (sk_...), from Settings, API Keys in Zernio', 'CREDENTIAL_ZERNIO=')

if (!lines.length) {
  console.log('✓ .dev.vars already has everything. Nothing changed.')
} else {
  const sep = text && !text.endsWith('\n') ? '\n' : ''
  writeFileSync(file, text + sep + lines.join('\n') + '\n')
  const added = lines.filter(l => !l.startsWith('#')).map(l => l.split('=')[0])
  console.log(`✓ Added to .dev.vars: ${added.join(', ')}`)
}

const empty = (existsSync(file) ? readFileSync(file, 'utf8') : '').split(/\r?\n/)
  .map(line => line.match(/^\s*([A-Z0-9_]+)\s*=\s*$/)?.[1]).filter(Boolean)
if (empty.length) console.log(`  Still to fill in: ${empty.join(', ')}`)
console.log('  Keep a copy of KEYRING somewhere safe. Without it, sealed data can\'t be read.')
