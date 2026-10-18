import { UpstreamError } from '../kernel/errors'
import type { Manifest } from '../kernel/port'
import { SocialPublisher, type MediaFile, type NewPost, type PostResult, type SocialAccount } from './publisher'

// Zernio (zernio.com) posts to Instagram for us: one API key, accounts
// connected in Zernio's dashboard. Shapes follow docs.zernio.com.
//
//   GET  /v1/accounts        { accounts: [{ _id, platform, username, displayName?, isActive }] }
//   POST /v1/media/presign   { filename, contentType, size } → { uploadUrl, publicUrl }
//   PUT  uploadUrl           the bytes, no Authorization (it's presigned storage)
//   POST /v1/posts           { content, mediaItems, platforms, publishNow | scheduledFor + timezone }
//                            → 201, or 207 when Instagram refused it, with { post }

export const ZERNIO_API = 'https://zernio.com/api/v1'
/** Where Zernio's presigned uploads go: Cloudflare R2. List these as the credential's upload hosts. */
export const ZERNIO_UPLOAD_HOSTS = ['*.r2.cloudflarestorage.com']

/**
 * How the adapter reaches Zernio. In a Slack agent tool that's `ctx.fetch` with
 * the credential named, so the key is attached outside the tool and only to
 * Zernio's hosts.
 */
export type ZernioCall = (url: string, init?: RequestInit) => Promise<Response>

interface ZernioAccount { _id: string; platform: string; username?: string; displayName?: string; isActive?: boolean }
interface ZernioPost {
  _id: string
  status: string
  platforms?: { platform: string; status?: string; platformPostUrl?: string; errorMessage?: string }[]
}

const https = (u: unknown) => typeof u === 'string' && u.startsWith('https://') ? u : undefined

export class ZernioPublisher extends SocialPublisher {
  readonly #call: ZernioCall
  readonly #base: string

  constructor(call: ZernioCall, base = ZERNIO_API) {
    super()
    this.#call = call
    this.#base = base
  }

  async #json<T>(path: string, init: RequestInit = {}, accept: number[] = []): Promise<T> {
    const res = await this.#call(`${this.#base}${path}`, {
      ...init,
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    })
    const body = await res.json().catch(() => undefined) as (T & { error?: string }) | undefined
    if (!res.ok && !accept.includes(res.status)) throw new UpstreamError('Zernio', res.status, body?.error ?? '')
    if (!body) throw new UpstreamError('Zernio', res.status, 'no JSON in the answer')
    return body
  }

  async accounts(): Promise<SocialAccount[]> {
    const { accounts = [] } = await this.#json<{ accounts?: ZernioAccount[] }>('/accounts')
    return accounts.flatMap(a => a.platform === 'instagram' && a.isActive !== false
      ? [{ id: a._id, name: a.displayName || a.username || a._id }]
      : [])
  }

  async upload(file: MediaFile): Promise<string> {
    const { uploadUrl, publicUrl } = await this.#json<{ uploadUrl?: string; publicUrl?: string }>('/media/presign', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, contentType: file.mimetype, size: file.bytes.byteLength }),
    })
    if (!https(uploadUrl) || !https(publicUrl)) throw new UpstreamError('Zernio', 200, 'no upload link in the answer')
    const put = await this.#call(uploadUrl!, { method: 'PUT', headers: { 'content-type': file.mimetype }, body: file.bytes })
    if (!put.ok) throw new UpstreamError('Zernio uploads', put.status)
    return publicUrl!
  }

  async publish(post: NewPost): Promise<PostResult> {
    const when = post.when.kind === 'now' ? { publishNow: true }
      : post.when.kind === 'scheduled' ? { scheduledFor: post.when.at, timezone: post.when.timeZone }
      // Neither publishNow nor scheduledFor: Zernio keeps it as a draft.
      : {}
    const extra = { ...(post.firstComment ? { firstComment: post.firstComment } : {}), ...(post.aiLabel ? { isAiGenerated: true } : {}) }
    // 207 means Instagram refused it after Zernio took it. The post says why.
    const { post: made } = await this.#json<{ post?: ZernioPost }>('/posts', {
      method: 'POST',
      body: JSON.stringify({
        content: post.caption,
        mediaItems: post.images.map(url => ({ type: 'image', url })),
        platforms: [{ platform: 'instagram', accountId: post.accountId, ...(Object.keys(extra).length ? { platformSpecificData: extra } : {}) }],
        ...when,
      }),
    }, [207])
    if (!made?._id) throw new UpstreamError('Zernio', 200, 'no post in the answer')
    const mine = made.platforms?.find(p => p.platform === 'instagram')
    // The post's status says where it is (scheduled, draft); Instagram's own only matters when it failed.
    return { id: made._id, status: mine?.status === 'failed' ? 'failed' : made.status, url: https(mine?.platformPostUrl), error: mine?.errorMessage?.slice(0, 300) }
  }

  describe(): Manifest {
    return {
      name: 'Zernio (Instagram)',
      use: "Posting to the business's Instagram, after someone approves the post in Slack",
      personalInfo: ['whatever the post says or shows'],
      checkedBy: 'A person approves every post in Slack before it goes',
      storesIn: 'Zernio, and Instagram',
      egress: [new URL(this.#base).hostname, ...ZERNIO_UPLOAD_HOSTS],
    }
  }
}
