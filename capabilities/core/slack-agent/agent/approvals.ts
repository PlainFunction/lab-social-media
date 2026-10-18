import type { Approval, ApprovalStore } from '../../approvals/approval-store'
import type { AuditLog } from '../../audit/audit-log'
import type { Clock } from '../../kernel/clock'
import { randomId } from '../../kernel/encoding'
import { ConflictError, NotAllowedError } from '../../kernel/errors'
import type { TokenIssuer } from '../../security/signer'
import type { ElicitAnswer, Elicitation } from '../tools/contract'

// Core's ApprovalGate is built for email links behind Cloudflare Access. In
// Slack the form is the approval and Slack's signature says who clicked, so
// this uses the same pieces underneath: the encrypted D1 ApprovalStore (its
// compare-and-set is what makes a double click run once), purpose-bound
// tokens and the hash-chained audit log.

/** A tool call waiting for a yes, or for inputs the model left out. */
export interface PendingCall {
  conversation: string
  channel: string
  thread?: string
  /** Who asked. */
  user: string
  /** `server__tool` */
  tool: string
  title: string
  args: Record<string, unknown>
  /** approve: a yes before it runs. missing: inputs the model left out. elicit: a question from the tool. */
  mode: 'approve' | 'missing' | 'elicit'
  /** For elicit: the answers before this question, and the question. */
  answers?: ElicitAnswer[]
  question?: Elicitation
}

const PURPOSE = 'tool-call'

export class ToolApprovals {
  readonly #store: ApprovalStore
  readonly #tokens: TokenIssuer
  readonly #audit: AuditLog
  readonly #clock: Clock
  readonly #ttlSeconds: number

  constructor(o: { store: ApprovalStore; tokens: TokenIssuer; audit: AuditLog; clock: Clock; ttlHours?: number }) {
    this.#store = o.store
    this.#tokens = o.tokens
    this.#audit = o.audit
    this.#clock = o.clock
    this.#ttlSeconds = (o.ttlHours ?? 24) * 3600
  }

  /** Stores the call and returns the ref to put in the form's buttons. */
  async request(call: PendingCall): Promise<{ id: string; ref: string }> {
    const now = this.#clock.now()
    const approval: Approval<PendingCall> = {
      id: randomId(), kind: PURPOSE, summary: `${call.tool} (${call.mode})`, payload: call, status: 'pending', ai: true,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.#ttlSeconds * 1000).toISOString(),
    }
    await this.#store.create(approval)
    await this.#audit.record({ actor: 'ai:slack-agent', action: 'approval.requested', subject: `approval:${approval.id}`, detail: { tool: call.tool, mode: call.mode }, ai: true })
    const token = await this.#tokens.issue(PURPOSE, approval.id, this.#ttlSeconds)
    return { id: approval.id, ref: `${approval.id}.${token}` }
  }

  async #open(ref: string): Promise<Approval<PendingCall>> {
    const dot = ref.indexOf('.')
    const id = dot > 0 ? ref.slice(0, dot) : ''
    await this.#tokens.verify(ref.slice(dot + 1), PURPOSE, id)
    const approval = await this.#store.get<PendingCall>(id)
    if (!approval || approval.kind !== PURPOSE) throw new NotAllowedError('No such approval')
    return approval
  }

  /** The call behind a ref, while it's still waiting. Decides nothing. */
  async peek(ref: string): Promise<PendingCall | undefined> {
    const a = await this.#open(ref)
    return a.status === 'pending' ? a.payload : undefined
  }

  /**
   * Records a yes or no from `user`, once. Throws NotAllowedError for a ref
   * that isn't ours or has expired, ConflictError if it was already decided.
   */
  async decide(ref: string, user: string, yes: boolean): Promise<Approval<PendingCall>> {
    const approval = await this.#open(ref)
    const id = approval.id
    const at = this.#clock.now().toISOString()
    if (!(await this.#store.transition(id, 'pending', yes ? 'approved' : 'rejected', { by: `slack:${user}`, at, notExpiredAt: at }))) {
      throw new ConflictError('Already decided or expired')
    }
    await this.#audit.record({ actor: `slack:${user}`, action: yes ? 'approval.approved' : 'approval.rejected', subject: `approval:${id}`, detail: { tool: approval.payload.tool }, ai: true })
    return { ...approval, status: yes ? 'approved' : 'rejected', decidedBy: `slack:${user}`, decidedAt: at }
  }

  /** After an approved call has run. */
  async finish(id: string, ok: boolean, tool: string) {
    await this.#store.transition(id, 'approved', ok ? 'done' : 'failed', { at: this.#clock.now().toISOString() })
    await this.#audit.record({ actor: `system:${tool}`, action: ok ? 'action.done' : 'action.failed', subject: `approval:${id}`, detail: { tool }, ai: true })
  }

  /** Run hourly. A form left alone stops working after the TTL. */
  async expireStale(): Promise<number> {
    const now = this.#clock.now().toISOString()
    let n = 0
    for (const a of await this.#store.listPending()) {
      if (a.kind === PURPOSE && a.expiresAt <= now && (await this.#store.transition(a.id, 'pending', 'expired', { at: now }))) {
        await this.#audit.record({ actor: 'system:approvals', action: 'approval.expired', subject: `approval:${a.id}`, detail: { kind: a.kind } })
        n++
      }
    }
    return n
  }
}
