import { Port, type Manifest } from '../kernel/port'
import type { Cipher } from '../security/cipher'

// A draft, kept so feedback can change it rather than start again. It holds
// the exact messages the writer saw, so a revision replays them word for word
// and the model's prompt cache serves that prefix, and what each slide was, so
// slides the feedback didn't touch keep the files they already have.

export interface SavedDraft {
  id: string
  /** Sent with every writer call for this draft, so they reach the instance holding its cached prefix. */
  session: string
  theme: string
  /** What they first asked for, word for word. */
  request: string
  /** The writer's system prompt and their message (request, brief, image description, source), exactly as sent. */
  system: string
  material: string
  /** The brief, image description and source together: what counts as fact. */
  known: string
  carousel: boolean
  /** Photo, Screenshot, Illustration or Headline only. */
  picture: string
  /** Their attached image's id, read again to redraw its slide. */
  imageId?: string
  /** An illustration the image model made, base64, so a revision doesn't pay for a new one. */
  art?: { mimetype: 'image/png' | 'image/jpeg'; base64: string }
  /** The writer's last answer, as JSON: what a revision starts from. */
  written: Record<string, unknown>
  /** One key per slide, as drawn (words, layout, page, colours), to tell which a revision changed. */
  slideKeys: string[]
  link: string
  version: number
}

export abstract class DraftStore extends Port {
  abstract get(id: string): Promise<SavedDraft | undefined>
  abstract save(draft: SavedDraft): Promise<void>
}

/** Drafts sealed in KV, bound to their id, gone after two weeks. */
export class KvDraftStore extends DraftStore {
  static readonly TTL_SECONDS = 14 * 24 * 60 * 60
  readonly #kv: KVNamespace
  readonly #cipher: Cipher
  constructor(kv: KVNamespace, cipher: Cipher) { super(); this.#kv = kv; this.#cipher = cipher }

  async get(id: string) {
    const sealed = await this.#kv.get(`draft:${id}`)
    return sealed ? this.#cipher.decryptJson<SavedDraft>(sealed, `draft:${id}`) : undefined
  }

  async save(draft: SavedDraft) {
    await this.#kv.put(`draft:${draft.id}`, await this.#cipher.encryptJson(draft, `draft:${draft.id}`), { expirationTtl: KvDraftStore.TTL_SECONDS })
  }

  describe(): Manifest {
    return { name: 'Social drafts (KV, sealed)', use: 'Keeping drafts so feedback can change them', personalInfo: ['whatever the draft and its source say'], storesIn: 'Workers KV, encrypted, for two weeks' }
  }
}

/** Keeps drafts in memory. Tests, and a fallback when no store is given. */
export class MemoryDraftStore extends DraftStore {
  readonly drafts = new Map<string, SavedDraft>()
  async get(id: string) { const d = this.drafts.get(id); return d ? structuredClone(d) : undefined }
  async save(draft: SavedDraft) { this.drafts.set(draft.id, structuredClone(draft)) }
  describe(): Manifest { return { name: 'Memory drafts', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}
