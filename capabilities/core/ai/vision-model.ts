import { UpstreamError, ValidationError } from '../kernel/errors'
import { Port, type Manifest } from '../kernel/port'
import type { UsageMeter } from '../looked-after/usage'
import type { Completion } from './language-model'

export interface ImageInput { bytes: Uint8Array; mimetype: string }

export interface LookRequest {
  image: ImageInput
  /** What to say about it, e.g. "Describe this for someone who can't see it". */
  prompt: string
  /** For metering, like LanguageModel's. */
  feature?: string
  maxTokens?: number
}

/**
 * A model that looks at one image and answers in text. Separate from
 * LanguageModel, so the main model can stay text-only and cheap, and an image
 * only goes to a vision model when a tool asks for it.
 */
export abstract class VisionModel extends Port {
  abstract look(req: LookRequest): Promise<Completion>
}

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Standard base64, which data URLs want. In chunks, so a big image doesn't overflow the call stack. */
function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/**
 * A vision model on Workers AI, given the image as an OpenAI-style `image_url`
 * data URL. Tested against Mistral Small 3.1, which needs no licence accepted
 * first (Llama 3.2 Vision does) and cost about $0.0004 for one image.
 */
export class WorkersAiVisionModel extends VisionModel {
  readonly #ai: Ai
  readonly #model: string
  readonly #gateway?: { id: string; collectLog?: boolean }

  static readonly DEFAULT_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'

  constructor(opts: { ai: Ai; model?: string; gateway?: { id: string; collectLog?: boolean } }) {
    super()
    this.#ai = opts.ai
    this.#model = opts.model ?? WorkersAiVisionModel.DEFAULT_MODEL
    this.#gateway = opts.gateway
  }

  async look(req: LookRequest): Promise<Completion> {
    if (!TYPES.includes(req.image.mimetype)) throw new ValidationError(`Can't look at ${req.image.mimetype} images`)
    const url = `data:${req.image.mimetype};base64,${toBase64(req.image.bytes)}`
    const out = await this.#ai.run(this.#model as keyof AiModels, {
      messages: [{ role: 'user', content: [{ type: 'text', text: req.prompt }, { type: 'image_url', image_url: { url } }] }],
      max_tokens: req.maxTokens ?? 400,
      temperature: 0.2,
    } as never, this.#gateway ? { gateway: { id: this.#gateway.id, collectLog: this.#gateway.collectLog ?? false } } : undefined) as {
      response?: unknown
      choices?: { message?: { content?: unknown } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const text = out.response ?? out.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new UpstreamError('Workers AI', 200, `${this.#model} gave no description`)
    return { text: text.trim(), model: this.#model, usage: { inputTokens: out.usage?.prompt_tokens ?? 0, outputTokens: out.usage?.completion_tokens ?? 0 } }
  }

  describe(): Manifest {
    return { name: `Workers AI vision (${this.#model})`, use: 'Describing images people attach', personalInfo: ['whatever is in the image'], usesAi: true, storesIn: 'Not stored (Cloudflare, no training)' }
  }
}

/** Records what each look cost, like MeteredLanguageModel. */
export class MeteredVisionModel extends VisionModel {
  readonly #inner: VisionModel
  readonly #meter: UsageMeter
  constructor(inner: VisionModel, meter: UsageMeter) {
    super()
    this.#inner = inner
    this.#meter = meter
  }
  async look(req: LookRequest): Promise<Completion> {
    const out = await this.#inner.look(req)
    await this.#meter.record({ feature: req.feature ?? 'unknown', model: out.model, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens })
    return out
  }
  describe() { return this.#inner.describe() }
}

/** Answers from a script and keeps each request. For tests and the offline stand-in. */
export class ScriptedVisionModel extends VisionModel {
  readonly requests: LookRequest[] = []
  readonly #reply: (req: LookRequest) => string
  constructor(reply: string | ((req: LookRequest) => string)) {
    super()
    this.#reply = typeof reply === 'string' ? () => reply : reply
  }
  async look(req: LookRequest): Promise<Completion> {
    this.requests.push({ ...req, image: { ...req.image, bytes: req.image.bytes.slice() } })
    return { text: this.#reply(req), model: 'scripted-vision', usage: { inputTokens: 10, outputTokens: 5 } }
  }
  describe(): Manifest { return { name: 'Scripted vision model', use: 'Tests', personalInfo: [], usesAi: true, storesIn: 'Memory' } }
}
