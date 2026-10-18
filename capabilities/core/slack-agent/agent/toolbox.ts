import type { Logger } from '../../kernel/logger'
import type { CallContext, ToolResult, ToolServer, ToolSpec } from '../tools/contract'

export interface NamedTool extends ToolSpec {
  /** `server__tool`, what the model sees. */
  fullName: string
  server: ToolServer
}

/** Every tool from every server, under one name each. A server that won't list is left out, not fatal. */
export class ToolBox {
  readonly #servers: ToolServer[]
  readonly #logger: Logger
  #tools?: Promise<NamedTool[]>

  constructor(servers: ToolServer[], logger: Logger) {
    this.#servers = servers
    this.#logger = logger
  }

  all(): Promise<NamedTool[]> {
    this.#tools ??= Promise.all(this.#servers.map(async server => {
      try {
        return (await server.list()).map(t => ({ ...t, fullName: `${server.name}__${t.name}`, server }))
      } catch (err) {
        this.#logger.warn('tools.list.failed', { server: server.name, error: err })
        // Try that server again next time.
        this.#tools = undefined
        return []
      }
    })).then(lists => lists.flat())
    return this.#tools
  }

  /** Every server's name, whether or not it's answering. */
  servers(): string[] { return this.#servers.map(s => s.name) }

  async find(fullName: string): Promise<NamedTool | undefined> {
    return (await this.all()).find(t => t.fullName === fullName)
  }

  async call(t: NamedTool, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
    try {
      return await t.server.call(t.name, args, ctx)
    } catch (err) {
      this.#logger.error('tool.call.failed', { tool: t.fullName, error: err })
      return { ok: false, error: 'The tool could not be reached' }
    }
  }
}
