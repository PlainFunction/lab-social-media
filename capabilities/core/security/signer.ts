import { Port } from '../kernel/port'
import { NotAllowedError } from '../kernel/errors'
import { b64url, fromB64url, fromUtf8, timingSafeEqual, utf8 } from '../kernel/encoding'
import type { Clock } from '../kernel/clock'
import type { SecretRef } from '../secrets/secrets'

export abstract class Signer extends Port {
  abstract sign(data: string): Promise<string>
  abstract verify(data: string, signature: string): Promise<boolean>
}

export class HmacSigner extends Signer {
  readonly #key: () => Promise<CryptoKey>
  #cached?: Promise<CryptoKey>

  constructor(secret: SecretRef | string) {
    super()
    this.#key = async () => {
      const raw = typeof secret === 'string' ? secret : (await secret.get()).reveal()
      if (raw.length < 32) throw new NotAllowedError('Signing key must be at least 32 characters')
      return crypto.subtle.importKey('raw', utf8(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    }
  }

  #load() {
    this.#cached ??= this.#key()
    return this.#cached
  }

  async sign(data: string) {
    return b64url(await crypto.subtle.sign('HMAC', await this.#load(), utf8(data)))
  }

  async verify(data: string, signature: string) {
    // crypto.subtle.verify compares in constant time.
    try {
      return await crypto.subtle.verify('HMAC', await this.#load(), fromB64url(signature), utf8(data))
    } catch {
      return false
    }
  }

  describe() {
    return { name: 'HMAC-SHA256', use: 'Signing links and tokens', personalInfo: [], storesIn: 'Nowhere' }
  }
}

export interface TokenClaims {
  /** What the token is for. A token for one purpose never passes as another. */
  purpose: string
  /** What it's about, e.g. an approval id. */
  sub: string
  /** Expiry, seconds since epoch. */
  exp: number
}

/**
 * Short, signed, purpose-bound tokens for links (approve this email, unsubscribe).
 * Not JWTs: there's one algorithm and nothing to negotiate, so nothing to downgrade.
 * A token proves the link is ours and unaltered. It doesn't prove who clicked it,
 * so anything that matters also checks identity (see ApprovalGate).
 */
export class TokenIssuer {
  readonly #signer: Signer
  readonly #clock: Clock
  constructor(signer: Signer, clock: Clock) {
    this.#signer = signer
    this.#clock = clock
  }

  async issue(purpose: string, sub: string, ttlSeconds: number): Promise<string> {
    const claims: TokenClaims = { purpose, sub, exp: Math.floor(this.#clock.now().getTime() / 1000) + ttlSeconds }
    const body = b64url(utf8(JSON.stringify(claims)))
    return `${body}.${await this.#signer.sign(body)}`
  }

  /** Returns the claims, or throws NotAllowedError. */
  async verify(token: string, purpose: string, sub: string): Promise<TokenClaims> {
    const [body, sig] = token.split('.')
    if (!body || !sig || !(await this.#signer.verify(body, sig))) throw new NotAllowedError('Bad token')
    let claims: TokenClaims
    try { claims = JSON.parse(fromUtf8(fromB64url(body))) } catch { throw new NotAllowedError('Bad token') }
    const want = utf8(`${purpose}\n${sub}`)
    const got = utf8(`${claims.purpose}\n${claims.sub}`)
    if (!timingSafeEqual(want, got)) throw new NotAllowedError('Token is for something else')
    if (claims.exp * 1000 < this.#clock.now().getTime()) throw new NotAllowedError('Token has expired')
    return claims
  }
}
