import type { AuditLog } from '../../audit/audit-log'
import { NotAllowedError } from '../../kernel/errors'
import { Port, type Manifest } from '../../kernel/port'
import type { SecretStore } from '../../secrets/secrets'
import { HttpClient, type Fetch } from '../../security/egress'
// Tools ask for a credential by name; this attaches it. A credential is an
// account connected from Slack by OAuth (sealed in the vault), or else a
// Worker secret on this Worker (CREDENTIAL_<NAME>), set with our secrets
// tooling. Neither can be read back, and each can only go to its own hosts.
// A credential can also list upload hosts: presigned storage URLs its API
// hands out, which tools reach in its name but never with it attached.

/** Where connected accounts' tokens come from. ConnectedAccounts in production. */
export interface ConnectedTokens {
  token(name: string): Promise<string | undefined>
  hosts(): Record<string, string[]>
}

/**
 * Hosts per credential: the hosts it's sent to, or those plus `uploads`, hosts
 * reached in its name without it (a presigned upload URL carries its own signature).
 */
export type CredentialHosts = Record<string, string[] | { hosts: string[]; uploads?: string[] }>

export class CredentialBroker extends Port {
  readonly #secrets: SecretStore
  readonly #hosts: Record<string, string[]>
  readonly #uploads: Record<string, string[]>
  readonly #audit: AuditLog
  readonly #connected?: ConnectedTokens
  readonly #fetch?: Fetch

  /**
   * `hosts` maps a credential name to the hosts it may be sent to, e.g. `{ github: ['api.github.com'] }`,
   * or `{ zernio: { hosts: ['zernio.com'], uploads: ['*.r2.cloudflarestorage.com'] } }`.
   */
  constructor(o: { secrets: SecretStore; hosts: CredentialHosts; audit: AuditLog; connected?: ConnectedTokens; fetch?: Fetch }) {
    super()
    this.#secrets = o.secrets
    const entries = Object.entries(o.hosts).map(([name, h]) => [name, Array.isArray(h) ? { hosts: h } : h] as const)
    // A provider's hosts win: they're what the token was issued for.
    this.#hosts = { ...Object.fromEntries(entries.map(([n, h]) => [n, h.hosts])), ...o.connected?.hosts() }
    this.#uploads = Object.fromEntries(entries.map(([n, h]) => [n, h.uploads ?? []]))
    this.#audit = o.audit
    this.#connected = o.connected
    this.#fetch = o.fetch
  }

  async fetch(url: string, init: RequestInit & { credential?: string } = {}, who: { tool: string }): Promise<Response> {
    const { credential, ...rest } = init
    // Tools only call out through a named credential, so every call they make is one we listed.
    if (!credential) throw new NotAllowedError('Tools call out only with a named credential')
    const hosts = Object.hasOwn(this.#hosts, credential) ? this.#hosts[credential] : undefined
    if (!hosts?.length) throw new NotAllowedError(`No credential called ${credential}`)

    // An upload host gets the request as the tool wrote it. The credential never goes there.
    const uploads = Object.hasOwn(this.#uploads, credential) ? this.#uploads[credential] : []
    const upload = new HttpClient({ service: `credential ${credential} uploads`, allow: uploads, fetch: this.#fetch })
    if (upload.allows(new URL(url))) {
      const res = await upload.request(url, rest)
      await this.#audit.record({ actor: `system:${who.tool}`, action: 'credential.upload', subject: `credential:${credential}`, detail: { host: new URL(url).hostname, status: res.status } })
      return res
    }

    const http = new HttpClient({ service: `credential ${credential}`, allow: hosts, fetch: this.#fetch })
    const secret = (await this.#connected?.token(credential))
      ?? (await this.#secrets.optional(`CREDENTIAL_${credential.toUpperCase()}`))?.reveal()
    if (!secret) throw new NotAllowedError(`${credential} isn't connected. An admin can say "connect ${credential}".`)

    const headers = new Headers(rest.headers)
    headers.set('authorization', `Bearer ${secret}`)
    const res = await http.request(url, { ...rest, headers })
    await this.#audit.record({ actor: `system:${who.tool}`, action: 'credential.used', subject: `credential:${credential}`, detail: { host: new URL(url).hostname, status: res.status } })

    // Some APIs echo the token back (in errors, mostly). The tool gets the body with it taken out.
    const body = (await res.text()).replaceAll(secret, '[credential]')
    const out = new Headers(res.headers)
    out.delete('set-cookie')
    return new Response(body, { status: res.status, headers: out })
  }

  describe(): Manifest {
    return {
      name: 'Credential broker',
      use: 'Attaching an API key to a tool\'s request without the tool seeing it',
      personalInfo: [],
      storesIn: 'Connected accounts in the D1 vault, or Worker secrets (CREDENTIAL_<NAME>)',
      egress: [...new Set([...Object.values(this.#hosts), ...Object.values(this.#uploads)].flat())],
    }
  }
}
