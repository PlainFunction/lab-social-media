import { Port } from '../kernel/port'
import { ConflictError } from '../kernel/errors'
import { sha256Hex, stableJson } from '../kernel/encoding'
import type { Clock } from '../kernel/clock'

/**
 * What happened, who did it, and whether AI was involved. This is the record
 * behind "nothing goes out without you saying yes", and what we'd show a client
 * (or the OAIC) asking how a decision was made.
 *
 * Keep `detail` to ids, counts and outcomes. No message bodies, no contact
 * details: the log is kept for years and isn't encrypted.
 */
export interface AuditEvent {
  /** `owner:dan@example.com`, `system:invoice-chaser`, `ai:workers-ai` */
  actor: string
  /** `approval.requested`, `approval.approved`, `email.sent`, `job.created` */
  action: string
  /** What it was done to: `approval:abc`, `invoice:INV-0042` */
  subject: string
  detail?: Record<string, string | number | boolean | null>
  /** True when an AI model produced or shaped the thing being acted on. */
  ai?: boolean
}

export interface AuditRecord extends AuditEvent {
  seq: number
  at: string
  /** Hash of the previous record, so removing or editing one breaks the chain. */
  prev: string
  hash: string
}

const GENESIS = '0'.repeat(64)

export abstract class AuditLog extends Port {
  protected readonly clock: Clock
  constructor(clock: Clock) {
    super()
    this.clock = clock
  }

  protected abstract tail(): Promise<AuditRecord | undefined>
  /** Must fail with ConflictError if `seq` is taken, so two writers can't both extend the chain. */
  protected abstract append(record: AuditRecord): Promise<void>
  abstract list(opts?: { afterSeq?: number; limit?: number }): Promise<AuditRecord[]>

  async record(event: AuditEvent): Promise<AuditRecord> {
    for (let attempt = 0; ; attempt++) {
      const last = await this.tail()
      const base = {
        ...event,
        ai: event.ai ?? false,
        detail: event.detail ?? {},
        seq: (last?.seq ?? 0) + 1,
        at: this.clock.now().toISOString(),
        prev: last?.hash ?? GENESIS,
      }
      const record: AuditRecord = { ...base, hash: await AuditLog.hash(base) }
      try {
        await this.append(record)
        return record
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt >= 4) throw err
      }
    }
  }

  static hash(r: Omit<AuditRecord, 'hash'>) {
    return sha256Hex(stableJson({ seq: r.seq, at: r.at, actor: r.actor, action: r.action, subject: r.subject, detail: r.detail ?? {}, ai: r.ai ?? false, prev: r.prev }))
  }

  /** Walks the whole chain. Returns the first seq that doesn't check out. */
  async verify(): Promise<{ ok: true; count: number } | { ok: false; brokenAt: number }> {
    let prev = GENESIS
    let after = 0
    let count = 0
    for (;;) {
      const page = await this.list({ afterSeq: after, limit: 500 })
      if (page.length === 0) return { ok: true, count }
      for (const r of page) {
        const { hash, ...rest } = r
        if (r.prev !== prev || r.seq !== after + 1 || hash !== await AuditLog.hash(rest)) return { ok: false, brokenAt: r.seq }
        prev = hash
        after = r.seq
        count++
      }
    }
  }
}

export class MemoryAuditLog extends AuditLog {
  readonly records: AuditRecord[] = []
  protected async tail() { return this.records.at(-1) }
  protected async append(r: AuditRecord) {
    if (this.records.some(x => x.seq === r.seq)) throw new ConflictError('seq taken')
    this.records.push(structuredClone(r))
  }
  async list({ afterSeq = 0, limit = 100 } = {}) {
    return this.records.filter(r => r.seq > afterSeq).slice(0, limit).map(r => structuredClone(r))
  }
  describe() {
    return { name: 'Memory audit log', use: 'Tests', personalInfo: [], storesIn: 'Memory' }
  }
}

/**
 * D1. Create the database with location hint `oc` (Oceania) so it lives
 * close to the client. Schema in core/schema.sql.
 */
export class D1AuditLog extends AuditLog {
  readonly #db: D1Database
  constructor(db: D1Database, clock: Clock) {
    super(clock)
    this.#db = db
  }

  static #row(r: Record<string, unknown>): AuditRecord {
    return {
      seq: r.seq as number, at: r.at as string, actor: r.actor as string, action: r.action as string,
      subject: r.subject as string, detail: JSON.parse(r.detail as string), ai: r.ai === 1,
      prev: r.prev as string, hash: r.hash as string,
    }
  }

  protected async tail() {
    const r = await this.#db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1').first()
    return r ? D1AuditLog.#row(r) : undefined
  }

  protected async append(r: AuditRecord) {
    try {
      await this.#db.prepare('INSERT INTO audit_log (seq, at, actor, action, subject, detail, ai, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(r.seq, r.at, r.actor, r.action, r.subject, JSON.stringify(r.detail ?? {}), r.ai ? 1 : 0, r.prev, r.hash).run()
    } catch (err) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(err))) throw new ConflictError('seq taken')
      throw err
    }
  }

  async list({ afterSeq = 0, limit = 100 } = {}) {
    const { results } = await this.#db.prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?').bind(afterSeq, limit).all()
    return results.map(D1AuditLog.#row)
  }

  describe() {
    return { name: 'D1 audit log', use: 'Record of every approval, send and automated decision', personalInfo: ['approver email'], storesIn: 'Cloudflare D1, Oceania' }
  }
}
