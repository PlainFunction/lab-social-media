import { z } from 'zod'
import { Port, mergeManifest, type Manifest } from '../kernel/port'
import { UpstreamError, ValidationError } from '../kernel/errors'
import { sha256Hex, stableJson } from '../kernel/encoding'
import type { Cache } from '../cache/cache'
import type { Redactor } from '../security/redactor'
import type { UsageMeter } from '../looked-after/usage'

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface CompletionRequest {
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  /** JSON Schema the reply must match. Use completeJson() rather than setting this by hand. */
  jsonSchema?: Record<string, unknown>
  /**
   * Personal details known to be in the messages (customer name, business name).
   * A RedactingLanguageModel swaps these out before the model sees them.
   */
  sensitive?: { label: string; value: string }[]
  /** Which automation is asking, for usage metering and AI Gateway logs. */
  feature?: string
  /**
   * Requests that share a session go to the same model instance, so a prompt
   * that starts the same way as an earlier one reuses its cached prefix, at a
   * fraction of the input price. Sent to Workers AI as `x-session-affinity`.
   */
  session?: string
}

export interface Completion {
  text: string
  model: string
  /** `cachedInputTokens` is the part of `inputTokens` served from the model's prompt cache. */
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  cached?: boolean
}

/**
 * The AI Gateway model calls go through unless a module names another. Cloudflare
 * creates a gateway called "default" on the first request, so there's nothing to
 * set up. Prompts and answers aren't logged (collectLog false); the gateway still
 * counts requests, tokens and cost.
 */
export const DEFAULT_GATEWAY = 'default'

export abstract class LanguageModel extends Port {
  abstract complete(req: CompletionRequest): Promise<Completion>

  /** Ask for JSON matching `schema`, and check the reply really does. */
  async completeJson<T>(req: Omit<CompletionRequest, 'jsonSchema'>, schema: z.ZodType<T>): Promise<{ value: T; completion: Completion }> {
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
    const completion = await this.complete({ ...req, jsonSchema })
    const raw = completion.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch (err) { throw new ValidationError('Model reply was not JSON', { cause: err }) }
    const result = schema.safeParse(parsed)
    if (!result.success) throw new ValidationError(`Model reply did not match the schema: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`)
    return { value: result.data, completion }
  }
}

/**
 * Keys Workers AI's JSON mode refuses ("3030: Grammar error: Unimplemented keys"),
 * taken out before sending. zod still checks the reply against the full schema.
 * `propertyNames` is what zod writes for every z.record.
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set(['propertyNames'])

function forWorkersAi(schema: unknown, inProperties = false): unknown {
  if (Array.isArray(schema)) return schema.map(s => forWorkersAi(s))
  if (!schema || typeof schema !== 'object') return schema
  return Object.fromEntries(Object.entries(schema)
    // Inside `properties` the keys are field names, so a field called propertyNames stays.
    .filter(([k]) => inProperties || !UNSUPPORTED_SCHEMA_KEYS.has(k))
    .map(([k, v]) => [k, forWorkersAi(v, !inProperties && (k === 'properties' || k === '$defs' || k === 'definitions'))]))
}

/**
 * Workers AI. The model runs on Cloudflare's network; prompts aren't used for
 * training and don't leave Cloudflare. Routed through AI Gateway when an id is
 * given, which adds logging (turn off "collect logs" for clients with health
 * data), rate limits, spend limits and another cache layer.
 */
export class WorkersAiModel extends LanguageModel {
  readonly #ai: Ai
  readonly #model: string
  readonly #gateway?: { id: string; cacheTtl?: number; collectLog?: boolean }
  readonly #inputs: Record<string, unknown>
  readonly #jsonMode: 'schema' | 'object'

  static readonly DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

  /**
   * `inputs` are extra model-specific inputs sent with every call, such as
   * `{ chat_template_kwargs: { enable_thinking: false } }` for GLM.
   *
   * `jsonMode` is how JSON is asked for. `schema` (the default) sends the schema
   * and the model is held to it. `object` only asks for a JSON object, for models
   * whose schema mode breaks answers: GLM 4.7 Flash ends a string at its first
   * line break. Either way completeJson checks the reply against the schema.
   */
  constructor(opts: { ai: Ai; model?: string; gateway?: { id: string; cacheTtl?: number; collectLog?: boolean }; inputs?: Record<string, unknown>; jsonMode?: 'schema' | 'object' }) {
    super()
    this.#ai = opts.ai
    this.#model = opts.model ?? WorkersAiModel.DEFAULT_MODEL
    this.#gateway = opts.gateway
    this.#inputs = opts.inputs ?? {}
    this.#jsonMode = opts.jsonMode ?? 'schema'
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const inputs: Record<string, unknown> = {
      ...this.#inputs,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 800,
      temperature: req.temperature ?? 0.3,
    }
    if (req.jsonSchema) {
      inputs.response_format = this.#jsonMode === 'object'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: forWorkersAi(req.jsonSchema) }
    }

    const options = {
      ...(this.#gateway ? {
        gateway: {
          id: this.#gateway.id,
          cacheTtl: this.#gateway.cacheTtl,
          collectLog: this.#gateway.collectLog ?? false,
          metadata: req.feature ? { feature: req.feature } : undefined,
        },
      } : {}),
      ...(req.session ? { extraHeaders: { 'x-session-affinity': req.session } } : {}),
    }
    const out = await this.#ai.run(this.#model, inputs, Object.keys(options).length ? options : undefined) as {
      response?: unknown
      choices?: { message?: { content?: unknown }; finish_reason?: string }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
    }

    // Older models answer in `response`. OpenAI-shaped ones (GLM, Kimi) answer in
    // `choices[0].message.content` and keep any reasoning apart, which is left out here.
    const answer = out.response ?? out.choices?.[0]?.message?.content
    if (answer === undefined || answer === null || answer === '') {
      const cut = out.choices?.[0]?.finish_reason === 'length' ? ' before running out of tokens' : ''
      throw new UpstreamError('Workers AI', 200, `${this.#model} gave no answer${cut}`)
    }
    // With a JSON schema some models hand back an object rather than a string.
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer)
    return {
      text,
      model: this.#model,
      usage: {
        inputTokens: out.usage?.prompt_tokens ?? 0, outputTokens: out.usage?.completion_tokens ?? 0,
        ...(out.usage?.prompt_tokens_details?.cached_tokens ? { cachedInputTokens: out.usage.prompt_tokens_details.cached_tokens } : {}),
      },
    }
  }

  describe() {
    return {
      name: `Workers AI (${this.#model})`,
      use: 'Drafting emails and reading documents',
      personalInfo: [],
      usesAi: true,
      storesIn: this.#gateway?.collectLog ? 'Cloudflare AI Gateway logs' : 'Not stored (Cloudflare, no training)',
    }
  }
}

/** Base for models that wrap another model. */
export abstract class LanguageModelDecorator extends LanguageModel {
  protected readonly inner: LanguageModel
  constructor(inner: LanguageModel) {
    super()
    this.inner = inner
  }
}

/**
 * Same request, same answer, no second bill. Put this *inside* a
 * RedactingLanguageModel so cached prompts and replies hold placeholders, not
 * customer details.
 */
export class CachedLanguageModel extends LanguageModelDecorator {
  readonly #cache: Cache
  readonly #ttl: number
  constructor(inner: LanguageModel, cache: Cache, ttlSeconds = 7 * 24 * 3600) {
    super(inner)
    this.#cache = cache
    this.#ttl = ttlSeconds
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    // Temperature above zero means the caller wants variety; don't pin it.
    if ((req.temperature ?? 0.3) > 0.5) return this.inner.complete(req)
    const { sensitive: _s, feature: _f, ...cacheable } = req
    const key = `llm:${await sha256Hex(stableJson({ m: this.inner.describe().name, r: cacheable }))}`
    let fresh = false
    const result = await this.#cache.getOrSet(key, this.#ttl, async () => { fresh = true; return this.inner.complete(req) })
    return fresh ? result : { ...result, cached: true, usage: { inputTokens: 0, outputTokens: 0 } }
  }

  describe(): Manifest {
    return mergeManifest(this.inner.describe(), { name: 'Cached', use: this.inner.describe().use, storesIn: `${this.#cache.describe().storesIn} (redacted prompts only)` })
  }
}

/** Swaps personal details for placeholders on the way in and back on the way out. */
export class RedactingLanguageModel extends LanguageModelDecorator {
  readonly #redactor: Redactor
  constructor(inner: LanguageModel, redactor: Redactor) {
    super(inner)
    this.#redactor = redactor
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const session = this.#redactor.session(req.sensitive)
    const out = await this.inner.complete({
      ...req,
      sensitive: undefined,
      messages: req.messages.map(m => ({ ...m, content: session.redact(m.content) })),
    })
    return { ...out, text: session.restore(out.text) }
  }

  describe(): Manifest {
    const inner = this.inner.describe()
    // Patterns and known names come out; a street address in free text can still get through.
    return { ...inner, name: `Redacted → ${inner.name}`, personalInfo: ['anything the patterns miss, e.g. street addresses'] }
  }
}

/** Records tokens used per feature, so "running costs included" stays a sum we can check. */
export class MeteredLanguageModel extends LanguageModelDecorator {
  readonly #meter: UsageMeter
  constructor(inner: LanguageModel, meter: UsageMeter) {
    super(inner)
    this.#meter = meter
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const out = await this.inner.complete(req)
    if (!out.cached) {
      await this.#meter.record({
        feature: req.feature ?? 'unknown', model: out.model, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens,
        ...(out.usage.cachedInputTokens ? { cachedInputTokens: out.usage.cachedInputTokens } : {}),
      })
    }
    return out
  }

  describe() { return this.inner.describe() }
}

/** Replies from a script. For tests and dry runs. */
export class ScriptedLanguageModel extends LanguageModel {
  readonly requests: CompletionRequest[] = []
  readonly #reply: (req: CompletionRequest) => string
  constructor(reply: string | ((req: CompletionRequest) => string)) {
    super()
    this.#reply = typeof reply === 'string' ? () => reply : reply
  }
  async complete(req: CompletionRequest): Promise<Completion> {
    this.requests.push(structuredClone(req))
    return { text: this.#reply(req), model: 'scripted', usage: { inputTokens: 10, outputTokens: 5 } }
  }
  describe() { return { name: 'Scripted model', use: 'Tests', personalInfo: [], usesAi: true, storesIn: 'Memory' } }
}
