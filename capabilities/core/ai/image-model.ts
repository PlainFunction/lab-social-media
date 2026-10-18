import { UpstreamError, ValidationError } from '../kernel/errors'
import { Port, type Manifest } from '../kernel/port'
import type { UsageMeter } from '../looked-after/usage'

export interface ImageRequest {
  /** What to draw. Plain description, no personal details. */
  prompt: string
  /** Pixels. Models that take a size use it; the rest make their own default (1024x1024). */
  width?: number
  height?: number
  /** For metering, like LanguageModel's. */
  feature?: string
}

export interface GeneratedImage {
  bytes: Uint8Array
  mimetype: 'image/jpeg' | 'image/png'
  model: string
}

/** Image models are metered as one output token per image; see `PRICES` in slack-agent's spend. */
export const IMAGE_USAGE = { inputTokens: 0, outputTokens: 1 }

/** The longest prompt the FLUX models take on Workers AI. */
export const MAX_IMAGE_PROMPT = 2048

/**
 * Makes an image from a text prompt. Separate from LanguageModel and
 * VisionModel: it's priced per image, not per token, and only runs when a
 * tool asks for a picture.
 */
export abstract class ImageModel extends Port {
  abstract generate(req: ImageRequest): Promise<GeneratedImage>
}

const fromBase64 = (b64: string) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** FLUX.2 on Workers AI takes its inputs as a multipart form, passed as a stream and its content type. */
async function multipart(fields: Record<string, string | number>) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v))
  const r = new Response(form)
  return { multipart: { body: r.body, contentType: r.headers.get('content-type') } }
}

/** What the bytes are, from their first few, so the type is never taken on trust. */
export function sniffImage(bytes: Uint8Array): GeneratedImage['mimetype'] | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  return undefined
}

/**
 * Text to image on Workers AI. Default Leonardo's Lucid Origin: it follows a
 * style description well (a flat caricature, say), takes about six seconds,
 * and costs about $0.025 for a 1024x768 picture (three 512x512 tiles at
 * $0.006996 plus its steps, Workers AI's pricing page, October 2026).
 *
 * FLUX.2 [klein] 9B draws as well, faster and cheaper, but it takes its input
 * as a multipart stream, which AI Gateway refuses ("AI Gateway does not support
 * ReadableStreams yet", October 2026). So FLUX.2 calls go to Workers AI
 * directly, still metered here but not seen by the gateway. FLUX.1 schnell is
 * the cheap one, about $0.00065, but it ignores most of a style description.
 * All of them answer `{ image: base64 }`.
 */
export class WorkersAiImageModel extends ImageModel {
  readonly #ai: Ai
  readonly #model: string
  readonly #steps?: number
  readonly #gateway?: { id: string; collectLog?: boolean }

  static readonly DEFAULT_MODEL = '@cf/leonardo/lucid-origin'

  constructor(opts: { ai: Ai; model?: string; steps?: number; gateway?: { id: string; collectLog?: boolean } }) {
    super()
    this.#ai = opts.ai
    this.#model = opts.model ?? WorkersAiImageModel.DEFAULT_MODEL
    // FLUX.1 schnell is made for four steps; the others know their own best.
    this.#steps = opts.steps ?? (this.#model.includes('flux-1-schnell') ? 4 : undefined)
    this.#gateway = opts.gateway
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const prompt = req.prompt.trim()
    if (!prompt) throw new ValidationError('An image needs a description')
    const fields: Record<string, string | number> = { prompt: prompt.slice(0, MAX_IMAGE_PROMPT) }
    if (req.width && req.height) Object.assign(fields, { width: req.width, height: req.height })
    const flux2 = this.#model.includes('/flux-2-')
    const gateway = this.#gateway && !flux2 ? { gateway: { id: this.#gateway.id, collectLog: this.#gateway.collectLog ?? false } } : undefined
    const out = await this.#ai.run(this.#model as keyof AiModels, (flux2
      ? await multipart(fields)
      : { ...fields, ...(this.#steps ? { steps: this.#steps } : {}) }) as never, gateway) as { image?: unknown }
    if (typeof out?.image !== 'string' || !out.image) throw new UpstreamError('Workers AI', 200, `${this.#model} gave no image`)
    const bytes = fromBase64(out.image)
    const mimetype = sniffImage(bytes)
    if (!mimetype) throw new UpstreamError('Workers AI', 200, `${this.#model} gave something that isn't a JPEG or PNG`)
    return { bytes, mimetype, model: this.#model }
  }

  describe(): Manifest {
    return { name: `Workers AI images (${this.#model})`, use: 'Making images for social posts', personalInfo: [], usesAi: true, storesIn: 'Not stored (Cloudflare, no training)' }
  }
}

/** Records each image, like MeteredVisionModel, so images count towards a spend cap. */
export class MeteredImageModel extends ImageModel {
  readonly #inner: ImageModel
  readonly #meter: UsageMeter
  constructor(inner: ImageModel, meter: UsageMeter) {
    super()
    this.#inner = inner
    this.#meter = meter
  }
  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const out = await this.#inner.generate(req)
    await this.#meter.record({ feature: req.feature ?? 'unknown', model: out.model, ...IMAGE_USAGE })
    return out
  }
  describe() { return this.#inner.describe() }
}

/** A 1x1 grey PNG. What the stand-in hands back. */
export const PLACEHOLDER_PNG = fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN4+/btfwAJYgPQJV6H1wAAAABJRU5ErkJggg==')

/** Hands back a placeholder and keeps each request. For tests and the offline stand-in. */
export class ScriptedImageModel extends ImageModel {
  readonly requests: ImageRequest[] = []
  readonly #image: Uint8Array
  constructor(image: Uint8Array = PLACEHOLDER_PNG) { super(); this.#image = image }
  async generate(req: ImageRequest): Promise<GeneratedImage> {
    this.requests.push(req)
    return { bytes: this.#image.slice(), mimetype: sniffImage(this.#image) ?? 'image/png', model: 'scripted-image' }
  }
  describe(): Manifest { return { name: 'Scripted image model', use: 'Tests', personalInfo: [], usesAi: true, storesIn: 'Memory' } }
}
