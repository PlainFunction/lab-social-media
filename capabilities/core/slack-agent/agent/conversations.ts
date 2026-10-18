import type { ChatMessage } from '../../ai/language-model'
import type { Clock } from '../../kernel/clock'
import { Port, type Manifest } from '../../kernel/port'
import type { Cipher } from '../../security/cipher'
import type { FileRef } from '../tools/contract'

/** One DM or thread: what was said, and the images attached along the way. */
export interface Conversation { messages: ChatMessage[]; files: FileRef[] }
/**
 * The messages in one conversation (a DM or a thread). D1 rather than a
 * Durable Object: one writer at a time is the queue consumer's job
 * (max_concurrency = 1), and D1 is strongly consistent.
 */
export abstract class ConversationStore extends Port {
  abstract get(id: string): Promise<Conversation | undefined>
  abstract has(id: string): Promise<boolean>
  /** Keeps the newest messages and images only, so a long thread can't grow without end. */
  abstract save(id: string, c: Conversation): Promise<void>
  /** Forgets conversations untouched since `beforeIso`. Returns how many. */
  abstract prune(beforeIso: string): Promise<number>
}

export const KEEP_MESSAGES = 40
export const KEEP_FILES = 20

const trim = (c: Conversation): Conversation => ({ messages: c.messages.slice(-KEEP_MESSAGES), files: c.files.slice(-KEEP_FILES) })

export class MemoryConversationStore extends ConversationStore {
  readonly #rows = new Map<string, { c: Conversation; at: string }>()
  readonly #clock?: Clock
  constructor(clock?: Clock) { super(); this.#clock = clock }
  async get(id: string) { const r = this.#rows.get(id); return r ? structuredClone(r.c) : undefined }
  async has(id: string) { return this.#rows.has(id) }
  async save(id: string, c: Conversation) {
    this.#rows.set(id, { c: structuredClone(trim(c)), at: (this.#clock?.now() ?? new Date()).toISOString() })
  }
  async prune(before: string) {
    let n = 0
    for (const [id, r] of this.#rows) if (r.at < before) { this.#rows.delete(id); n++ }
    return n
  }
  describe(): Manifest { return { name: 'Memory conversations', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}

/** `conversations` table. Messages are AES-GCM sealed, bound to the conversation id. */
export class D1ConversationStore extends ConversationStore {
  readonly #db: D1Database
  readonly #cipher: Cipher
  readonly #clock: Clock
  constructor(db: D1Database, cipher: Cipher, clock: Clock) {
    super()
    this.#db = db
    this.#cipher = cipher
    this.#clock = clock
  }

  async get(id: string) {
    const r = await this.#db.prepare('SELECT messages FROM conversations WHERE id = ?').bind(id).first<{ messages: string }>()
    if (!r) return undefined
    const stored = await this.#cipher.decryptJson<Conversation | ChatMessage[]>(r.messages, `conversation:${id}`)
    // Rows from before images were kept are just the messages.
    return Array.isArray(stored) ? { messages: stored, files: [] } : stored
  }

  async has(id: string) {
    return (await this.#db.prepare('SELECT 1 AS x FROM conversations WHERE id = ?').bind(id).first()) !== null
  }

  async save(id: string, c: Conversation) {
    const sealed = await this.#cipher.encryptJson(trim(c), `conversation:${id}`)
    await this.#db.prepare('INSERT INTO conversations (id, messages, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at')
      .bind(id, sealed, this.#clock.now().toISOString()).run()
  }

  async prune(before: string) {
    const r = await this.#db.prepare('DELETE FROM conversations WHERE updated_at < ?').bind(before).run()
    return r.meta.changes
  }

  describe(): Manifest {
    return { name: 'D1 conversations', use: 'What was said in each DM and thread, so it can follow on', personalInfo: ['whatever people write to it', 'names of images they attach'], storesIn: 'Cloudflare D1, Oceania, AES-256-GCM encrypted, kept 30 days. Images stay in Slack' }
  }
}
