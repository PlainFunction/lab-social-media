import { ValidationError } from '../kernel/errors'
import { Port, type Manifest } from '../kernel/port'

// Posting to a business's Instagram. One port, so the tools don't care which
// scheduling service sits behind it. Zernio today.

/** Instagram's longest caption, in characters. */
export const CAPTION_LIMIT = 2200
/** Instagram refuses a post with more hashtags than this. */
export const HASHTAG_LIMIT = 30
/** Image types Instagram takes. */
export const POST_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const

/** A connected Instagram account, as the service names it. */
export interface SocialAccount { id: string; name: string }

export interface MediaFile { name: string; mimetype: string; bytes: Uint8Array }

export type PostTiming =
  | { kind: 'now' }
  /** Saved in the service, not posted. */
  | { kind: 'draft' }
  /** `at` is local time, YYYY-MM-DDTHH:mm, in `timeZone`. */
  | { kind: 'scheduled'; at: string; timeZone: string }

export interface NewPost {
  caption: string
  accountId: string
  /** Public https URLs, from `upload` or anywhere Instagram can fetch. One, or up to ten for a carousel. */
  images: string[]
  when: PostTiming
  /** Posted as the first comment. Where a link goes, since captions can't have one. */
  firstComment?: string
  /** Instagram's "AI info" label, for a picture an AI model made. */
  aiLabel?: boolean
}

export interface PostResult {
  id: string
  /** draft, scheduled, publishing, published or failed */
  status: string
  url?: string
  error?: string
}

export abstract class SocialPublisher extends Port {
  /** Instagram accounts that are connected and active. */
  abstract accounts(): Promise<SocialAccount[]>
  /** Puts an image where Instagram can fetch it, and returns its public URL. */
  abstract upload(file: MediaFile): Promise<string>
  abstract publish(post: NewPost): Promise<PostResult>
}

/** Instagram's own rules, checked before anything is uploaded or posted. */
export function checkPost(post: { caption: string; hasImage: boolean; imageType?: string }) {
  if (post.caption.length > CAPTION_LIMIT) throw new ValidationError(`Instagram takes up to ${CAPTION_LIMIT.toLocaleString('en-AU')} characters, and this is ${post.caption.length.toLocaleString('en-AU')}`)
  const tags = post.caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0
  if (tags > HASHTAG_LIMIT) throw new ValidationError(`Instagram takes up to ${HASHTAG_LIMIT} hashtags, and this has ${tags}`)
  if (!post.hasImage) throw new ValidationError('Instagram posts need a picture. Attach one, give a link to one, or draft one first')
  if (post.imageType && !(POST_IMAGE_TYPES as readonly string[]).includes(post.imageType)) throw new ValidationError(`Instagram doesn't take ${post.imageType} images. Use a JPEG or PNG`)
}

/** Records every upload and post. The fake service for tests. */
export class MemorySocialPublisher extends SocialPublisher {
  readonly connected: SocialAccount[]
  readonly uploads: MediaFile[] = []
  readonly posts: NewPost[] = []
  constructor(connected: SocialAccount[]) { super(); this.connected = connected }

  async accounts() { return this.connected }

  async upload(file: MediaFile) {
    this.uploads.push(file)
    return `https://media.example/${this.uploads.length}/${encodeURIComponent(file.name)}`
  }

  async publish(post: NewPost): Promise<PostResult> {
    this.posts.push(post)
    const status = post.when.kind === 'now' ? 'published' : post.when.kind
    return { id: `post-${this.posts.length}`, status, url: status === 'published' ? `https://instagram.example/p/${this.posts.length}` : undefined }
  }

  describe(): Manifest {
    return { name: 'Memory social publisher', use: 'Tests', personalInfo: [], storesIn: 'Memory' }
  }
}
