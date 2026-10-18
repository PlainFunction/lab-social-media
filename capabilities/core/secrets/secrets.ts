import { Port } from '../kernel/port'
import { ConfigError } from '../kernel/errors'

/**
 * A secret value that won't end up in a log by accident: printing it,
 * interpolating it or JSON-encoding it gives "[secret]". Call reveal() at the
 * one place the real value is needed, usually a request header.
 */
export class Secret {
  readonly #value: string
  constructor(value: string) { this.#value = value }
  reveal() { return this.#value }
  toString() { return '[secret]' }
  toJSON() { return '[secret]' }
  [Symbol.for('nodejs.util.inspect.custom')]() { return '[secret]' }
}

/** A secret looked up when first needed and remembered after. */
export class SecretRef {
  readonly name: string
  readonly #store: SecretStore
  #value?: Promise<Secret>
  constructor(store: SecretStore, name: string) {
    this.#store = store
    this.name = name
  }
  get(): Promise<Secret> {
    // Don't remember a failure: the next call should try again.
    this.#value ??= this.#store.get(this.name).catch(err => { this.#value = undefined; throw err })
    return this.#value
  }
}

export abstract class SecretStore extends Port {
  /** Throws ConfigError when the secret isn't set. */
  abstract get(name: string): Promise<Secret>

  async optional(name: string): Promise<Secret | undefined> {
    try { return await this.get(name) } catch (err) {
      if (err instanceof ConfigError) return undefined
      throw err
    }
  }

  ref(name: string) { return new SecretRef(this, name) }
}

type SecretsStoreBinding = { get(): Promise<string> }
const isStoreBinding = (v: unknown): v is SecretsStoreBinding =>
  !!v && typeof v === 'object' && typeof (v as SecretsStoreBinding).get === 'function'

/**
 * Reads Worker secrets (`wrangler secret put`, or Terraform `secret_text`) and
 * Cloudflare Secrets Store bindings from env. Secrets Store is preferred for
 * anything shared across a client's Workers: one place to rotate, scoped access.
 */
export class CloudflareSecretStore extends SecretStore {
  readonly #env: Record<string, unknown>
  constructor(env: object) {
    super()
    this.#env = env as Record<string, unknown>
  }

  async get(name: string): Promise<Secret> {
    const v = this.#env[name]
    if (typeof v === 'string' && v.length > 0) return new Secret(v)
    if (isStoreBinding(v)) return new Secret(await v.get())
    throw new ConfigError(`Secret ${name} is not set`)
  }

  describe() {
    return { name: 'Worker secrets / Secrets Store', use: 'API keys and encryption keys', personalInfo: [], storesIn: 'Cloudflare, encrypted, never in code' }
  }
}

/** For tests. */
export class MemorySecretStore extends SecretStore {
  readonly #values: Record<string, string>
  constructor(values: Record<string, string>) {
    super()
    this.#values = values
  }
  async get(name: string) {
    const v = this.#values[name]
    if (!v) throw new ConfigError(`Secret ${name} is not set`)
    return new Secret(v)
  }
  describe() {
    return { name: 'Memory secrets', use: 'Tests', personalInfo: [], storesIn: 'Memory' }
  }
}
