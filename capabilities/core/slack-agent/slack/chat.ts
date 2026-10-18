import { NotAllowedError, UpstreamError } from '../../kernel/errors'
import { Port, type Manifest } from '../../kernel/port'
import type { SecretRef } from '../../secrets/secrets'
import { HttpClient, type Fetch } from '../../security/egress'
import type { Block } from './blocks'
import type { FileData } from '../tools/contract'

// Talking in Slack. A port, so the agent can be run end to end against
// MemoryChat in tests, and a Teams adapter would be a new class, not a rewrite.

export interface Place {
  channel: string
  /** Reply in this thread. Unset for a top-level DM. */
  thread?: string
}

export interface ChatMessageOut extends Place {
  /** Fallback for notifications and screen readers. Plain text. */
  text: string
  blocks?: Block[]
}

export abstract class Chat extends Port {
  abstract post(m: ChatMessageOut): Promise<{ ts: string }>
  abstract update(m: { channel: string; ts: string; text: string; blocks?: Block[] }): Promise<void>
  /** Only `user` sees it. */
  abstract ephemeral(m: ChatMessageOut & { user: string }): Promise<void>
  abstract react(m: { channel: string; ts: string; name: string }): Promise<void>
  /** A file someone shared, up to `maxBytes`. */
  abstract download(id: string, maxBytes: number): Promise<FileData>
  /** Shares a file in the channel or thread, e.g. an image a tool made, and returns its file id. */
  abstract upload(m: Upload): Promise<{ id: string }>
}

export interface Upload extends Place { name: string; title?: string; mimetype: string; bytes: Uint8Array }

/**
 * Slack's Web API with the bot token. Slack answers 200 with `ok: false` for
 * most failures, so both are checked. Only slack.com is reachable.
 */
export class SlackChat extends Chat {
  readonly #token: SecretRef
  readonly #http: HttpClient

  constructor(token: SecretRef, opts: { fetch?: Fetch } = {}) {
    super()
    this.#token = token
    // files.slack.com is where Slack keeps file bytes, for downloads and uploads.
    this.#http = new HttpClient({ service: 'Slack', allow: ['slack.com', 'files.slack.com'], fetch: opts.fetch })
  }

  async #call<T extends object>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.#http.request(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${(await this.#token.get()).reveal()}` },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string } & T
    if (!res.ok || !data.ok) throw new UpstreamError('Slack', res.status, `${method}: ${data.error ?? 'no reply'}`)
    return data
  }

  /** For methods that take form fields rather than JSON (the file ones). */
  async #form<T extends object>(method: string, fields: Record<string, string | undefined>): Promise<T> {
    const body = new URLSearchParams(Object.entries(fields).filter((e): e is [string, string] => e[1] !== undefined))
    const res = await this.#http.request(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${(await this.#token.get()).reveal()}` },
      body,
    })
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string } & T
    if (!res.ok || !data.ok) throw new UpstreamError('Slack', res.status, `${method}: ${data.error ?? 'no reply'}`)
    return data
  }

  async download(id: string, maxBytes: number): Promise<FileData> {
    const { file } = await this.#form<{ file: { name?: string; mimetype?: string; size?: number; url_private_download?: string; url_private?: string } }>('files.info', { file: id })
    if ((file.size ?? 0) > maxBytes) throw new NotAllowedError(`That file is over ${Math.round(maxBytes / 1024 / 1024)} MB`)
    const url = file.url_private_download ?? file.url_private
    if (!url) throw new UpstreamError('Slack', 200, 'files.info: no download link')
    const res = await this.#http.request(url, { headers: { authorization: `Bearer ${(await this.#token.get()).reveal()}` } })
    if (!res.ok) throw new UpstreamError('Slack', res.status, 'file download refused')
    // Slack answers a missing or unshared file with its sign-in page, not an error.
    if ((res.headers.get('content-type') ?? '').startsWith('text/html')) throw new UpstreamError('Slack', res.status, 'file download refused')
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new NotAllowedError(`That file is over ${Math.round(maxBytes / 1024 / 1024)} MB`)
    return { id, name: file.name ?? id, mimetype: file.mimetype ?? 'application/octet-stream', bytes }
  }

  async upload(m: Upload) {
    const { upload_url, file_id } = await this.#form<{ upload_url: string; file_id: string }>('files.getUploadURLExternal', { filename: m.name, length: String(m.bytes.byteLength) })
    const sent = await this.#http.request(upload_url, { method: 'POST', body: m.bytes })
    if (!sent.ok) throw new UpstreamError('Slack', sent.status, 'file upload refused')
    await this.#form('files.completeUploadExternal', { files: JSON.stringify([{ id: file_id, title: m.title ?? m.name }]), channel_id: m.channel, thread_ts: m.thread })
    return { id: file_id }
  }

  // Slack caps message text at 40,000 characters; the blocks carry the real content.
  #text = (t: string) => t.slice(0, 3000) || ' '

  async post(m: ChatMessageOut) {
    const r = await this.#call<{ ts: string }>('chat.postMessage', { channel: m.channel, thread_ts: m.thread, text: this.#text(m.text), blocks: m.blocks, unfurl_links: false })
    return { ts: r.ts }
  }

  async update(m: { channel: string; ts: string; text: string; blocks?: Block[] }) {
    await this.#call('chat.update', { channel: m.channel, ts: m.ts, text: this.#text(m.text), blocks: m.blocks ?? [] })
  }

  async ephemeral(m: ChatMessageOut & { user: string }) {
    await this.#call('chat.postEphemeral', { channel: m.channel, user: m.user, thread_ts: m.thread, text: this.#text(m.text), blocks: m.blocks })
  }

  async react(m: { channel: string; ts: string; name: string }) {
    await this.#call('reactions.add', { channel: m.channel, timestamp: m.ts, name: m.name }).catch(err => {
      // Reacting twice isn't a failure.
      if (!(err instanceof UpstreamError && err.message.includes('already_reacted'))) throw err
    })
  }

  describe(): Manifest {
    return {
      name: 'Slack Web API',
      use: 'Replying, asking for approval and showing results in Slack',
      personalInfo: ['whatever people write to it', 'Slack user ids'],
      usesAi: false,
      storesIn: 'The Slack workspace',
      egress: ['slack.com', 'files.slack.com'],
    }
  }
}

/** Records everything, like a fake Slack. For tests and dry runs. */
export class MemoryChat extends Chat {
  readonly posted: (ChatMessageOut & { ts: string })[] = []
  readonly updated: { channel: string; ts: string; text: string; blocks?: Block[] }[] = []
  readonly ephemerals: (ChatMessageOut & { user: string })[] = []
  readonly reactions: { channel: string; ts: string; name: string }[] = []
  /** Files people "shared", by id, for downloads. */
  readonly files = new Map<string, FileData>()
  readonly uploads: Upload[] = []
  #n = 0

  async post(m: ChatMessageOut) {
    const ts = `1700000000.${String(++this.#n).padStart(6, '0')}`
    this.posted.push(structuredClone({ ...m, ts }))
    return { ts }
  }
  async update(m: { channel: string; ts: string; text: string; blocks?: Block[] }) { this.updated.push(structuredClone(m)) }
  async ephemeral(m: ChatMessageOut & { user: string }) { this.ephemerals.push(structuredClone(m)) }
  async react(m: { channel: string; ts: string; name: string }) { this.reactions.push(m) }
  async download(id: string, maxBytes: number) {
    const f = this.files.get(id)
    if (!f) throw new UpstreamError('Slack', 200, 'files.info: file_not_found')
    if (f.bytes.byteLength > maxBytes) throw new NotAllowedError('That file is too big')
    return { ...f, bytes: f.bytes.slice() }
  }
  /** Kept in `files` too, as Slack would, so a later tool can download it. */
  async upload(m: Upload) {
    const id = `FMADE${String(this.uploads.length + 1).padStart(4, '0')}`
    this.uploads.push({ ...m, bytes: m.bytes.slice() })
    this.files.set(id, { id, name: m.name, mimetype: m.mimetype, bytes: m.bytes.slice() })
    return { id }
  }

  describe(): Manifest {
    return { name: 'Memory chat', use: 'Tests', personalInfo: [], storesIn: 'Memory' }
  }
}
