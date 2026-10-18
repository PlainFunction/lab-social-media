import { Port, mergeManifest, type Manifest } from '../kernel/port'
import { sha256Hex } from '../kernel/encoding'
import type { Cipher } from '../security/cipher'

/**
 * Cache port. Values are anything JSON can carry.
 *
 * Every adapter gets `getOrSet` for free: a read-through with single-flight,
 * so twenty requests that miss at once make one upstream call, not twenty.
 *
 * Adapters, fastest and least shared first:
 *   MemoryCache  this isolate only, microseconds, gone on eviction
 *   EdgeCache    Cache API, this Cloudflare data centre, free
 *   KvCache      Workers KV, global, eventually consistent, survives deploys
 *   TieredCache  any of the above stacked, with backfill
 * Decorators:
 *   ScopedCache     prefixes and hashes keys (no customer ids in key names)
 *   EncryptedCache  seals values with a Cipher (anything personal goes through this)
 */
export abstract class Cache extends Port {
  abstract get<T>(key: string): Promise<T | undefined>
  abstract set<T>(key: string, value: T, ttlSeconds: number): Promise<void>
  abstract delete(key: string): Promise<void>

  #inflight = new Map<string, Promise<unknown>>()

  async getOrSet<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key)
    if (hit !== undefined) return hit

    const pending = this.#inflight.get(key) as Promise<T> | undefined
    if (pending) return pending

    const p = (async () => {
      try {
        const value = await load()
        if (value !== undefined) await this.set(key, value, ttlSeconds)
        return value
      } finally {
        this.#inflight.delete(key)
      }
    })()
    this.#inflight.set(key, p)
    return p
  }

  scoped(scope: string): Cache { return new ScopedCache(this, scope) }
  encrypted(cipher: Cipher, context: string): Cache { return new EncryptedCache(this, cipher, context) }
}

/** Base for caches that wrap another cache. */
export abstract class CacheDecorator extends Cache {
  protected readonly inner: Cache
  constructor(inner: Cache) {
    super()
    this.inner = inner
  }
}

export class ScopedCache extends CacheDecorator {
  readonly #scope: string
  constructor(inner: Cache, scope: string) {
    super(inner)
    this.#scope = scope
  }
  // Hashed so a key like `contact:jane@example.com` never appears in KV listings.
  #key = async (key: string) => `${this.#scope}:${await sha256Hex(`${this.#scope}\n${key}`)}`
  async get<T>(key: string) { return this.inner.get<T>(await this.#key(key)) }
  async set<T>(key: string, value: T, ttl: number) { return this.inner.set(await this.#key(key), value, ttl) }
  async delete(key: string) { return this.inner.delete(await this.#key(key)) }
  describe() { return this.inner.describe() }
}

export class EncryptedCache extends CacheDecorator {
  readonly #cipher: Cipher
  readonly #context: string
  constructor(inner: Cache, cipher: Cipher, context: string) {
    super(inner)
    this.#cipher = cipher
    this.#context = context
  }
  async get<T>(key: string) {
    const sealed = await this.inner.get<string>(key)
    if (sealed === undefined) return undefined
    try {
      return await this.#cipher.decryptJson<T>(sealed, `${this.#context}:${key}`)
    } catch {
      // Sealed with a key that's since been dropped: treat as a miss.
      return undefined
    }
  }
  async set<T>(key: string, value: T, ttl: number) {
    return this.inner.set(key, await this.#cipher.encryptJson(value, `${this.#context}:${key}`), ttl)
  }
  async delete(key: string) { return this.inner.delete(key) }
  describe(): Manifest {
    return mergeManifest(this.inner.describe(), { name: 'Encrypted', use: this.inner.describe().use, storesIn: 'AES-256-GCM encrypted' })
  }
}
