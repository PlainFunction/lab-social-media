import { Port } from '../kernel/port'
import { NotAllowedError } from '../kernel/errors'
import { b64url, fromB64, hex, timingSafeEqual, utf8 } from '../kernel/encoding'
import type { Clock } from '../kernel/clock'
import type { SecretRef } from '../secrets/secrets'

/**
 * Checks that an incoming webhook really came from the system that claims to
 * have sent it. Each sender signs differently, so each gets a subclass.
 * Read the body once, as text, and verify before parsing it.
 */
export abstract class WebhookVerifier extends Port {
  abstract verify(request: Request, rawBody: string): Promise<void>

  protected async hmac(key: string, body: string): Promise<Uint8Array<ArrayBuffer>> {
    const k = await crypto.subtle.importKey('raw', utf8(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, utf8(body)))
  }
}

/** Xero: `x-xero-signature` is base64(HMAC-SHA256(webhook key, raw body)). */
export class XeroWebhookVerifier extends WebhookVerifier {
  readonly #key: SecretRef
  constructor(key: SecretRef) {
    super()
    this.#key = key
  }
  async verify(request: Request, rawBody: string) {
    const given = request.headers.get('x-xero-signature')
    if (!given) throw new NotAllowedError('Unsigned webhook')
    const want = await this.hmac((await this.#key.get()).reveal(), rawBody)
    let got: Uint8Array
    try { got = fromB64(given) } catch { throw new NotAllowedError('Bad webhook signature') }
    // Xero expects a 401 for a bad signature as part of its "intent to receive" check.
    if (!timingSafeEqual(want, got)) throw new NotAllowedError('Bad webhook signature')
  }

  describe() {
    return { name: 'Xero webhook check', use: 'Proving a webhook really came from Xero', personalInfo: [], storesIn: 'Nowhere' }
  }
}

/**
 * Slack: `x-slack-signature` is `v0=` + hex HMAC-SHA256 of `v0:<timestamp>:<raw body>`
 * with the app's signing secret. The timestamp must be within five minutes,
 * so a captured request can't be replayed later.
 */
export class SlackWebhookVerifier extends WebhookVerifier {
  readonly #secret: SecretRef
  readonly #clock: Clock
  readonly #toleranceSeconds: number
  constructor(secret: SecretRef, clock: Clock, toleranceSeconds = 300) {
    super()
    this.#secret = secret
    this.#clock = clock
    this.#toleranceSeconds = toleranceSeconds
  }

  /** The header value Slack would send. For tests and for our own signed test requests. */
  static async signature(secret: string, timestamp: number | string, rawBody: string): Promise<string> {
    const k = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return `v0=${hex(await crypto.subtle.sign('HMAC', k, utf8(`v0:${timestamp}:${rawBody}`)))}`
  }

  async verify(request: Request, rawBody: string) {
    const ts = request.headers.get('x-slack-request-timestamp') ?? ''
    const given = request.headers.get('x-slack-signature')
    if (!given || !/^\d{1,12}$/.test(ts)) throw new NotAllowedError('Unsigned webhook')
    if (Math.abs(this.#clock.now().getTime() / 1000 - Number(ts)) > this.#toleranceSeconds) throw new NotAllowedError('Stale webhook')
    const want = await SlackWebhookVerifier.signature((await this.#secret.get()).reveal(), ts, rawBody)
    if (!timingSafeEqual(utf8(want), utf8(given))) throw new NotAllowedError('Bad webhook signature')
  }

  describe() {
    return { name: 'Slack request check', use: 'Proving an event or button click really came from Slack', personalInfo: [], storesIn: 'Nowhere' }
  }
}

/** Generic `x-signature: <base64url hmac>` for our own systems talking to each other. */
export class HmacWebhookVerifier extends WebhookVerifier {
  readonly #key: SecretRef
  readonly #header: string
  constructor(key: SecretRef, header = 'x-signature') {
    super()
    this.#key = key
    this.#header = header
  }
  async verify(request: Request, rawBody: string) {
    const given = request.headers.get(this.#header)
    const want = b64url(await this.hmac((await this.#key.get()).reveal(), rawBody))
    if (!given || !timingSafeEqual(utf8(given), utf8(want))) throw new NotAllowedError('Bad webhook signature')
  }

  describe() {
    return { name: 'HMAC webhook check', use: 'Proving a webhook came from one of our own systems', personalInfo: [], storesIn: 'Nowhere' }
  }
}
