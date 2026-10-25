import { b64url, fromB64 } from '../../kernel/encoding'
import { ConfigError, NotAllowedError, UpstreamError } from '../../kernel/errors'
import type { Manifest } from '../../kernel/port'
import type { SecretRef } from '../../secrets/secrets'
import { HttpClient, type Fetch } from '../../security/egress'
import { FILE_ELEMENTS, LocalToolServer, fileIds, MAX_IMAGE_BYTES, NAME, ToolServer, needsAnswer, type SlackInput, type CallContext, type ElicitAnswer, type Elicitation, type FileData, type ToolResult, type ToolSpec } from './contract'

// The four JSON-RPC methods a tool server needs, over plain HTTP POST with no
// session. That's enough for our own tool Workers (over a service binding) and
// for remote servers that accept stateless calls.

const PROTOCOL = '2025-06-18'

interface RpcReply<T> { jsonrpc: '2.0'; id: number | string | null; result?: T; error?: { code: number; message: string } }
interface McpCallResult {
  content?: { type: string; text?: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

// MCP elicitation needs a session held open while the person answers, which a
// Worker can't do. So a question comes back in the result's _meta, the answers
// so far go out in the call's _meta, and the server replays. Other MCP clients
// just see an error saying what was needed.
const ELICIT = 'slack/elicit'
const ANSWERS = 'slack/answers'
// A tool Worker can't reach Slack, so the files its arguments name travel with
// the call, base64, and its ctx.file reads them from there. Only those.
const FILES = 'slack/files'

interface SentFile { name: string; mimetype: string; data: string }

const isElicitation = (v: unknown): v is Elicitation =>
  !!v && typeof v === 'object' && typeof (v as Elicitation).message === 'string' && !!(v as Elicitation).schema && typeof (v as Elicitation).schema === 'object'

type Endpoint =
  /** Another of our Workers. Never leaves Cloudflare, so there's no host to allow. */
  | { binding: Fetcher }
  /** A remote server, reachable only at its own host. */
  | { url: string; token?: SecretRef }

/** Tools on an MCP server. Remote servers never get a credential from us. */
export class McpToolServer extends ToolServer {
  readonly name: string
  readonly #endpoint: Endpoint
  readonly #http?: HttpClient
  #id = 0
  #specs?: Promise<ToolSpec[]>

  constructor(name: string, endpoint: Endpoint, opts: { fetch?: Fetch } = {}) {
    super()
    if (!NAME.test(name)) throw new ConfigError(`Bad tool server name ${name}`)
    this.name = name
    this.#endpoint = endpoint
    if ('url' in endpoint) this.#http = new HttpClient({ service: `MCP ${name}`, allow: [new URL(endpoint.url).hostname], fetch: opts.fetch })
  }

  async #rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
    }
    let res: Response
    if ('binding' in this.#endpoint) {
      res = await this.#endpoint.binding.fetch('https://mcp.internal/', init)
    } else {
      if (this.#endpoint.token) (init.headers as Record<string, string>).authorization = `Bearer ${(await this.#endpoint.token.get()).reveal()}`
      res = await this.#http!.request(this.#endpoint.url, init)
    }
    if (!res.ok) throw new UpstreamError(`MCP ${this.name}`, res.status, await res.text().catch(() => ''))
    const reply = await res.json() as RpcReply<T>
    if (reply.error) throw new UpstreamError(`MCP ${this.name}`, 200, reply.error.message)
    return reply.result as T
  }

  list(): Promise<ToolSpec[]> {
    this.#specs ??= (async () => {
      await this.#rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'slack-agent', version: '0.1.0' } })
      const { tools } = await this.#rpc<{ tools: ToolSpec[] }>('tools/list', {})
      const named = tools.filter(t => NAME.test(t.name))
      // A remote server saying a tool only reads is its word, not ours: if the model is
      // talked into calling it, the arguments still leave. So its tools ask unless an admin
      // allows them. Hints that make us more careful (destructive, once per turn) stay.
      if ('binding' in this.#endpoint) return named
      return named.map(t => t.annotations?.readOnlyHint ? { ...t, annotations: { ...t.annotations, readOnlyHint: false } } : t)
    })().catch(err => { this.#specs = undefined; throw err })
    return this.#specs
  }

  /** The files a call's arguments name (images and text files), read with ctx.file, to send along. */
  async #files(tool: string, args: Record<string, unknown>, ctx: CallContext): Promise<Record<string, SentFile>> {
    const spec = (await this.list()).find(t => t.name === tool)
    const ids = Object.entries(spec?.inputSchema.properties ?? {})
      .filter(([, p]) => !!FILE_ELEMENTS[p['x-slack']?.element as SlackInput])
      .flatMap(([k]) => fileIds(args[k]))
    const out: Record<string, SentFile> = {}
    for (const id of new Set(ids)) {
      if (!ctx.file) throw new NotAllowedError('No files are available to this call')
      const f = await ctx.file(id)
      out[id] = { name: f.name, mimetype: f.mimetype, data: b64url(f.bytes) }
    }
    return out
  }

  async call(tool: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
    let files: Record<string, SentFile>
    try { files = await this.#files(tool, args, ctx) } catch (err) { return { ok: false, error: err instanceof NotAllowedError ? err.message : "Couldn't read that file" } }
    const r = await this.#rpc<McpCallResult>('tools/call', { name: tool, arguments: args, _meta: { 'slack/user': ctx.user, [ANSWERS]: ctx.answers ?? [], ...(Object.keys(files).length ? { [FILES]: files } : {}) } })
    const text = (r.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
    const question = r._meta?.[ELICIT]
    if (r.isError && isElicitation(question)) return { ok: false, error: text.slice(0, 2000), elicit: { message: question.message.slice(0, 2000), schema: question.schema } }
    if (r.isError) return { ok: false, error: text.slice(0, 2000) || 'The tool failed' }
    return { ok: true, content: r.structuredContent ?? { text } }
  }

  describe(): Manifest {
    const where = 'binding' in this.#endpoint ? 'another of our Workers' : new URL(this.#endpoint.url).hostname
    return {
      name: `Tools: ${this.name} (MCP)`,
      use: `Tools on ${where}`,
      personalInfo: ['whatever the person asks for'],
      storesIn: 'Depends on the server',
      egress: this.#http ? [...this.#http.allow] : [],
    }
  }
}

/**
 * Serves a LocalToolServer as an MCP endpoint, so a set of tools can be its own
 * Worker behind a service binding. Credentials don't cross: ctx.fetch refuses.
 */
export function serveMcp(server: LocalToolServer, info: { version: string } = { version: '0.1.0' }) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> }
    try { msg = await request.json() } catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
    const { id = null, method = '', params = {} } = msg
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result })

    if (method === 'initialize') {
      return reply({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: server.name, version: info.version } })
    }
    if (method === 'tools/list') return reply({ tools: await server.list() })
    if (method === 'tools/call') {
      const meta = (params._meta ?? {}) as Record<string, unknown>
      const sent = (meta[FILES] && typeof meta[FILES] === 'object' ? meta[FILES] : {}) as Record<string, SentFile>
      const file = async (fileId: string): Promise<FileData> => {
        const f = Object.hasOwn(sent, fileId) ? sent[fileId] : undefined
        if (!f || typeof f.data !== 'string') throw new NotAllowedError("That file wasn't sent with this call")
        const bytes = fromB64(f.data)
        if (bytes.byteLength > MAX_IMAGE_BYTES) throw new NotAllowedError('That file is too big')
        return { id: fileId, name: String(f.name), mimetype: String(f.mimetype), bytes }
      }
      const ctx: CallContext = {
        file,
        user: typeof meta['slack/user'] === 'string' ? meta['slack/user'] : 'unknown',
        now: new Date(),
        fetch: async () => { throw new ConfigError('Credentials are only available to tools inside the agent Worker') },
        answers: Array.isArray(meta[ANSWERS]) ? meta[ANSWERS] as ElicitAnswer[] : [],
      }
      const r = await server.call(String(params.name ?? ''), (params.arguments ?? {}) as Record<string, unknown>, ctx)
      if (r.ok) return reply({ content: [{ type: 'text', text: JSON.stringify(r.content) }], structuredContent: r.content })
      return reply({ content: [{ type: 'text', text: r.error }], isError: true, ...(needsAnswer(r) ? { _meta: { [ELICIT]: r.elicit } } : {}) })
    }
    if (method.startsWith('notifications/')) return new Response(null, { status: 202 })
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
  }
}
