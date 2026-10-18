import type { Clock } from '../../kernel/clock'
import type { Manifest } from '../../kernel/port'
import { UsageMeter, type UsageEvent } from '../../looked-after/usage'
// A UsageMeter that can be read back. Core's MeteredLanguageModel writes to it
// after every model call; the agent checks it before every model call.

/** USD per million tokens. Check against Workers AI pricing before relying on it. */
/** US dollars per million tokens. `cached` is the price of input tokens served from the prompt cache, where the model has one. */
export const PRICES: Record<string, { input: number; output: number; cached?: number }> = {
  // From its Workers AI model page, October 2026.
  '@cf/zai-org/glm-4.7-flash': { input: 0.0605, output: 0.4 },
  // The vision model images__describe uses. About $0.0004 for one image.
  '@cf/mistralai/mistral-small-3.1-24b-instruct': { input: 0.351, output: 0.555 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.293, output: 2.253 },
  // The writer: what drafts posts people will read. About 1c a draft (two calls, a long document as the source).
  '@cf/deepseek-ai/deepseek-v4-pro-0813': { input: 1.32, output: 3.96, cached: 0.044 },
  '@cf/deepseek-ai/deepseek-v4-flash-0731': { input: 0.44, output: 1.32, cached: 0.014 },
  // Image models count one output token per image (core's IMAGE_USAGE), so this is $ per million images.
  // Lucid Origin at 1024x768: three tiles x $0.006996 plus its steps at $0.000132 each, about $0.025.
  '@cf/leonardo/lucid-origin': { input: 0, output: 25_000 },
  // FLUX.2 [klein] 9B: $0.015 for the first megapixel, which covers a 1024x768 picture.
  '@cf/black-forest-labs/flux-2-klein-9b': { input: 0, output: 15_000 },
  // FLUX.1 schnell at 1024x1024 and 4 steps: 4 tiles x $0.0000528 + 4 steps x $0.0001056, about $0.00065.
  '@cf/black-forest-labs/flux-1-schnell': { input: 0, output: 650 },
  offline: { input: 0, output: 0 },
}

/** A model with no price is charged as if it were expensive, so it can't slip past the cap. */
export const UNKNOWN_PRICE = { input: 5, output: 25 }

export const costOf = (model: string, inputTokens: number, outputTokens: number, cachedInputTokens = 0) => {
  const p: { input: number; output: number; cached?: number } = PRICES[model] ?? UNKNOWN_PRICE
  const cached = Math.min(cachedInputTokens, inputTokens)
  return ((inputTokens - cached) * p.input + cached * (p.cached ?? p.input) + outputTokens * p.output) / 1_000_000
}

/** YYYY-MM in the owner's time zone, so the month resets when theirs does. */
export const monthOf = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(at).slice(0, 7)

/** A fixed zone, or one read when needed (it can change in Slack settings). */
export type Zone = string | (() => Promise<string>)
const zoneOf = (z: Zone) => (typeof z === 'string' ? Promise.resolve(z) : z())

export abstract class SpendLedger extends UsageMeter {
  abstract spentThisMonth(): Promise<number>

  /** New work stops at 90% of the cap, so a request already running has room to finish. */
  async canSpend(capUsd: number): Promise<boolean> {
    return (await this.spentThisMonth()) < capUsd * 0.9
  }
}

export class MemorySpendLedger extends SpendLedger {
  readonly events: (UsageEvent & { month: string; usd: number })[] = []
  readonly #clock: Clock
  readonly #tz: Zone
  constructor(clock: Clock, timeZone: Zone = 'Australia/Sydney') { super(); this.#clock = clock; this.#tz = timeZone }
  async record(e: UsageEvent) {
    this.events.push({ ...e, month: monthOf(this.#clock.now(), await zoneOf(this.#tz)), usd: costOf(e.model, e.inputTokens, e.outputTokens, e.cachedInputTokens) })
  }
  async spentThisMonth() {
    const m = monthOf(this.#clock.now(), await zoneOf(this.#tz))
    return this.events.filter(e => e.month === m).reduce((n, e) => n + e.usd, 0)
  }
  describe(): Manifest { return { name: 'Memory spend', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}

/** `spend` table: one row per model call, counts and cost only, never content. */
export class D1SpendLedger extends SpendLedger {
  readonly #db: D1Database
  readonly #clock: Clock
  readonly #tz: Zone
  constructor(db: D1Database, clock: Clock, timeZone: Zone) {
    super()
    this.#db = db
    this.#clock = clock
    this.#tz = timeZone
  }

  async record(e: UsageEvent) {
    const now = this.#clock.now()
    await this.#db.prepare('INSERT INTO spend (at, month, feature, model, input_tokens, output_tokens, usd) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(now.toISOString(), monthOf(now, await zoneOf(this.#tz)), e.feature, e.model, e.inputTokens, e.outputTokens, costOf(e.model, e.inputTokens, e.outputTokens, e.cachedInputTokens)).run()
  }

  async spentThisMonth() {
    const r = await this.#db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM spend WHERE month = ?').bind(monthOf(this.#clock.now(), await zoneOf(this.#tz))).first<{ usd: number }>()
    return r?.usd ?? 0
  }

  describe(): Manifest {
    return { name: 'D1 spend ledger', use: 'Counting what each model call cost, to stop at the monthly cap', personalInfo: [], storesIn: 'Cloudflare D1 (counts only)' }
  }
}
