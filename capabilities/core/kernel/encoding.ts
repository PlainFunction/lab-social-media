// Byte and text helpers shared by the security, cache and audit modules.
// Web Crypto only, so they run the same in Workers, browsers and Node.

const enc = new TextEncoder()
const dec = new TextDecoder()

export const utf8 = (s: string) => enc.encode(s) as Uint8Array<ArrayBuffer>
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b)

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Standard base64 (with + / and padding), as some keys are handed out. Accepts either form. */
export const fromB64 = (s: string) => fromB64url(s.replace(/=+$/, ''))

export const hex = (b: ArrayBuffer | Uint8Array) =>
  [...(b instanceof Uint8Array ? b : new Uint8Array(b))].map(x => x.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof input === 'string' ? utf8(input) : input))
}

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n))

/** An unguessable id, 128 bits, URL safe. */
export const randomId = () => b64url(randomBytes(16))

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Compares without leaking where the first difference is. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** JSON with sorted keys, so the same object always hashes the same. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v)
}
