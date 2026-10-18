import { Port } from '../kernel/port'
import { ConfigError, ValidationError } from '../kernel/errors'
import { b64url, fromB64, fromB64url, fromUtf8, randomBytes, utf8 } from '../kernel/encoding'
import type { SecretRef } from '../secrets/secrets'

/**
 * Encrypts anything personal before it's stored: approval payloads, cached
 * contact details, OAuth refresh tokens, documents in R2.
 *
 * `context` is bound into the ciphertext (AES-GCM additional data), so a value
 * sealed for `approval:abc` won't open as `approval:xyz`. Copying an encrypted
 * blob from one row to another doesn't work.
 */
export abstract class Cipher extends Port {
  abstract encrypt(plain: Uint8Array<ArrayBuffer>, context: string): Promise<string>
  abstract decrypt(sealed: string, context: string): Promise<Uint8Array<ArrayBuffer>>

  encryptText(text: string, context: string) { return this.encrypt(utf8(text), context) }
  async decryptText(sealed: string, context: string) { return fromUtf8(await this.decrypt(sealed, context)) }
  encryptJson(value: unknown, context: string) { return this.encryptText(JSON.stringify(value), context) }
  async decryptJson<T>(sealed: string, context: string): Promise<T> { return JSON.parse(await this.decryptText(sealed, context)) as T }
}

/**
 * The keyring secret is JSON: `{"current":"k2","keys":{"k1":"<base64 32 bytes>","k2":"..."}}`.
 * New data uses `current`; old data still opens with the key id it was sealed
 * under. To rotate: add a key, point `current` at it, re-seal at leisure, then
 * drop the old one.
 *
 * Generate a key: `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`
 */
export interface Keyring { current: string; keys: Record<string, string> }

export class AesGcmCipher extends Cipher {
  readonly #keyring: () => Promise<Keyring>
  #keys?: Promise<{ current: string; keys: Map<string, CryptoKey> }>

  constructor(keyring: Keyring | (() => Promise<Keyring>)) {
    super()
    this.#keyring = typeof keyring === 'function' ? keyring : async () => keyring
  }

  static fromSecret(ref: SecretRef) {
    return new AesGcmCipher(async () => JSON.parse((await ref.get()).reveal()) as Keyring)
  }

  #load() {
    this.#keys ??= (async () => {
      const ring = await this.#keyring()
      if (!ring?.keys?.[ring.current]) throw new ConfigError('Keyring has no current key')
      const keys = new Map<string, CryptoKey>()
      for (const [id, material] of Object.entries(ring.keys)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ConfigError(`Bad key id ${id}`)
        const raw = fromB64(material)
        if (raw.length !== 32) throw new ConfigError(`Key ${id} must be 32 bytes`)
        keys.set(id, await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']))
      }
      return { current: ring.current, keys }
    })()
    return this.#keys
  }

  async encrypt(plain: Uint8Array<ArrayBuffer>, context: string): Promise<string> {
    const { current, keys } = await this.#load()
    const iv = randomBytes(12)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(context) }, keys.get(current)!, plain)
    return `v1.${current}.${b64url(iv)}.${b64url(ct)}`
  }

  async decrypt(sealed: string, context: string): Promise<Uint8Array<ArrayBuffer>> {
    const [v, kid, iv, ct] = sealed.split('.')
    if (v !== 'v1' || !kid || !iv || !ct) throw new ValidationError('Not a sealed value')
    const { keys } = await this.#load()
    const key = keys.get(kid)
    if (!key) throw new ConfigError(`Key ${kid} is no longer in the keyring`)
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv), additionalData: utf8(context) }, key, fromB64url(ct)))
    } catch {
      throw new ValidationError('Could not decrypt: wrong key, wrong context or tampered')
    }
  }

  describe() {
    return { name: 'AES-256-GCM', use: 'Encrypting personal data before it is stored', personalInfo: [], storesIn: 'Nowhere (keys in Worker secrets)' }
  }
}
