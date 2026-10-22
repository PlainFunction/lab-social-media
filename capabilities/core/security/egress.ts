import { NotAllowedError, UpstreamError } from '../kernel/errors'
import { activeTelemetry } from '../telemetry/context'

export type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>

export interface HttpClientOptions {
  /** Who we're calling, for error messages. */
  service: string
  /** Hosts this client may reach. Exact names, or `*.example.com` for subdomains. */
  allow: string[]
  timeoutMs?: number
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: Fetch
  /** Open a client span per call when telemetry is active. Default true; the OTLP exporter turns it off. */
  traced?: boolean
  /** Also plain http to this machine (an allowed localhost, 127.0.0.1 or [::1]). Only the OTLP exporter sets it, for a collector in dev. */
  loopbackHttp?: boolean
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Outbound HTTP with an allowlist. Each adapter gets its own client that can
 * only reach the hosts it declares, over HTTPS, without following redirects.
 * So a bug, or a prompt-injected URL in an email, can't make the Xero adapter
 * post data somewhere else.
 */
export class HttpClient {
  readonly service: string
  readonly allow: readonly string[]
  readonly #timeoutMs: number
  readonly #fetch: Fetch
  readonly #traced: boolean
  readonly #loopbackHttp: boolean

  constructor(opts: HttpClientOptions) {
    this.service = opts.service
    this.allow = opts.allow
    this.#timeoutMs = opts.timeoutMs ?? 15_000
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.#traced = opts.traced ?? true
    this.#loopbackHttp = opts.loopbackHttp ?? false
  }

  allows(url: URL): boolean {
    const local = this.#loopbackHttp && url.protocol === 'http:' && LOOPBACK.has(url.hostname)
    if (url.protocol !== 'https:' && !local) return false
    return this.allow.some(rule => rule.startsWith('*.') ? url.hostname.endsWith(rule.slice(1)) : url.hostname === rule)
  }

  async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url)
    if (!this.allows(u)) throw new NotAllowedError(`${this.service} may not call ${u.protocol}//${u.hostname}`)
    const active = this.#traced ? activeTelemetry() : undefined
    if (!active) return this.#send(u, init)

    // Host and status only: paths and query strings can hold ids, and sometimes worse.
    const method = (init.method ?? 'GET').toUpperCase()
    return active.telemetry.inSpan(`${method} ${u.hostname}`, {
      kind: 'client',
      attrs: { 'http.request.method': method, 'server.address': u.hostname, 'url.scheme': 'https', 'pf.service': this.service },
    }, async span => {
      const res = await this.#send(u, init)
      span.setAttribute('http.response.status_code', res.status)
      return res
    })
  }

  async #send(u: URL, init: RequestInit): Promise<Response> {
    const res = await this.#fetch(u, {
      ...init,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(this.#timeoutMs),
    })
    if (res.status >= 300 && res.status < 400) {
      throw new UpstreamError(this.service, res.status, 'redirect refused')
    }
    return res
  }

  /** Request and parse JSON. Throws UpstreamError on a non-2xx. */
  async json<T>(url: string | URL, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, init)
    if (!res.ok) throw new UpstreamError(this.service, res.status, await res.text().catch(() => ''))
    return (await res.json()) as T
  }
}
