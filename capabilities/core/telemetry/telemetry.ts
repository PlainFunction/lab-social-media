import { tracing } from 'cloudflare:workers'
import { Port, type Manifest } from '../kernel/port'
import { hex, randomBytes } from '../kernel/encoding'
import { scrub } from '../kernel/logger'
import { HttpClient, type Fetch } from '../security/egress'
import type { SecretRef } from '../secrets/secrets'
import { activeTelemetry, context } from './context'

// OpenTelemetry for every capability: traces to Tempo, logs to Loki, joined by
// trace id. Attribute names follow OTel semantic conventions, plus a few `pf.*`
// ones of our own, so every client's Worker reports the same shape.
//
// Nothing personal goes into telemetry: spans carry port, adapter, method,
// host and status; log attributes are scrubbed like any other log.
//
// Needs the `nodejs_compat` flag (AsyncLocalStorage carries the current span
// across awaits).

export type AttrValue = string | number | boolean
export type Attrs = Record<string, AttrValue | undefined>
export type SpanKind = 'internal' | 'server' | 'client'
export type Severity = 'debug' | 'info' | 'warn' | 'error'

export interface SpanHandle {
  /** 32 hex chars, or '' when the platform owns the ids (CloudflareTelemetry). */
  readonly traceId: string
  readonly spanId: string
  setAttribute(key: string, value: AttrValue): void
  recordError(err: unknown): void
}

export interface SpanOptions {
  kind?: SpanKind
  attrs?: Attrs
  /** Continue a trace started elsewhere (W3C `traceparent`). */
  parent?: { traceId: string; spanId: string }
}

export interface LogRecord { severity: Severity; body: string; attributes?: Attrs }

/** Who is reporting. Becomes the OTLP resource, and Loki's `service_name`. */
export interface TelemetryResource {
  /** e.g. `pf-plain-function` */
  serviceName: string
  serviceVersion: string
  environment: string
  client: string
}

export const resourceAttributes = (r: TelemetryResource): Attrs => ({
  'service.name': r.serviceName,
  'service.namespace': 'plainfunction',
  'service.version': r.serviceVersion,
  'deployment.environment.name': r.environment,
  'cloud.provider': 'cloudflare',
  'cloud.platform': 'cloudflare.workers',
  'pf.client': r.client,
})

export { activeTelemetry }

/** Parses a W3C `traceparent` header. Returns undefined for anything malformed. */
export function parseTraceparent(header: string | null): { traceId: string; spanId: string } | undefined {
  const m = header?.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/)
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return undefined
  return { traceId: m[1], spanId: m[2] }
}

const errorAttrs = (err: unknown): Attrs => ({
  'error.type': err instanceof Error ? err.name : typeof err,
  'exception.message': String(scrub(err instanceof Error ? err.message : String(err))).slice(0, 300),
})

/** Flattens and scrubs log fields into OTel attributes (nested values become JSON). */
export function toAttributes(fields: Record<string, unknown> = {}): Attrs {
  const clean = scrub(fields) as Record<string, unknown>
  return Object.fromEntries(Object.entries(clean).map(([k, v]) =>
    [k, typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v)]))
}

export abstract class Telemetry extends Port {
  readonly resource: TelemetryResource
  constructor(resource: TelemetryResource) {
    super()
    this.resource = resource
  }

  /** Runs `fn` inside a span that ends when it settles, recording any error. The span is current for everything `fn` awaits. */
  abstract inSpan<T>(name: string, opts: SpanOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T>
  abstract log(record: LogRecord): void
  /** Sends anything buffered. Call from ctx.waitUntil; never throws. */
  async flush(): Promise<void> {}

  /** Makes this the active telemetry for one invocation. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return context.run({ telemetry: this }, fn)
  }

  protected enter<T>(span: SpanHandle, fn: () => Promise<T>): Promise<T> {
    return context.run({ telemetry: this, span }, fn)
  }

  protected errorAttrs(err: unknown) { return errorAttrs(err) }
}

/**
 * Cloudflare's own tracing. Spans join the platform's automatic trace (fetch,
 * KV, D1, R2 subrequests); logs are JSON lines in Workers Logs. Turn on
 * Workers Observability export with OTLP destinations for Tempo and Loki and
 * both ship from Cloudflare: no exporter in our code, no extra egress.
 * The platform owns trace ids, so `traceId` / `spanId` are empty here.
 */
export class CloudflareTelemetry extends Telemetry {
  async inSpan<T>(name: string, opts: SpanOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    return tracing.enterSpan(name, async native => {
      const set = (k: string, v: AttrValue | undefined) => { if (v !== undefined) native.setAttribute(k, v) }
      set('span.kind', opts.kind ?? 'internal')
      for (const [k, v] of Object.entries(opts.attrs ?? {})) set(k, v)
      const handle: SpanHandle = {
        traceId: '', spanId: '',
        setAttribute: set,
        recordError: err => { set('otel.status_code', 'ERROR'); for (const [k, v] of Object.entries(errorAttrs(err))) set(k, v) },
      }
      try {
        return await this.enter(handle, () => fn(handle))
      } catch (err) {
        handle.recordError(err)
        throw err
      } finally {
        native.end()
      }
    })
  }

  log(r: LogRecord) {
    const line = JSON.stringify({ level: r.severity, message: r.body, 'service.name': this.resource.serviceName, 'pf.client': this.resource.client, ...r.attributes })
    if (r.severity === 'error') console.error(line)
    else if (r.severity === 'warn') console.warn(line)
    else console.log(line)
  }

  describe(): Manifest {
    return { name: 'Cloudflare tracing + Workers Logs', use: 'Traces and logs, exported by Cloudflare to Tempo and Loki', personalInfo: [], storesIn: 'Cloudflare Workers Observability, then Grafana' }
  }
}

export interface FinishedSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  startMs: number
  endMs: number
  attrs: Attrs
  error: boolean
}

export interface BufferedLog extends LogRecord { timeMs: number; traceId?: string; spanId?: string }

/** Keeps its own W3C ids and buffers finished spans and logs. Subclasses decide where they go. */
export abstract class RecordingTelemetry extends Telemetry {
  protected spans: FinishedSpan[] = []
  protected logs: BufferedLog[] = []

  async inSpan<T>(name: string, opts: SpanOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    const parent = opts.parent ?? context.getStore()?.span
    const record: FinishedSpan = {
      traceId: parent?.traceId || hex(randomBytes(16)),
      spanId: hex(randomBytes(8)),
      parentSpanId: parent?.spanId || undefined,
      name, kind: opts.kind ?? 'internal', startMs: Date.now(), endMs: 0,
      attrs: { ...opts.attrs }, error: false,
    }
    const handle: SpanHandle = {
      traceId: record.traceId, spanId: record.spanId,
      setAttribute: (k, v) => { record.attrs[k] = v },
      recordError: err => { record.error = true; Object.assign(record.attrs, errorAttrs(err)) },
    }
    try {
      return await this.enter(handle, () => fn(handle))
    } catch (err) {
      handle.recordError(err)
      throw err
    } finally {
      record.endMs = Date.now()
      this.spans.push(record)
    }
  }

  log(r: LogRecord) {
    const span = context.getStore()?.span
    this.logs.push({ ...r, timeMs: Date.now(), traceId: span?.traceId, spanId: span?.spanId })
  }

  /** Takes everything buffered so far. */
  protected drain() {
    const out = { spans: this.spans, logs: this.logs }
    this.spans = []
    this.logs = []
    return out
  }
}

/** Keeps spans and logs for tests. */
export class MemoryTelemetry extends RecordingTelemetry {
  get finishedSpans(): readonly FinishedSpan[] { return this.spans }
  get bufferedLogs(): readonly BufferedLog[] { return this.logs }
  describe(): Manifest { return { name: 'Memory telemetry', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}

// ── OTLP/HTTP JSON ───────────────────────────────────────────────────────────

const KIND = { internal: 1, server: 2, client: 3 } as const
const SEVERITY = { debug: 5, info: 9, warn: 13, error: 17 } as const
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`

const otlpValue = (v: AttrValue) =>
  typeof v === 'boolean' ? { boolValue: v }
    : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
      : { stringValue: v }

export const otlpAttributes = (attrs: Attrs) =>
  Object.entries(attrs).filter((e): e is [string, AttrValue] => e[1] !== undefined).map(([key, v]) => ({ key, value: otlpValue(v) }))

/** Parses `OTEL_EXPORTER_OTLP_HEADERS` ("k1=v1,k2=v2", values percent-encoded). */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=')
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  return out
}

/**
 * Exports OTLP/HTTP JSON itself: `/v1/traces` (Tempo) and `/v1/logs` (Loki).
 * Point it at Grafana Cloud's OTLP gateway, or at an OpenTelemetry Collector /
 * Grafana Alloy in front of self-hosted Loki and Tempo. Use this when you want
 * our own trace ids in log lines (for Loki → Tempo links), or Cloudflare's
 * export isn't available. Buffers per isolate; flush from ctx.waitUntil.
 */
export class OtlpTelemetry extends RecordingTelemetry {
  readonly #endpoint: URL
  readonly #headers?: SecretRef
  readonly #http: HttpClient
  /** Paths whose last export failed, so a broken exporter says so once, not on every request. */
  readonly #failing = new Set<string>()

  constructor(opts: { resource: TelemetryResource; endpoint: string; headers?: SecretRef; fetch?: Fetch }) {
    super(opts.resource)
    this.#endpoint = new URL(opts.endpoint.replace(/\/+$/, ''))
    this.#headers = opts.headers
    // Untraced: the exporter must not report on itself. Plain http only to a collector on this machine.
    this.#http = new HttpClient({ service: 'OTLP', allow: [this.#endpoint.hostname], fetch: opts.fetch, traced: false, loopbackHttp: true })
  }

  async flush() {
    const { spans, logs } = this.drain()
    if (spans.length === 0 && logs.length === 0) return
    const resource = { attributes: otlpAttributes(resourceAttributes(this.resource)) }
    const scope = { name: '@plainfunction/capabilities', version: this.resource.serviceVersion }
    const headers = { 'content-type': 'application/json', ...parseOtlpHeaders(this.#headers ? (await this.#headers.get().catch(() => undefined))?.reveal() : undefined) }

    const sends: Promise<unknown>[] = []
    if (spans.length) {
      sends.push(this.#post('/v1/traces', headers, {
        resourceSpans: [{
          resource,
          scopeSpans: [{
            scope,
            spans: spans.map(s => ({
              traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name, kind: KIND[s.kind], startTimeUnixNano: nanos(s.startMs), endTimeUnixNano: nanos(s.endMs),
              attributes: otlpAttributes(s.attrs), status: { code: s.error ? 2 : 1 },
            })),
          }],
        }],
      }))
    }
    if (logs.length) {
      sends.push(this.#post('/v1/logs', headers, {
        resourceLogs: [{
          resource,
          scopeLogs: [{
            scope,
            logRecords: logs.map(l => ({
              timeUnixNano: nanos(l.timeMs), severityNumber: SEVERITY[l.severity], severityText: l.severity.toUpperCase(),
              body: { stringValue: l.body }, attributes: otlpAttributes(l.attributes ?? {}),
              ...(l.traceId ? { traceId: l.traceId, spanId: l.spanId } : {}),
            })),
          }],
        }],
      }))
    }
    await Promise.all(sends)
  }

  async #post(path: string, headers: Record<string, string>, body: unknown) {
    const url = `${this.#endpoint.origin}${this.#endpoint.pathname.replace(/\/$/, '')}${path}`
    try {
      const res = await this.#http.request(url, { method: 'POST', headers, body: JSON.stringify(body) })
      if (res.ok) this.#failing.delete(path)
      else this.#failed(path, url, { status: res.status })
    } catch (err) {
      this.#failed(path, url, { error: err instanceof Error ? err.name : 'Error', reason: err instanceof Error ? String(scrub(err.message)).slice(0, 200) : undefined })
    }
  }

  // Telemetry must never break the app: say what wasn't sent, once per isolate until it works again, and move on.
  #failed(path: string, url: string, why: Record<string, unknown>) {
    if (this.#failing.has(path)) return
    this.#failing.add(path)
    console.error(JSON.stringify({ level: 'error', message: 'otlp.export.failed', detail: `${path === '/v1/traces' ? 'Traces' : 'Logs'} weren't sent to ${url}`, path, ...why }))
  }

  describe(): Manifest {
    return { name: 'OTLP exporter', use: 'Traces to Tempo and logs to Loki', personalInfo: [], storesIn: 'Grafana (Tempo, Loki)', egress: [this.#endpoint.hostname] }
  }
}
