import { randomId } from '../../kernel/encoding'
import { Port, type Manifest } from '../../kernel/port'
import type { Cipher } from '../../security/cipher'
import type { FileRef } from '../tools/contract'
// Slack wants an answer within three seconds and model calls take longer, so
// the Worker only checks, routes and queues. The queue consumer does the work,
// with minutes to spare instead of seconds.

export type Job =
  | { type: 'message'; conversation: string; channel: string; thread?: string; ts: string; user: string; text: string; files?: FileRef[]; texts?: FileRef[]; skipped?: string[] }
  | {
    type: 'decision'
    /** From the button: approval id and its signed token. */
    ref: string
    yes: boolean
    /** The form as the person left it. */
    values: Record<string, unknown>
    user: string
    channel: string
    /** The message holding the form, so it can be replaced with the outcome. */
    messageTs: string
  }
  | {
    type: 'settings'
    action: 'save' | 'page'
    page: number
    /** Slack's raw form state; settings read checkbox groups that readForm flattens. */
    state: Record<string, Record<string, Record<string, unknown>>>
    user: string
    channel: string
    messageTs: string
  }

/** What goes on the queue: the job sealed, so message text isn't sitting there readable. */
export interface SealedJob { id: string; sealed: string }

export abstract class JobQueue extends Port {
  abstract send(job: Job): Promise<void>
}

export const sealJob = async (job: Job, cipher: Cipher): Promise<SealedJob> => {
  const id = randomId()
  return { id, sealed: await cipher.encryptJson(job, `job:${id}`) }
}

export const openJob = (m: SealedJob, cipher: Cipher) => cipher.decryptJson<Job>(m.sealed, `job:${m.id}`)

export class CloudflareJobQueue extends JobQueue {
  readonly #queue: Queue<SealedJob>
  readonly #cipher: Cipher
  constructor(queue: Queue<SealedJob>, cipher: Cipher) {
    super()
    this.#queue = queue
    this.#cipher = cipher
  }
  async send(job: Job) { await this.#queue.send(await sealJob(job, this.#cipher)) }
  describe(): Manifest {
    return { name: 'Cloudflare Queues', use: 'Holding a message until the agent picks it up, seconds later', personalInfo: ['whatever people write to it'], storesIn: 'Cloudflare Queues, AES-256-GCM encrypted, until delivered' }
  }
}

export class MemoryJobQueue extends JobQueue {
  readonly jobs: Job[] = []
  async send(job: Job) { this.jobs.push(structuredClone(job)) }
  describe(): Manifest { return { name: 'Memory queue', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}
