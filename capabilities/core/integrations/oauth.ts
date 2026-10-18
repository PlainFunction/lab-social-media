import { Port, type Manifest } from '../kernel/port'
import { ConfigError, NotAllowedError, UpstreamError } from '../kernel/errors'
import { b64url, randomBytes, randomId, sha256Hex } from '../kernel/encoding'
import type { Clock } from '../kernel/clock'
import type { Cache } from '../cache/cache'
import type { Cipher } from '../security/cipher'
import { HttpClient, type Fetch } from '../security/egress'
import type { SecretRef, SecretStore } from '../secrets/secrets'
import type { AuditLog } from '../audit/audit-log'

interface TokenResponse { access_token: string; expires_in: number; refresh_token?: string }
interface CachedToken { token: string; exp: number }

/** What a token endpoint sends back. */
export interface TokenReply { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string }

/**
 * One token request, for every flow: client credentials, refresh tokens and
 * authorisation codes. `basic` sends the client in an Authorization header
 * (Xero, MYOB); `body` sends it as form fields (GitHub). Never echoes the
 * response, because token endpoints sometimes repeat what was sent.
 */
export async function requestToken(o: {
  http: HttpClient
  tokenUrl: string
  grant: URLSearchParams | Record<string, string>
  clientId: string
  clientSecret: string
  clientAuth: 'basic' | 'body'
}): Promise<TokenReply> {
  const body = new URLSearchParams(o.grant)
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  if (o.clientAuth === 'basic') headers.authorization = `Basic ${btoa(`${o.clientId}:${o.clientSecret}`)}`
  else { body.set('client_id', o.clientId); body.set('client_secret', o.clientSecret) }
  const res = await o.http.request(o.tokenUrl, { method: 'POST', headers, body })
  if (!res.ok) throw new UpstreamError(o.http.service, res.status, 'token request refused')
  const reply = await res.json().catch(() => ({})) as Partial<TokenReply> & { error?: unknown }
  // Some providers (GitHub) say no with a 200 and an error field. Its code is safe to show; the rest isn't.
  if (reply.error || !reply.access_token) {
    throw new UpstreamError(o.http.service, res.status, typeof reply.error === 'string' ? reply.error.slice(0, 60) : 'no access token')
  }
  return reply as TokenReply
}

export interface OAuthOptions {
  http: HttpClient
  tokenUrl: string
  clientId: SecretRef
  clientSecret: SecretRef
  /** Should include a KV layer, so every isolate shares one access token. */
  cache: Cache
  cacheKey: string
  clock: Clock
}

/**
 * Hands out an access token for a connected system, shared through the cache
 * (KV underneath, encrypted) until just before it expires. Subclasses decide
 * how to get a new one.
 *
 * Keep tokens fresh from cron with refreshIfDue(): a cron trigger runs once per
 * schedule, so it's the one place a refresh normally happens, and requests only
 * ever read the shared token.
 */
export abstract class OAuthTokenProvider extends Port {
  protected readonly http: HttpClient
  protected readonly tokenUrl: string
  protected readonly clientId: SecretRef
  protected readonly clientSecret: SecretRef
  protected readonly clock: Clock
  readonly #cache: Cache
  readonly #cacheKey: string
  #inflight?: Promise<string>

  constructor(opts: OAuthOptions) {
    super()
    this.http = opts.http
    this.tokenUrl = opts.tokenUrl
    this.clientId = opts.clientId
    this.clientSecret = opts.clientSecret
    this.clock = opts.clock
    this.#cache = opts.cache
    this.#cacheKey = opts.cacheKey
  }

  protected abstract grant(): Promise<URLSearchParams>
  /** Called with the response, e.g. to keep a rotated refresh token. */
  protected async received(_res: TokenResponse): Promise<void> {}

  /** The shared token, if it has at least `minSeconds` left. */
  protected async cached(minSeconds = 60): Promise<string | undefined> {
    const hit = await this.#cache.get<CachedToken>(this.#cacheKey)
    return hit && hit.exp - this.clock.now().getTime() > minSeconds * 1000 ? hit.token : undefined
  }

  async accessToken(): Promise<string> {
    return (await this.cached()) ?? this.#once()
  }

  /** For cron: refresh when less than `minSeconds` is left. Returns whether it refreshed. */
  async refreshIfDue(minSeconds = 20 * 60): Promise<boolean> {
    if (await this.cached(minSeconds)) return false
    await this.#once()
    return true
  }

  // One refresh at a time per isolate: rotating refresh tokens punish a second concurrent use.
  #once() {
    this.#inflight ??= this.refresh().finally(() => { this.#inflight = undefined })
    return this.#inflight
  }

  /** Gets a new token and shares it. Subclasses wrap this to coordinate across isolates. */
  protected async refresh(): Promise<string> {
    const body = await requestToken({
      http: this.http, tokenUrl: this.tokenUrl, grant: await this.grant(), clientAuth: 'basic',
      clientId: (await this.clientId.get()).reveal(), clientSecret: (await this.clientSecret.get()).reveal(),
    }) as TokenResponse
    await this.received(body)
    // Shared until two minutes before expiry. Xero tokens last 30 minutes, MYOB's 20.
    const ttl = (body.expires_in ?? 0) - 120
    if (ttl > 0) {
      await this.#cache.set<CachedToken>(this.#cacheKey, { token: body.access_token, exp: this.clock.now().getTime() + body.expires_in * 1000 }, ttl)
    }
    return body.access_token
  }

  /** Forget the shared token, e.g. after a 401. */
  async reset() { await this.#cache.delete(this.#cacheKey) }

  describe() {
    return { name: `${this.http.service} OAuth`, use: `Signing in to ${this.http.service}`, personalInfo: [], storesIn: 'Access token in KV, encrypted', egress: [...this.http.allow] }
  }
}

/** For single-organisation app credentials (Xero custom connections, MYOB). No refresh token to look after. */
export class ClientCredentialsProvider extends OAuthTokenProvider {
  readonly #scope?: string
  constructor(opts: OAuthOptions & { scope?: string }) {
    super(opts)
    this.#scope = opts.scope
  }
  protected async grant() {
    const p = new URLSearchParams({ grant_type: 'client_credentials' })
    if (this.#scope) p.set('scope', this.#scope)
    return p
  }
}

/**
 * Refresh-token flow. Xero and MYOB rotate the refresh token on every use, so
 * the new one is sealed and written back to KV straight away. The first token
 * comes from a one-off consent done by the owner (seed it with `seed()`).
 *
 * Spending a refresh token twice can lock us out, and KV has no atomic lock
 * (a write can take up to a minute to reach other locations). So instead:
 *   1. Cron refreshes ahead of expiry, so requests almost never need to.
 *   2. A request that must refresh takes a KV lease first. Anyone who sees the
 *      lease waits for the new access token instead of spending the refresh token.
 *   3. If the refresh token is refused (someone else already rotated it), wait
 *      for their access token to land in KV rather than failing straight away.
 * Two isolates in different locations, both with a cold cache, in the same few
 * seconds, can still collide. Cron makes that unlikely; if it happens the
 * automation fails, we're told, and the owner reconnects.
 */
export class RefreshTokenProvider extends OAuthTokenProvider {
  readonly #kv: KVNamespace
  readonly #cipher: Cipher
  readonly #key: string
  readonly #leaseKey: string
  readonly #waitMs: number
  readonly #sleep: (ms: number) => Promise<void>

  constructor(opts: OAuthOptions & { kv: KVNamespace; cipher: Cipher; vaultKey: string; waitMs?: number; sleep?: (ms: number) => Promise<void> }) {
    super(opts)
    this.#kv = opts.kv
    this.#cipher = opts.cipher
    this.#key = `oauth-refresh:${opts.vaultKey}`
    this.#leaseKey = `oauth-lease:${opts.vaultKey}`
    this.#waitMs = opts.waitMs ?? 5000
    this.#sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  }

  async seed(refreshToken: string) {
    await this.#kv.put(this.#key, await this.#cipher.encryptText(refreshToken, this.#key))
  }

  protected async grant() {
    const sealed = await this.#kv.get(this.#key)
    if (!sealed) throw new ConfigError(`${this.http.service} isn't connected yet (no refresh token)`)
    return new URLSearchParams({ grant_type: 'refresh_token', refresh_token: await this.#cipher.decryptText(sealed, this.#key) })
  }

  protected async received(res: TokenResponse) {
    if (res.refresh_token) await this.seed(res.refresh_token)
  }

  /** Polls the shared cache for a token someone else is fetching. */
  async #waitForOthers(): Promise<string | undefined> {
    for (let waited = 0; waited < this.#waitMs; waited += 500) {
      await this.#sleep(500)
      const t = await this.cached()
      if (t) return t
    }
    return undefined
  }

  protected async refresh(): Promise<string> {
    if (await this.#kv.get(this.#leaseKey)) {
      const theirs = await this.#waitForOthers()
      if (theirs) return theirs
      // The lease holder gave up or died. Its lease expires on its own; go ahead.
    }

    const lease = randomId()
    await this.#kv.put(this.#leaseKey, lease, { expirationTtl: 60 })
    try {
      return await super.refresh()
    } catch (err) {
      if (err instanceof UpstreamError && (err.status === 400 || err.status === 401)) {
        const theirs = await this.#waitForOthers()
        if (theirs) return theirs
      }
      throw err
    } finally {
      if ((await this.#kv.get(this.#leaseKey)) === lease) await this.#kv.delete(this.#leaseKey)
    }
  }
}

// ── Accounts connected by someone, through the browser ──────────────────────
//
// For systems a person signs in to and approves (GitHub, Google), rather than
// app credentials we hold. They open a link, approve, and the provider sends
// them back with a code. The token is sealed into a TokenVault and only ever
// used by code that attaches it to a request, never shown.

export interface OAuthProvider {
  /** Lower case letters, digits and _. Also the credential's name. */
  name: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string
  /** The only hosts its token may be sent to. */
  hosts: string[]
  /** Where to ask which account it is, and the field that names it. */
  whoami?: { url: string; field: string }
  /** How the client id and secret are sent. Default `body`. */
  clientAuth?: 'basic' | 'body'
}

export const OAUTH_PRESETS: Record<string, Omit<OAuthProvider, 'name'>> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: 'read:user',
    hosts: ['api.github.com'],
    whoami: { url: 'https://api.github.com/user', field: 'login' },
  },
}

const PROVIDER_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

const https = (where: string, url: string) => {
  let u: URL
  try { u = new URL(url) } catch { throw new ConfigError(`${where} isn't a URL`) }
  if (u.protocol !== 'https:') throw new ConfigError(`${where} must be https`)
  return u
}

/**
 * Providers from config, as JSON: `{"github":{"scopes":"read:user repo"}}`,
 * each merged over a preset if there is one. `where` names the setting in errors.
 */
export function parseOAuthProviders(raw: string | undefined, where = 'OAUTH_PROVIDERS'): OAuthProvider[] {
  if (!raw) return []
  let given: Record<string, Partial<OAuthProvider>>
  try { given = JSON.parse(raw) } catch { throw new ConfigError(`${where} is not valid JSON`) }
  return Object.entries(given).map(([name, p]) => {
    if (!PROVIDER_NAME.test(name)) throw new ConfigError(`OAuth provider name ${name} must be lower case letters, digits and _`)
    const merged = { ...(Object.hasOwn(OAUTH_PRESETS, name) ? OAUTH_PRESETS[name] : {}), ...p, name } as OAuthProvider
    for (const k of ['authorizeUrl', 'tokenUrl'] as const) {
      if (!merged[k]) throw new ConfigError(`${where}.${name}.${k} is missing`)
      https(`${where}.${name}.${k}`, merged[k])
    }
    if (!Array.isArray(merged.hosts) || merged.hosts.length === 0) throw new ConfigError(`${where}.${name}.hosts is missing`)
    if (merged.whoami && !merged.hosts.includes(https(`${where}.${name}.whoami`, merged.whoami.url).hostname)) {
      throw new ConfigError(`${where}.${name}.whoami must be on one of its hosts`)
    }
    return { ...merged, scopes: merged.scopes ?? '' }
  })
}

export interface Connection {
  access: string
  refresh?: string
  /** ISO time, when the provider said the access token expires. */
  expiresAt?: string
  /** Which account it is, e.g. a GitHub login. */
  account?: string
  /** Who connected it. */
  by: string
  at: string
}

export type ConnectionInfo = Pick<Connection, 'account' | 'by' | 'at'> & { name: string }

/** Connected accounts' tokens. Write and use only: nothing shows a token back to a person. */
export abstract class TokenVault extends Port {
  abstract get(name: string): Promise<Connection | undefined>
  abstract put(name: string, c: Connection): Promise<void>
  abstract remove(name: string): Promise<boolean>
  /** Names, accounts and who connected them. Never tokens. */
  abstract list(): Promise<ConnectionInfo[]>
}

export class MemoryTokenVault extends TokenVault {
  readonly #rows = new Map<string, Connection>()
  async get(name: string) { const c = this.#rows.get(name); return c ? { ...c } : undefined }
  async put(name: string, c: Connection) { this.#rows.set(name, { ...c }) }
  async remove(name: string) { return this.#rows.delete(name) }
  async list() { return [...this.#rows].sort(([a], [b]) => a.localeCompare(b)).map(([name, c]) => ({ name, account: c.account, by: c.by, at: c.at })) }
  describe(): Manifest { return { name: 'Memory token vault', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}

/** `connected_accounts` table. Tokens sealed and bound to the account's name. */
export class D1TokenVault extends TokenVault {
  readonly #db: D1Database
  readonly #cipher: Cipher
  constructor(db: D1Database, cipher: Cipher) { super(); this.#db = db; this.#cipher = cipher }

  async get(name: string) {
    const r = await this.#db.prepare('SELECT sealed FROM connected_accounts WHERE name = ?').bind(name).first<{ sealed: string }>()
    return r ? this.#cipher.decryptJson<Connection>(r.sealed, `connected-account:${name}`) : undefined
  }

  async put(name: string, c: Connection) {
    await this.#db.prepare('INSERT INTO connected_accounts (name, sealed, account, connected_by, connected_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, account = excluded.account, connected_by = excluded.connected_by, connected_at = excluded.connected_at')
      .bind(name, await this.#cipher.encryptJson(c, `connected-account:${name}`), c.account ?? null, c.by, c.at).run()
  }

  async remove(name: string) {
    return (await this.#db.prepare('DELETE FROM connected_accounts WHERE name = ?').bind(name).run()).meta.changes === 1
  }

  async list() {
    const { results } = await this.#db.prepare('SELECT name, account, connected_by, connected_at FROM connected_accounts ORDER BY name').all<{ name: string; account: string | null; connected_by: string; connected_at: string }>()
    return results.map(r => ({ name: r.name, account: r.account ?? undefined, by: r.connected_by, at: r.connected_at }))
  }

  describe(): Manifest {
    return { name: 'D1 token vault', use: 'Tokens for accounts people connected', personalInfo: ['account name'], storesIn: 'Cloudflare D1, Oceania, AES-256-GCM encrypted' }
  }
}

interface StartState { provider: string; verifier: string; by: string; context: Record<string, string> }

/** What a finished connection says, for telling the person. `context` is what was passed to `start`. */
export interface Connected { provider: string; account?: string; by: string; context: Record<string, string> }

const STATE_TTL_MS = 10 * 60_000

/**
 * Connecting accounts by the authorisation code flow, and using them after.
 *
 * - start: a one-time state (only its hash is stored, 10 minutes) and a PKCE challenge.
 * - finish: each state works once, because D1's `DELETE ... RETURNING` is the
 *   compare-and-set. The code is swapped for a token and sealed into the vault.
 * - token: refreshes when less than a minute is left. Rotating refresh tokens
 *   punish a second use, so call it from one place at a time (a queue consumer
 *   with max_concurrency 1, or cron), or put a lease in front, as RefreshTokenProvider does.
 *
 * Client ids and secrets are the secrets `OAUTH_<NAME>_CLIENT_ID` and `OAUTH_<NAME>_CLIENT_SECRET`.
 */
export class ConnectedAccounts {
  readonly #providers: Map<string, OAuthProvider>
  readonly #vault: TokenVault
  readonly #db: D1Database
  readonly #cipher: Cipher
  readonly #secrets: SecretStore
  readonly #audit: AuditLog
  readonly #clock: Clock
  readonly #redirectUri?: string
  readonly #actor: (by: string) => string
  readonly #fetch?: Fetch

  constructor(o: {
    providers: OAuthProvider[]; vault: TokenVault; db: D1Database; cipher: Cipher; secrets: SecretStore; audit: AuditLog; clock: Clock
    /** Where the provider sends people back. Without it, `start` refuses. */
    redirectUri?: string
    /** How `by` is written in the audit log, e.g. `by => 'slack:' + by`. */
    actor?: (by: string) => string
    fetch?: Fetch
  }) {
    this.#providers = new Map(o.providers.map(p => [p.name, p]))
    this.#vault = o.vault
    this.#db = o.db
    this.#cipher = o.cipher
    this.#secrets = o.secrets
    this.#audit = o.audit
    this.#clock = o.clock
    this.#redirectUri = o.redirectUri
    this.#actor = o.actor ?? (by => by)
    this.#fetch = o.fetch
  }

  get names() { return [...this.#providers.keys()] }
  provider(name: string) { return this.#providers.get(name) }
  list() { return this.#vault.list() }

  /** Hosts each account's token may go to. */
  hosts(): Record<string, string[]> {
    return Object.fromEntries([...this.#providers.values()].map(p => [p.name, p.hosts]))
  }

  get redirectUri() {
    if (!this.#redirectUri) throw new ConfigError('No redirect URI is set, so OAuth has nowhere to come back to')
    return this.#redirectUri
  }

  #client(p: OAuthProvider) {
    const up = p.name.toUpperCase()
    return Promise.all([this.#secrets.get(`OAUTH_${up}_CLIENT_ID`), this.#secrets.get(`OAUTH_${up}_CLIENT_SECRET`)])
  }

  /** The link to send the person to. Only they should see it: whoever opens it connects their own account. */
  async start(o: { provider: string; by: string; context?: Record<string, string> }): Promise<string> {
    const p = this.#providers.get(o.provider)
    if (!p) throw new NotAllowedError(`No OAuth provider called ${o.provider}`)
    const [clientId] = await this.#client(p)
    const state = randomId()
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const id = await sha256Hex(state)
    const payload: StartState = { provider: p.name, verifier, by: o.by, context: o.context ?? {} }
    await this.#db.prepare('INSERT INTO oauth_states (id, payload, expires_at) VALUES (?, ?, ?)')
      .bind(id, await this.#cipher.encryptJson(payload, `oauth-state:${id}`), new Date(this.#clock.now().getTime() + STATE_TTL_MS).toISOString()).run()

    const url = new URL(p.authorizeUrl)
    url.search = new URLSearchParams({
      client_id: clientId.reveal(), redirect_uri: this.redirectUri, response_type: 'code', scope: p.scopes,
      state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString()
    return url.toString()
  }

  /** The callback. */
  async finish(state: string, code: string): Promise<Connected> {
    const id = await sha256Hex(state)
    const row = await this.#db.prepare('DELETE FROM oauth_states WHERE id = ? RETURNING payload, expires_at').bind(id).first<{ payload: string; expires_at: string }>()
    if (!row) throw new NotAllowedError('Unknown or used OAuth state')
    if (row.expires_at <= this.#clock.now().toISOString()) throw new NotAllowedError('OAuth link has expired')
    const s = await this.#cipher.decryptJson<StartState>(row.payload, `oauth-state:${id}`)
    const p = this.#providers.get(s.provider)
    if (!p) throw new NotAllowedError('That provider is no longer set up')

    const reply = await this.#token(p, { grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: s.verifier })
    const account = await this.#whoami(p, reply.access_token)
    const now = this.#clock.now()
    await this.#vault.put(p.name, {
      access: reply.access_token, refresh: reply.refresh_token, account, by: s.by, at: now.toISOString(),
      expiresAt: reply.expires_in ? new Date(now.getTime() + reply.expires_in * 1000).toISOString() : undefined,
    })
    await this.#audit.record({ actor: this.#actor(s.by), action: 'credential.connected', subject: `credential:${p.name}`, detail: { account: account ?? null } })
    return { provider: p.name, account, by: s.by, context: s.context }
  }

  /** A usable access token, refreshed first if it's about to run out. Undefined if never connected. */
  async token(name: string): Promise<string | undefined> {
    const c = await this.#vault.get(name)
    if (!c) return undefined
    if (!c.expiresAt || Date.parse(c.expiresAt) - this.#clock.now().getTime() > 60_000) return c.access
    const p = this.#providers.get(name)
    if (!c.refresh || !p) throw new ConfigError(`${name} needs connecting again`)
    const reply = await this.#token(p, { grant_type: 'refresh_token', refresh_token: c.refresh })
    const now = this.#clock.now()
    await this.#vault.put(name, {
      ...c, access: reply.access_token, refresh: reply.refresh_token ?? c.refresh,
      expiresAt: reply.expires_in ? new Date(now.getTime() + reply.expires_in * 1000).toISOString() : undefined,
    })
    await this.#audit.record({ actor: 'system:oauth', action: 'credential.refreshed', subject: `credential:${name}` })
    return reply.access_token
  }

  /** Links nobody finished. Run from cron. */
  async pruneStates(): Promise<number> {
    return (await this.#db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(this.#clock.now().toISOString()).run()).meta.changes
  }

  async disconnect(name: string, by: string): Promise<boolean> {
    const removed = await this.#vault.remove(name)
    if (removed) await this.#audit.record({ actor: this.#actor(by), action: 'credential.disconnected', subject: `credential:${name}` })
    return removed
  }

  async #token(p: OAuthProvider, grant: Record<string, string>): Promise<TokenReply> {
    const [id, secret] = await this.#client(p)
    return requestToken({
      http: new HttpClient({ service: `${p.name} OAuth`, allow: [new URL(p.tokenUrl).hostname], fetch: this.#fetch }),
      tokenUrl: p.tokenUrl, grant, clientId: id.reveal(), clientSecret: secret.reveal(), clientAuth: p.clientAuth ?? 'body',
    })
  }

  async #whoami(p: OAuthProvider, token: string): Promise<string | undefined> {
    if (!p.whoami) return undefined
    try {
      const http = new HttpClient({ service: p.name, allow: p.hosts, fetch: this.#fetch })
      const me = await http.json<Record<string, unknown>>(p.whoami.url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'plainfunction-capabilities' } })
      const v = me[p.whoami.field]
      return typeof v === 'string' ? v.slice(0, 200) : undefined
    } catch {
      // Knowing the account is nice to have; the connection still works.
      return undefined
    }
  }
}
