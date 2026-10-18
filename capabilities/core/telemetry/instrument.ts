import { Clock } from '../kernel/clock'
import { Logger, type LogFields } from '../kernel/logger'
import type { Manifest } from '../kernel/port'
import { Telemetry, toAttributes, type Severity } from './telemetry'

const NEVER = new Set(['constructor', 'describe', 'toString', 'toJSON'])

/**
 * A Registry hook that traces every capability: each async method on anything
 * the registry builds runs inside a span named `<key>.<method>`, e.g.
 * `InvoiceSource.outstanding`, `owner-notifier.notify`. Nested calls nest.
 * No adapter has to know telemetry exists.
 *
 *   registry.intercept(instrument(() => registry.get(Telemetry)))
 *
 * Methods are called on the real object, so private fields keep working, and
 * `instanceof` still holds. Sync methods aren't traced (Clock.now, Redactor.session).
 */
export function instrument(telemetry: () => Telemetry) {
  return (key: string, instance: unknown): unknown => {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) return instance
    if (instance instanceof Telemetry || instance instanceof Logger || instance instanceof Clock) return instance
    const adapter = instance.constructor?.name ?? 'Object'

    return new Proxy(instance, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown
        if (typeof value !== 'function') return value
        const fn = value as (...args: unknown[]) => unknown
        if (typeof prop !== 'string' || NEVER.has(prop) || fn.constructor?.name !== 'AsyncFunction') return fn.bind(target)
        return (...args: unknown[]) => telemetry().inSpan(`${key}.${prop}`, {
          attrs: { 'pf.port': key, 'pf.adapter': adapter, 'code.function.name': prop },
        }, () => fn.apply(target, args) as Promise<unknown>)
      },
    })
  }
}

/** Logs as OTel log records, tied to the current span. Scrubbed like every log. */
export class TelemetryLogger extends Logger {
  readonly #telemetry: Telemetry
  constructor(telemetry: Telemetry) {
    super()
    this.#telemetry = telemetry
  }

  write(level: Severity, message: string, fields?: LogFields) {
    this.#telemetry.log({ severity: level, body: message, attributes: toAttributes(fields) })
  }

  describe(): Manifest {
    return { name: `Logs via ${this.#telemetry.describe().name}`, use: 'Operational logs, scrubbed of emails and secrets', personalInfo: [], storesIn: this.#telemetry.describe().storesIn }
  }
}
