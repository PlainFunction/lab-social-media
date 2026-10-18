import { z } from 'zod'
import { CapabilityError, ConfigError, NotAllowedError, ValidationError } from '../../kernel/errors'
import { Port, type Manifest } from '../../kernel/port'
// The tool contract. Every tool declares its inputs as Slack form elements and
// its outputs as Slack blocks, as JSON Schema metadata under `x-slack`. Any MCP
// client still sees an ordinary inputSchema and outputSchema; this agent reads
// the hints to draw approval forms, missing-input forms and results.

export type SlackInput =
  | 'plain_text_input' | 'number_input' | 'email_text_input' | 'url_text_input'
  | 'datepicker' | 'timepicker' | 'static_select' | 'checkboxes' | 'users_select' | 'conversations_select'
  /** Ours, not Slack's: a pick of the images attached in the conversation. */
  | 'image_select'
  /** Ours, not Slack's: a pick of the text files attached in the conversation. */
  | 'document_select'
  /** Ours, not Slack's: a pick of several images in the conversation, in order (a carousel). */
  | 'images_select'
export type SlackOutput = 'header' | 'field' | 'text' | 'context' | 'image' | 'link' | 'list'

/** One row of an `out.list`: a job, a quote, an invoice. */
export interface ListItem {
  title: string
  /** A second line, e.g. the suburb. */
  detail?: string
  /** Short, shown beside the title, e.g. "7:30am" or "$1,850". */
  meta?: string
}

const listItem = z.object({ title: z.string().min(1).max(200), detail: z.string().max(500).optional(), meta: z.string().max(60).optional() })

/** Images a tool can be given or hand back. Slack shows these inline. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
/** Bigger images are refused both ways, so one photo can't fill a Worker's memory. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** A file someone attached (an image or a text file), as the conversation keeps it. The bytes stay in Slack until a tool asks. */
export interface FileRef { id: string; name: string; mimetype: string; size: number }

export const isImage = (f: { mimetype: string }) => (IMAGE_TYPES as readonly string[]).includes(f.mimetype)

/** The form elements that take a file from the conversation, and which kind each takes. */
export const FILE_ELEMENTS: Partial<Record<SlackInput, 'image' | 'document'>> = { image_select: 'image', images_select: 'image', document_select: 'document' }
/** The ids a file field's value names: one, or several for `ui.images`. */
export const fileIds = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string')
/** The conversation's files a field of this kind can take. */
export const filesOfKind = (files: FileRef[], kind: 'image' | 'document') => files.filter(f => isImage(f) === (kind === 'image'))
/** What `ctx.file` hands a tool. */
export interface FileData { id: string; name: string; mimetype: string; bytes: Uint8Array }

const SLACK_FILE_ID = /^F[A-Z0-9]{6,}$/
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/
const httpsUrl = z.url({ protocol: /^https$/ })

export interface SlackHint {
  element: SlackInput | SlackOutput
  label: string
  multiline?: boolean
}

export interface FieldOptions {
  /** Shown to the model, and under the field in Slack. */
  description?: string
  multiline?: boolean
}

// `.describe()` after this would replace the metadata, so descriptions go in here.
const hint = <S extends z.ZodType>(schema: S, slack: SlackHint, o: FieldOptions = {}): S =>
  schema.meta({ ...(o.description ? { description: o.description } : {}), 'x-slack': { ...slack, ...(o.multiline ? { multiline: true } : {}) } }) as S

export const ui = {
  text: (label: string, o?: FieldOptions) => hint(z.string().trim().min(1).max(3000), { element: 'plain_text_input', label }, o),
  number: (label: string, o?: FieldOptions) => hint(z.number(), { element: 'number_input', label }, o),
  email: (label: string, o?: FieldOptions) => hint(z.email(), { element: 'email_text_input', label }, o),
  url: (label: string, o?: FieldOptions) => hint(z.url({ protocol: /^https$/ }), { element: 'url_text_input', label }, o),
  date: (label: string, o?: FieldOptions) => hint(z.iso.date(), { element: 'datepicker', label }, o),
  time: (label: string, o?: FieldOptions) => hint(z.iso.time({ precision: -1 }), { element: 'timepicker', label }, o),
  select: <const T extends readonly [string, ...string[]]>(label: string, options: T, o?: FieldOptions) =>
    hint(z.enum(options), { element: 'static_select', label }, o),
  checkbox: (label: string, o?: FieldOptions) => hint(z.boolean(), { element: 'checkboxes', label }, o),
  user: (label: string, o?: FieldOptions) => hint(z.string().regex(/^[UW][A-Z0-9]{2,}$/), { element: 'users_select', label }, o),
  conversation: (label: string, o?: FieldOptions) => hint(z.string().regex(/^[CGD][A-Z0-9]{2,}$/), { element: 'conversations_select', label }, o),
  /**
   * An image someone attached in this conversation. The value is its Slack file
   * id; read it with `ctx.file(id)`. In a form it's a pick of the attached images.
   */
  image: (label: string, o?: FieldOptions) => hint(z.string().regex(SLACK_FILE_ID), { element: 'image_select', label }, o),
  /**
   * A text file someone attached in this conversation (Markdown, plain text,
   * CSV, JSON). The value is its Slack file id; read it with `ctx.file(id)` and
   * decode the bytes. In a form it's a pick of the attached text files.
   */
  document: (label: string, o?: FieldOptions) => hint(z.string().regex(SLACK_FILE_ID), { element: 'document_select', label }, o),
  /**
   * Several images in this conversation, in order: a carousel. The value is a
   * list of Slack file ids, each read with `ctx.file(id)`. In a form it's a
   * multi-pick of the conversation's images.
   */
  images: (label: string, o?: FieldOptions & { max?: number }) =>
    hint(z.array(z.string().regex(SLACK_FILE_ID)).min(1).max(o?.max ?? 10), { element: 'images_select', label }, o),
}

export const out = {
  header: (label: string) => hint(z.string(), { element: 'header', label }),
  field: (label: string) => hint(z.string(), { element: 'field', label }),
  text: (label: string) => hint(z.string(), { element: 'text', label }),
  context: (label: string) => hint(z.string(), { element: 'context', label }),
  /**
   * An image: an https URL Slack can fetch, one the tool made, as a
   * `data:image/png;base64,...` URL, which the agent uploads to the thread, or
   * the id of one already in the conversation (an unchanged slide, say), which
   * isn't shown again. The model sees ids, never the bytes.
   */
  image: (label: string) => hint(z.union([httpsUrl, z.string().regex(DATA_IMAGE).max(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64), z.string().regex(SLACK_FILE_ID)]), { element: 'image', label }),
  /** A link, shown as the label pointing at the URL. https only. */
  link: (label: string) => hint(httpsUrl, { element: 'link', label }),
  /** Rows, each a title with an optional detail line and a short meta, like a time or an amount. Up to 50. */
  list: (label: string) => hint(z.array(listItem).max(50), { element: 'list', label }),
}

export interface ToolAnnotations {
  /** Only reads. Runs without asking, unless the settings say otherwise. */
  readOnlyHint?: boolean
  /** Deletes or overwrites something. Always asks unless the settings say otherwise. */
  destructiveHint?: boolean
  /**
   * Its result is for the person to look at (a draft, say). The agent runs it at
   * most once per message and then replies, whatever the model asks for. Without
   * this, a small model that liked the result kept calling it again.
   */
  oncePerTurnHint?: boolean
}

/** What the caller gives a tool server for one call. */
export interface CallContext {
  /** Slack user id of whoever asked. */
  user: string
  now: Date
  /**
   * Calls an API with a credential attached by name. The tool never sees the
   * credential, and the call can only reach the hosts that credential is for.
   */
  fetch(url: string, init?: RequestInit & { credential?: string }): Promise<Response>
  /** Answers to this call's follow-up questions so far, in the order they were asked. */
  answers?: ElicitAnswer[]
  /** A file attached or made in this conversation, by id. Anything else is refused. */
  file?(id: string): Promise<FileData>
  /**
   * Whether the person asking holds a permission, e.g. `ctx.can?.('see:prices')`,
   * so a tool can show more to some people than others. Set by callers that have
   * roles (the app); absent elsewhere, and never sent to MCP tools.
   */
  can?(permission: string): boolean
}

export type ElicitAnswer = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' }
export type ElicitResult<T> = { action: 'accept'; content: T } | { action: 'decline' }

/** A follow-up question, drawn as a Slack form like any tool input. */
export interface Elicitation { message: string; schema: JsonSchema }

/** What a tool's `run` gets. */
export interface ToolContext extends Omit<CallContext, 'answers' | 'file'> {
  /** Reads a file attached or made in this conversation (a `ui.image` or `ui.document` value). */
  file(id: string): Promise<FileData>
  /**
   * Asks the person something partway through. The call stops here, the
   * question goes to Slack as a form, and once it's answered the tool runs
   * again from the top with every answer so far. So nothing with a side
   * effect may happen before the last `elicit`, or it happens once per question.
   */
  elicit<S extends z.ZodObject>(message: string, schema: S): Promise<ElicitResult<z.output<S>>>
}

/** Thrown by `elicit` when the answer isn't in yet. LocalToolServer turns it into a result. */
export class ElicitationNeeded extends Error {
  readonly elicitation: Elicitation
  constructor(elicitation: Elicitation) {
    super(`Needs more information: ${elicitation.message}`)
    this.elicitation = elicitation
  }
}

export interface ToolDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  title?: string
  description: string
  input: I
  output: O
  annotations?: ToolAnnotations
  run(input: z.output<I>, ctx: ToolContext): Promise<z.input<O>> | z.input<O>
}

/** Keeps the input and output types of one tool tied together. */
export const tool = <I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>): ToolDef<I, O> => def

export interface JsonSchemaProp {
  type?: string
  format?: string
  enum?: unknown[]
  description?: string
  'x-slack'?: SlackHint
  [k: string]: unknown
}
export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchemaProp>
  required?: string[]
  [k: string]: unknown
}

export interface ToolSpec {
  /** Unique within its server: letters, digits and single underscores. */
  name: string
  title?: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: ToolAnnotations
}

export type ToolResult =
  | { ok: true; content: Record<string, unknown> }
  | { ok: false; error: string }
  /** The tool stopped to ask something. Call it again with the answer added. */
  | { ok: false; error: string; elicit: Elicitation }

export const needsAnswer = (r: ToolResult): r is Extract<ToolResult, { elicit: Elicitation }> => 'elicit' in r

/**
 * A set of tools: our own in this Worker, or an MCP server elsewhere. Servers
 * are named so the model sees `server__tool`, which every model accepts as a
 * function name.
 */
export abstract class ToolServer extends Port {
  abstract readonly name: string
  abstract list(): Promise<ToolSpec[]>
  abstract call(tool: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult>
}

export const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

export const toJsonSchema = (schema: z.ZodType, io: 'input' | 'output'): JsonSchema => {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>
  return rest as JsonSchema
}

/** Slack forms are flat, and every field needs a hint, or the server won't start. The lists allowed are `out.list` and `ui.images`. */
function checkHints(where: string, schema: JsonSchema) {
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const list = prop.type === 'array' && (prop['x-slack']?.element === 'list' || prop['x-slack']?.element === 'images_select')
    if ((prop.type === 'object' || prop.type === 'array') && !list) throw new ConfigError(`${where}.${key}: Slack forms are flat, so no nested objects or lists`)
    if (!prop['x-slack']) throw new ConfigError(`${where}.${key} has no Slack hint. Use ui.* for inputs and out.* for outputs`)
  }
}

const issues = (e: z.ZodError) => e.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')

/** Tools that run inside this Worker. */
export class LocalToolServer extends ToolServer {
  readonly name: string
  readonly #tools: Record<string, ToolDef>
  readonly #specs: ToolSpec[]
  readonly #manifest: Omit<Manifest, 'name'>

  constructor(name: string, tools: Record<string, ToolDef>, manifest: Omit<Manifest, 'name'>) {
    super()
    if (!NAME.test(name)) throw new ConfigError(`Bad tool server name ${name}`)
    this.name = name
    this.#tools = tools
    this.#manifest = manifest
    this.#specs = Object.entries(tools).map(([key, def]) => {
      if (!NAME.test(key)) throw new ConfigError(`Bad tool name ${name}.${key}`)
      const inputSchema = toJsonSchema(def.input, 'input')
      const outputSchema = toJsonSchema(def.output, 'output')
      checkHints(`${name}.${key} input`, inputSchema)
      checkHints(`${name}.${key} output`, outputSchema)
      return { name: key, title: def.title, description: def.description, inputSchema, outputSchema, annotations: def.annotations }
    })
  }

  async list() { return this.#specs }

  async call(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
    const def = Object.hasOwn(this.#tools, name) ? this.#tools[name] : undefined
    if (!def) return { ok: false, error: `No tool called ${name}` }
    const input = def.input.safeParse(args)
    if (!input.success) return { ok: false, error: `Invalid input. ${issues(input.error)}` }

    // Replays the answers so far, in order, and stops at the first question without one.
    const { answers = [], file, ...rest } = ctx
    let asked = 0
    const elicit: ToolContext['elicit'] = async (message, schema) => {
      const answer = answers[asked]
      if (!answer) {
        const json = toJsonSchema(schema, 'input')
        checkHints(`${this.name}.${name} question`, json)
        throw new ElicitationNeeded({ message, schema: json })
      }
      asked++
      if (answer.action !== 'accept') return { action: 'decline' }
      const parsed = schema.safeParse(answer.content)
      if (!parsed.success) throw new ValidationError(`That answer didn't fit. ${issues(parsed.error)}`)
      return { action: 'accept', content: parsed.data }
    }

    let raw: unknown
    try {
      const read = file ?? (async () => { throw new NotAllowedError('No files are available to this call') })
      raw = await def.run(input.data, { ...rest, elicit, file: read })
    } catch (err) {
      if (err instanceof ElicitationNeeded) return { ok: false, error: err.message, elicit: err.elicitation }
      // Our own errors carry messages written to be shown; anything else stays vague.
      return { ok: false, error: err instanceof CapabilityError ? err.message : 'The tool failed' }
    }
    const output = def.output.safeParse(raw)
    if (!output.success) return { ok: false, error: `The tool returned the wrong shape. ${issues(output.error)}` }
    return { ok: true, content: output.data as Record<string, unknown> }
  }

  describe(): Manifest {
    return { name: `Tools: ${this.name}`, ...this.#manifest }
  }
}
