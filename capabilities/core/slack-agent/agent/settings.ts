import type { AuditLog } from '../../audit/audit-log'
import type { Clock } from '../../kernel/clock'
import { ConfigError, ValidationError } from '../../kernel/errors'
import { Port, type Manifest } from '../../kernel/port'
import type { ToolAnnotations } from '../tools/contract'

export type Policy = 'allow' | 'ask' | 'never'
export const POLICIES: Policy[] = ['allow', 'ask', 'never']

export interface AgentSettings {
  name: string
  timeZone: string
  /** Slack member ids. Nobody else gets an answer. */
  allowedUsers: string[]
  /** Who can change settings and connect accounts. A subset of allowedUsers. */
  adminUsers: string[]
  capUsd: number
  /** The most an admin can set the cap to from Slack. */
  maxCapUsd: number
  /** Per tool (`server__tool`), the owner's choice. Overrides the tool's own hints. */
  tools: Record<string, Policy>
  askForReadOnly: boolean
  /** Tool servers turned off. Their tools aren't offered to the model. */
  disabledServers: string[]
  /** Answers nothing but settings while paused. */
  paused: boolean
  /** Model calls per request. */
  maxSteps: number
  instructions?: string
  /** The workspace this Worker serves. Events from any other team are ignored. */
  teamId?: string
}

export interface SettingsEnv {
  ASSISTANT_NAME?: string
  TIME_ZONE?: string
  ALLOWED_USERS?: string
  ADMIN_USERS?: string
  MONTHLY_CAP_USD?: string
  MAX_CAP_USD?: string
  TOOL_POLICY?: string
  ASK_FOR_READ_ONLY?: string
  INSTRUCTIONS?: string
  SLACK_TEAM_ID?: string
}

const json = <T>(name: string, raw: string | undefined, fallback: T): T => {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { throw new ConfigError(`${name} is not valid JSON`) }
}
const ids = (raw?: string) => (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)

export const validTimeZone = (tz: string) => {
  try { new Intl.DateTimeFormat('en-AU', { timeZone: tz }); return true } catch { return false }
}

/** The defaults, from config. Slack ids and limits only ever come from here. */
export function parseSettings(env: SettingsEnv): AgentSettings {
  const allowedUsers = ids(env.ALLOWED_USERS)
  // Fails closed: with nobody allowed, it answers nobody.
  if (allowedUsers.length === 0) throw new ConfigError('ALLOWED_USERS is not set')
  const adminUsers = ids(env.ADMIN_USERS)
  for (const a of adminUsers) if (!allowedUsers.includes(a)) throw new ConfigError(`ADMIN_USERS: ${a} isn't in ALLOWED_USERS`)
  const capUsd = Number(env.MONTHLY_CAP_USD ?? '5')
  const maxCapUsd = Number(env.MAX_CAP_USD ?? '50')
  if (!Number.isFinite(capUsd) || capUsd < 0) throw new ConfigError('MONTHLY_CAP_USD must be a number')
  if (!Number.isFinite(maxCapUsd) || maxCapUsd < capUsd) throw new ConfigError('MAX_CAP_USD must be a number, at least MONTHLY_CAP_USD')
  const tools = json<Record<string, Policy>>('TOOL_POLICY', env.TOOL_POLICY, {})
  for (const [k, v] of Object.entries(tools)) if (!POLICIES.includes(v)) throw new ConfigError(`TOOL_POLICY.${k} must be allow, ask or never`)
  const timeZone = env.TIME_ZONE || 'Australia/Sydney'
  if (!validTimeZone(timeZone)) throw new ConfigError(`TIME_ZONE ${timeZone} isn't a time zone`)
  // The workspace's id, not its address. Anything else would quietly drop every event.
  if (env.SLACK_TEAM_ID && !/^[TE][A-Z0-9]{6,}$/.test(env.SLACK_TEAM_ID)) throw new ConfigError(`SLACK_TEAM_ID should look like T0123ABCD (the workspace id), not ${env.SLACK_TEAM_ID}`)
  return {
    name: env.ASSISTANT_NAME || 'Assistant',
    timeZone,
    allowedUsers,
    adminUsers,
    capUsd,
    maxCapUsd,
    tools,
    askForReadOnly: env.ASK_FOR_READ_ONLY === 'true',
    disabledServers: [],
    paused: false,
    maxSteps: 20,
    instructions: env.INSTRUCTIONS,
    teamId: env.SLACK_TEAM_ID || undefined,
  }
}

/** What the tool's own hints say, before the owner has a say. */
export function defaultPolicy(annotations: ToolAnnotations | undefined, settings: Pick<AgentSettings, 'askForReadOnly'>): Policy {
  if (annotations?.destructiveHint) return 'ask'
  if (annotations?.readOnlyHint) return settings.askForReadOnly ? 'ask' : 'allow'
  return 'ask'
}

/** Decided outside the model. Tools that don't say what they do ask. */
export function policyFor(name: string, annotations: ToolAnnotations | undefined, settings: AgentSettings): Policy {
  const mine = Object.hasOwn(settings.tools, name) ? settings.tools[name] : undefined
  return mine ?? defaultPolicy(annotations, settings)
}

// ── Settings changed in Slack ────────────────────────────────────────────────

/** What can be changed in Slack. Slack ids, secrets and the cap's ceiling stay in config. */
export interface SettingsChanges {
  paused?: boolean
  timeZone?: string
  instructions?: string
  capUsd?: number
  askForReadOnly?: boolean
  tools?: Record<string, Policy>
  disabledServers?: string[]
}

/** Only what differs from config is stored, so a config change still reaches anything nobody touched. */
export abstract class SettingsStore extends Port {
  abstract get(): Promise<SettingsChanges>
  abstract put(overrides: SettingsChanges, by: string): Promise<void>
}

export class MemorySettingsStore extends SettingsStore {
  overrides: SettingsChanges = {}
  async get() { return structuredClone(this.overrides) }
  async put(o: SettingsChanges) { this.overrides = structuredClone(o) }
  describe(): Manifest { return { name: 'Memory settings', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}

/** One row. Settings hold no secrets and no Slack ids, so they aren't sealed. */
export class D1SettingsStore extends SettingsStore {
  readonly #db: D1Database
  readonly #clock: Clock
  constructor(db: D1Database, clock: Clock) { super(); this.#db = db; this.#clock = clock }
  async get(): Promise<SettingsChanges> {
    const r = await this.#db.prepare("SELECT overrides FROM settings WHERE id = 'current'").first<{ overrides: string }>()
    return r ? JSON.parse(r.overrides) as SettingsChanges : {}
  }
  async put(o: SettingsChanges, by: string) {
    await this.#db.prepare("INSERT INTO settings (id, overrides, updated_at, updated_by) VALUES ('current', ?, ?, ?) ON CONFLICT (id) DO UPDATE SET overrides = excluded.overrides, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
      .bind(JSON.stringify(o), this.#clock.now().toISOString(), by).run()
  }
  describe(): Manifest {
    return { name: 'D1 settings', use: 'Settings an admin changed in Slack', personalInfo: ['custom instructions, if they name anyone'], storesIn: 'Cloudflare D1, Oceania' }
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Config, with what admins changed in Slack on top. Read fresh for every job. */
export class Settings {
  readonly base: AgentSettings
  readonly #store: SettingsStore
  readonly #audit: AuditLog

  constructor(base: AgentSettings, store: SettingsStore, audit: AuditLog) {
    this.base = base
    this.#store = store
    this.#audit = audit
  }

  isAdmin(user: string) { return this.base.adminUsers.includes(user) }

  async current(): Promise<AgentSettings> {
    const o = await this.#store.get()
    const s: AgentSettings = { ...this.base, ...o, tools: { ...this.base.tools, ...o.tools } }
    // Config may have changed since: a stored value can't break it or go past its limit.
    if (!validTimeZone(s.timeZone)) s.timeZone = this.base.timeZone
    s.capUsd = Math.min(Math.max(0, Number(s.capUsd) || 0), this.base.maxCapUsd)
    return s
  }

  /**
   * Checks and stores a change. `toolDefaults` is what each tool would be
   * without an override, so choosing the default clears it. Returns what changed.
   */
  async change(changes: SettingsChanges, by: string, toolDefaults: Record<string, Policy> = {}): Promise<string[]> {
    const c = changes
    if (c.timeZone !== undefined && !validTimeZone(c.timeZone.trim())) throw new ValidationError(`${c.timeZone} isn't a time zone. Try one like Australia/Sydney.`)
    if (c.capUsd !== undefined && (!Number.isFinite(c.capUsd) || c.capUsd < 0 || c.capUsd > this.base.maxCapUsd)) {
      throw new ValidationError(`The monthly limit has to be between $0 and $${this.base.maxCapUsd}.`)
    }
    if (c.instructions !== undefined && c.instructions.length > 2000) throw new ValidationError('Instructions can be up to 2,000 characters.')
    for (const [k, v] of Object.entries(c.tools ?? {})) if (!POLICIES.includes(v)) throw new ValidationError(`${k} must be allow, ask or never`)

    const before = await this.current()
    const old = await this.#store.get()
    const next: SettingsChanges = { ...old }
    const changed: string[] = []
    const set = <K extends Exclude<keyof SettingsChanges, 'tools'>>(key: K, value: SettingsChanges[K] | undefined, base: unknown) => {
      if (value === undefined) return
      if (!same(value, before[key] ?? (key === 'instructions' ? '' : undefined))) changed.push(key)
      if (same(value, base)) delete next[key]
      else next[key] = value
    }
    set('paused', c.paused, this.base.paused)
    set('timeZone', c.timeZone?.trim(), this.base.timeZone)
    set('instructions', c.instructions?.trim(), this.base.instructions ?? '')
    set('capUsd', c.capUsd, this.base.capUsd)
    set('askForReadOnly', c.askForReadOnly, this.base.askForReadOnly)
    set('disabledServers', c.disabledServers ? [...c.disabledServers].sort() : undefined, [])

    if (c.tools) {
      const tools = { ...old.tools }
      for (const [k, v] of Object.entries(c.tools)) {
        const was = before.tools[k] ?? toolDefaults[k]
        if (was !== v) changed.push(`tools.${k}`)
        // Back to what config or the tool itself says: nothing to store.
        if (v === (this.base.tools[k] ?? toolDefaults[k])) delete tools[k]
        else tools[k] = v
      }
      if (Object.keys(tools).length) next.tools = tools
      else delete next.tools
    }

    if (changed.length === 0) return []
    await this.#store.put(next, `slack:${by}`)
    await this.#audit.record({ actor: `slack:${by}`, action: 'settings.changed', subject: 'settings', detail: { changed: changed.join(',') } })
    return changed
  }
}
