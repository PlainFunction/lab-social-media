import { Port } from '../kernel/port'

/** `cachedInputTokens`, when given, is the part of `inputTokens` the model served from its prompt cache (cheaper). */
export interface UsageEvent { feature: string; model: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number }

/** Counts what each client's automations cost to run. Never sees content. */
export abstract class UsageMeter extends Port {
  abstract record(e: UsageEvent): Promise<void>
}

/**
 * Workers Analytics Engine: writes are free-ish, non-blocking and never fail
 * the request. Query monthly totals with the SQL API, grouped by index1 (client).
 */
export class AnalyticsEngineUsageMeter extends UsageMeter {
  readonly #dataset: AnalyticsEngineDataset
  readonly #client: string
  constructor(dataset: AnalyticsEngineDataset, client: string) {
    super()
    this.#dataset = dataset
    this.#client = client
  }
  async record(e: UsageEvent) {
    this.#dataset.writeDataPoint({ indexes: [this.#client], blobs: [e.feature, e.model], doubles: [e.inputTokens, e.outputTokens] })
  }
  describe() { return { name: 'Analytics Engine', use: 'Counting AI tokens used per automation', personalInfo: [], storesIn: 'Cloudflare Analytics Engine (counts only)' } }
}

export class MemoryUsageMeter extends UsageMeter {
  readonly events: UsageEvent[] = []
  async record(e: UsageEvent) { this.events.push(e) }
  describe() { return { name: 'Memory usage meter', use: 'Tests', personalInfo: [], storesIn: 'Memory' } }
}
