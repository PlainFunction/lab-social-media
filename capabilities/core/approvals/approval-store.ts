import { Port } from '../kernel/port'
import type { Cipher } from '../security/cipher'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'failed' | 'done'

export interface Approval<P = unknown> {
  id: string
  /** Which ApprovalAction runs it, e.g. 'send-email'. */
  kind: string
  /** What the owner sees in a notification. No contact details: "Reminder for invoice INV-0042". */
  summary: string
  /** What runs if they say yes. Personal, so encrypted at rest. */
  payload: P
  status: ApprovalStatus
  /** Whether AI wrote or shaped the payload. Shown to the owner and kept in the audit log. */
  ai: boolean
  createdAt: string
  expiresAt: string
  decidedBy?: string
  decidedAt?: string
}

export abstract class ApprovalStore extends Port {
  abstract create(a: Approval): Promise<void>
  abstract get<P>(id: string): Promise<Approval<P> | undefined>
  /**
   * Moves an approval from `from` to `to` only if it's still in `from` (and,
   * when deciding, not expired). Returns false if someone else got there first.
   * This is what makes a double-click, or two people approving, send once.
   */
  abstract transition(id: string, from: ApprovalStatus, to: ApprovalStatus, change?: { by?: string; at: string; payload?: unknown; notExpiredAt?: string }): Promise<boolean>
  abstract listPending(): Promise<Approval[]>
  abstract counts(sinceIso: string): Promise<Record<'approved' | 'rejected' | 'expired', number>>
}

export class MemoryApprovalStore extends ApprovalStore {
  readonly #rows = new Map<string, Approval>()
  async create(a: Approval) { this.#rows.set(a.id, structuredClone(a)) }
  async get<P>(id: string) { const a = this.#rows.get(id); return a ? structuredClone(a) as Approval<P> : undefined }
  async transition(id: string, from: ApprovalStatus, to: ApprovalStatus, change?: { by?: string; at: string; payload?: unknown; notExpiredAt?: string }) {
    const a = this.#rows.get(id)
    if (!a || a.status !== from) return false
    if (change?.notExpiredAt && a.expiresAt <= change.notExpiredAt) return false
    a.status = to
    if (change?.by) { a.decidedBy = change.by; a.decidedAt = change.at }
    if (change?.payload !== undefined) a.payload = structuredClone(change.payload)
    return true
  }
  async listPending() { return [...this.#rows.values()].filter(a => a.status === 'pending').map(a => structuredClone(a)) }
  async counts(since: string) {
    const out = { approved: 0, rejected: 0, expired: 0 }
    for (const a of this.#rows.values()) {
      if (a.createdAt < since) continue
      if (a.status === 'approved' || a.status === 'done' || a.status === 'failed') out.approved++
      else if (a.status === 'rejected') out.rejected++
      else if (a.status === 'expired') out.expired++
    }
    return out
  }
  describe() { return { name: 'Memory approvals', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}

/**
 * D1, with payloads sealed by a Cipher. D1 is strongly consistent, so the
 * conditional UPDATE in transition() is a real compare-and-set. (KV isn't, which
 * is why approvals don't live there.)
 */
export class D1ApprovalStore extends ApprovalStore {
  readonly #db: D1Database
  readonly #cipher: Cipher
  constructor(db: D1Database, cipher: Cipher) {
    super()
    this.#db = db
    this.#cipher = cipher
  }

  #seal = (id: string, payload: unknown) => this.#cipher.encryptJson(payload, `approval:${id}`)

  async #row<P>(r: Record<string, unknown>): Promise<Approval<P>> {
    return {
      id: r.id as string, kind: r.kind as string, summary: r.summary as string,
      payload: await this.#cipher.decryptJson<P>(r.payload as string, `approval:${r.id}`),
      status: r.status as ApprovalStatus, ai: r.ai === 1,
      createdAt: r.created_at as string, expiresAt: r.expires_at as string,
      decidedBy: (r.decided_by as string | null) ?? undefined, decidedAt: (r.decided_at as string | null) ?? undefined,
    }
  }

  async create(a: Approval) {
    await this.#db.prepare('INSERT INTO approvals (id, kind, summary, payload, status, ai, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(a.id, a.kind, a.summary, await this.#seal(a.id, a.payload), a.status, a.ai ? 1 : 0, a.createdAt, a.expiresAt).run()
  }

  async get<P>(id: string) {
    const r = await this.#db.prepare('SELECT * FROM approvals WHERE id = ?').bind(id).first()
    return r ? this.#row<P>(r) : undefined
  }

  async transition(id: string, from: ApprovalStatus, to: ApprovalStatus, change?: { by?: string; at: string; payload?: unknown; notExpiredAt?: string }) {
    const sets = ['status = ?']
    const args: unknown[] = [to]
    if (change?.by) { sets.push('decided_by = ?', 'decided_at = ?'); args.push(change.by, change.at) }
    if (change?.payload !== undefined) { sets.push('payload = ?'); args.push(await this.#seal(id, change.payload)) }
    let where = 'id = ? AND status = ?'
    args.push(id, from)
    if (change?.notExpiredAt) { where += ' AND expires_at > ?'; args.push(change.notExpiredAt) }
    const res = await this.#db.prepare(`UPDATE approvals SET ${sets.join(', ')} WHERE ${where}`).bind(...args).run()
    return res.meta.changes === 1
  }

  async listPending() {
    const { results } = await this.#db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all()
    return Promise.all(results.map(r => this.#row(r)))
  }

  async counts(since: string) {
    const { results } = await this.#db.prepare('SELECT status, COUNT(*) AS n FROM approvals WHERE created_at >= ? GROUP BY status').bind(since).all<{ status: ApprovalStatus; n: number }>()
    const n = (s: ApprovalStatus) => results.find(r => r.status === s)?.n ?? 0
    return { approved: n('approved') + n('done') + n('failed'), rejected: n('rejected'), expired: n('expired') }
  }

  describe() { return { name: 'D1 approvals', use: 'Drafts waiting for the owner to say yes', personalInfo: ['name', 'email', 'message'], storesIn: 'Cloudflare D1, Oceania, AES-256-GCM encrypted' } }
}
