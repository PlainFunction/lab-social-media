import { Port, type Manifest } from './port'

// A small dependency registry. Keys are either a port's abstract class
// (`c.get(Cache)`) or a Token when one port is bound more than once
// (`c.get(OWNER_NOTIFIER)` and `c.get(OPS_NOTIFIER)` are both Notifiers).
//
// Instances are created lazily and live as long as the registry. Build one
// registry per Worker isolate (env doesn't change between requests), not per request.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Class<T> = abstract new (...args: any[]) => T

export class Token<T> {
  readonly name: string
  readonly type: Class<T>
  constructor(name: string, type: Class<T>) {
    this.name = name
    this.type = type
  }
  toString() { return this.name }
}

export type Key<T> = Class<T> | Token<T>
export type Factory<T> = (c: Registry) => T

const keyName = (k: Key<unknown>) => (k instanceof Token ? k.name : k.name)
const keyType = <T>(k: Key<T>): Class<T> => (k instanceof Token ? k.type : k)

export class Registry {
  #factories = new Map<Key<unknown>, Factory<unknown>>()
  #instances = new Map<Key<unknown>, unknown>()
  #resolving = new Set<Key<unknown>>()
  #hooks: ((key: string, instance: unknown) => unknown)[] = []

  /**
   * Runs on every instance as it is built, after the type check. Telemetry uses
   * this to trace every port without touching any adapter.
   */
  intercept(hook: (key: string, instance: unknown) => unknown): this {
    this.#hooks.push(hook)
    this.#instances.clear()
    return this
  }

  /** Bind (or rebind) a key. Rebinding drops any instance already built. */
  bind<T>(key: Key<T>, factory: Factory<T>): this {
    this.#factories.set(key, factory)
    this.#instances.delete(key)
    return this
  }

  /**
   * Wrap whatever is currently bound, e.g. put a cache in front of a client's
   * custom adapter without knowing which adapter it is.
   */
  decorate<T>(key: Key<T>, wrap: (inner: T, c: Registry) => T): this {
    const inner = this.#factories.get(key) as Factory<T> | undefined
    if (!inner) throw new Error(`Nothing bound for ${keyName(key)} to decorate`)
    return this.bind(key, c => wrap(inner(c), c))
  }

  has(key: Key<unknown>): boolean {
    return this.#factories.has(key)
  }

  get<T>(key: Key<T>): T {
    if (this.#instances.has(key)) return this.#instances.get(key) as T
    const factory = this.#factories.get(key) as Factory<T> | undefined
    if (!factory) throw new Error(`Nothing bound for ${keyName(key)}`)
    if (this.#resolving.has(key)) throw new Error(`Circular dependency on ${keyName(key)}`)

    this.#resolving.add(key)
    try {
      const instance = factory(this)
      // Catches a binding that hands back the wrong kind of object, which
      // TypeScript can't see once a factory has been through `any`.
      if (!(instance instanceof keyType(key))) {
        throw new Error(`Binding for ${keyName(key)} returned something that isn't a ${keyType(key).name}`)
      }
      const out = this.#hooks.reduce<unknown>((x, h) => h(keyName(key), x), instance) as T
      this.#instances.set(key, out)
      return out
    } finally {
      this.#resolving.delete(key)
    }
  }

  /** Every bound port's manifest. Builds the adapters, so call it with a full env. */
  manifests(): { key: string; adapter: string; manifest: Manifest }[] {
    const out: { key: string; adapter: string; manifest: Manifest }[] = []
    for (const key of this.#factories.keys()) {
      const instance = this.get(key)
      if (instance instanceof Port) {
        out.push({ key: keyName(key), adapter: instance.constructor.name, manifest: instance.describe() })
      }
    }
    return out
  }
}

/**
 * A group of bindings. CoreModule binds the defaults; a client's module extends
 * it and overrides only the protected methods that differ for that client.
 */
export abstract class Module {
  abstract register(c: Registry): void

  build(): Registry {
    const c = new Registry()
    this.register(c)
    return c
  }
}
