import { DEFAULT_GATEWAY, LanguageModel, MeteredLanguageModel, RedactingLanguageModel, WorkersAiModel } from '../ai/language-model'
import { ApprovalStore, D1ApprovalStore } from '../approvals/approval-store'
import { AuditLog, D1AuditLog } from '../audit/audit-log'
import { Clock, SystemClock } from '../kernel/clock'
import { ConfigError } from '../kernel/errors'
import { JsonLogger, Logger } from '../kernel/logger'
import { Module, Token, type Class, type Registry } from '../kernel/registry'
import { CloudflareSecretStore, SecretStore } from '../secrets/secrets'
import { AesGcmCipher, Cipher } from '../security/cipher'
import type { Fetch } from '../security/egress'
import { PatternRedactor, Redactor } from '../security/redactor'
import { HmacSigner, Signer, TokenIssuer } from '../security/signer'
import { SlackWebhookVerifier, WebhookVerifier } from '../security/webhook'
import { TelemetryLogger, instrument } from '../telemetry/instrument'
import { CloudflareTelemetry, OtlpTelemetry, Telemetry } from '../telemetry/telemetry'
import { Agent } from './agent/agent'
import { ToolApprovals } from './agent/approvals'
import { ConversationStore, D1ConversationStore } from './agent/conversations'
import { CredentialBroker, type CredentialHosts } from './agent/credentials'
import { CloudflareJobQueue, JobQueue, type SealedJob } from './agent/jobs'
import { OfflineModel } from './agent/offline-model'
import { ConnectedAccounts, D1TokenVault, TokenVault, parseOAuthProviders } from '../integrations/oauth'
import { D1SettingsStore, Settings, SettingsStore, parseSettings, type AgentSettings, type SettingsEnv } from './agent/settings'
import { D1SpendLedger, SpendLedger } from './agent/spend'
import { ToolBox } from './agent/toolbox'
import { Chat, SlackChat } from './slack/chat'
import { MeteredVisionModel, ScriptedVisionModel, VisionModel, WorkersAiVisionModel } from '../ai/vision-model'
import { ImageModel, MeteredImageModel, ScriptedImageModel, WorkersAiImageModel } from '../ai/image-model'
import { imageTools, timeTools } from './tools/builtin'
import type { ToolServer } from './tools/contract'
import { McpToolServer } from './tools/mcp'

/**
 * One Worker per Slack workspace, like one Worker per client in capabilities:
 * its own D1, KV, queue and secrets, so there's no tenant id to get wrong.
 * Defaults are vars, admins can change some in Slack, and anything secret is a
 * Worker secret.
 */
export interface AgentEnv extends SettingsEnv {
  ENVIRONMENT?: string
  AI: Ai
  /** A Workers AI model id, or "offline" for the free stand-in. */
  AI_MODEL?: string
  /** The Workers AI model images__describe uses. Default Mistral Small 3.1. */
  AI_VISION_MODEL?: string
  /** The Workers AI model tools make images with. Default Lucid Origin. */
  AI_IMAGE_MODEL?: string
  /** The Workers AI model for writing people will read, like social posts. Default DeepSeek V4 Pro. */
  AI_WRITER_MODEL?: string
  /** The AI Gateway every model call goes through. Default "default", which Cloudflare creates on first use. */
  AI_GATEWAY_ID?: string
  DB: D1Database
  KV: KVNamespace
  JOBS: Queue<SealedJob>
  /**
   * JSON. Credential name → hosts it may be sent to, e.g. {"github":["api.github.com"]}, or
   * {"zernio":{"hosts":["zernio.com"],"uploads":["*.r2.cloudflarestorage.com"]}} for an API
   * that hands out presigned upload URLs (reached in the credential's name, never with it).
   */
  CREDENTIAL_HOSTS?: string
  /** JSON. Tool server name → remote MCP URL. */
  MCP_SERVERS?: string
  /** Comma-separated service bindings, each another of our Workers serving MCP (see serveMcp). */
  MCP_BINDINGS?: string
  /** JSON. Accounts admins can connect by OAuth, e.g. {"github":{"scopes":"read:user"}}. */
  OAUTH_PROVIDERS?: string
  /** This Worker's own URL, for OAuth to come back to. */
  PUBLIC_URL?: string

  // Secrets
  SLACK_SIGNING_SECRET: unknown
  SLACK_BOT_TOKEN: unknown
  KEYRING: unknown
  SIGNING_KEY: unknown
  OTEL_EXPORTER_OTLP_ENDPOINT?: string
  OTEL_EXPORTER_OTLP_HEADERS?: unknown
  // OAUTH_<NAME>_CLIENT_ID and OAUTH_<NAME>_CLIENT_SECRET for each provider; CREDENTIAL_<NAME> for API keys.
}

/** The defaults from config. Use `Settings` for what applies now. A plain object, so the type check is against Object. */
export const SETTINGS = new Token<AgentSettings>('settings', Object as unknown as Class<AgentSettings>)
export const SLACK_VERIFIER = new Token<WebhookVerifier>('slack-verifier', WebhookVerifier)
export const TOOL_SERVERS = new Token<ToolServer[]>('tool-servers', Array)
/** The stronger model for writing people will read (AI_WRITER_MODEL). Bound like LanguageModel: redacted and metered. */
export const WriterModel = new Token<LanguageModel>('writer-model', LanguageModel as unknown as Class<LanguageModel>)

const VERSION = '0.1.0'

/** Fast, cheap, and good at picking tools. Answers in JSON mode in about a second with thinking off. */
export const DEFAULT_MODEL = '@cf/zai-org/glm-4.7-flash'
/**
 * For writing that goes out under the business's name. The agent's own model
 * is fine for picking a tool, but its posts read like AI wrote them; tried on
 * the same write-up, DeepSeek V4 Pro kept to the facts and sounded like a person.
 */
export const DEFAULT_WRITER_MODEL = '@cf/deepseek-ai/deepseek-v4-pro-0813'

/**
 * What some models need, measured against the real thing:
 * - GLM thinks before every answer by default: about six times the tokens and
 *   seconds for the same decision, which a reply or one tool call doesn't need.
 * - GLM's schema mode ends a string at its first line break, so a list arrived
 *   as just "I have access to the following tools:". Asking for any JSON object
 *   keeps the whole answer, and the reply is still checked against the schema.
 */
export const MODEL_OPTIONS: Record<string, { inputs?: Record<string, unknown>; jsonMode?: 'schema' | 'object' }> = {
  '@cf/zai-org/glm-4.7-flash': { inputs: { chat_template_kwargs: { enable_thinking: false } }, jsonMode: 'object' },
  // Thinking off for the same reason. Their JSON mode keeps the whole post, line breaks and all.
  '@cf/deepseek-ai/deepseek-v4-pro-0813': { inputs: { chat_template_kwargs: { thinking: false } }, jsonMode: 'object' },
  '@cf/deepseek-ai/deepseek-v4-flash-0731': { inputs: { chat_template_kwargs: { thinking: false } }, jsonMode: 'object' },
}

const parseJson = <T>(name: string, raw: string | undefined): T | undefined => {
  if (!raw) return undefined
  try { return JSON.parse(raw) as T } catch { throw new ConfigError(`${name} is not valid JSON`) }
}

/** What a tools function gets, to build the agent's own tool servers. */
export interface ToolsContext<E extends AgentEnv = AgentEnv> {
  env: E
  /** For sealing anything a tool stores, bound to its own id. */
  cipher: Cipher
  /** The time zone in force. An admin can change it in Slack, so read it when needed. */
  timeZone: () => Promise<string>
  /** A vision model, metered into the spend cap, for tools that look at images. */
  vision: VisionModel
  /** An image model, metered into the spend cap, for tools that make images. */
  images: ImageModel
  /** The agent's own language model (redacted, metered), for tools that need a quick answer. */
  model: LanguageModel
  /** A stronger model (redacted, metered) for writing people will read, like posts. AI_WRITER_MODEL. */
  writer: LanguageModel
  registry: Registry
}

export interface SlackAgentOptions<E extends AgentEnv = AgentEnv> {
  /**
   * The tool servers that run inside this Worker. Default: the time and image tools.
   * MCP servers from MCP_SERVERS and MCP_BINDINGS are added after these.
   */
  tools?: (t: ToolsContext<E>) => ToolServer[]
}

export class SlackAgentModule<E extends AgentEnv = AgentEnv> extends Module {
  protected readonly env: E
  protected readonly options: SlackAgentOptions<E>
  constructor(env: E, options: SlackAgentOptions<E> = {}) {
    super()
    this.env = env
    this.options = options
  }

  register(c: Registry) {
    this.kernel(c)
    this.telemetry(c)
    this.security(c)
    this.records(c)
    this.ai(c)
    this.slack(c)
    this.tools(c)
    this.agent(c)
  }

  protected kernel(c: Registry) {
    c.bind(Clock, () => new SystemClock())
    c.bind(Logger, () => new JsonLogger({ client: 'slack-agent' }))
    c.bind(SETTINGS, () => parseSettings(this.env))
  }

  /** Same as CoreModule: every port traced, logs through telemetry, Cloudflare's tracing unless an OTLP endpoint is set. */
  protected telemetry(c: Registry) {
    const resource = { serviceName: 'pf-slack-agent', serviceVersion: VERSION, environment: this.env.ENVIRONMENT ?? 'production', client: 'slack-agent' }
    c.bind(Telemetry, c => this.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new OtlpTelemetry({ resource, endpoint: this.env.OTEL_EXPORTER_OTLP_ENDPOINT, headers: this.env.OTEL_EXPORTER_OTLP_HEADERS ? c.get(SecretStore).ref('OTEL_EXPORTER_OTLP_HEADERS') : undefined })
      : new CloudflareTelemetry(resource))
    c.bind(Logger, c => new TelemetryLogger(c.get(Telemetry)))
    c.intercept(instrument(() => c.get(Telemetry)))
  }

  protected security(c: Registry) {
    c.bind(SecretStore, () => new CloudflareSecretStore(this.env))
    c.bind(Cipher, c => AesGcmCipher.fromSecret(c.get(SecretStore).ref('KEYRING')))
    c.bind(Signer, c => new HmacSigner(c.get(SecretStore).ref('SIGNING_KEY')))
    c.bind(TokenIssuer, c => new TokenIssuer(c.get(Signer), c.get(Clock)))
    c.bind(Redactor, () => new PatternRedactor())
    c.bind(SLACK_VERIFIER, c => new SlackWebhookVerifier(c.get(SecretStore).ref('SLACK_SIGNING_SECRET'), c.get(Clock)))
  }

  protected records(c: Registry) {
    c.bind(AuditLog, c => new D1AuditLog(this.env.DB, c.get(Clock)))
    c.bind(ApprovalStore, c => new D1ApprovalStore(this.env.DB, c.get(Cipher)))
    c.bind(ConversationStore, c => new D1ConversationStore(this.env.DB, c.get(Cipher), c.get(Clock)))
    c.bind(SettingsStore, c => new D1SettingsStore(this.env.DB, c.get(Clock)))
    c.bind(Settings, c => new Settings(c.get(SETTINGS), c.get(SettingsStore), c.get(AuditLog)))
    c.bind(SpendLedger, c => new D1SpendLedger(this.env.DB, c.get(Clock), this.timeZone(c)))
    c.bind(TokenVault, c => new D1TokenVault(this.env.DB, c.get(Cipher)))
    c.bind(JobQueue, c => new CloudflareJobQueue(this.env.JOBS, c.get(Cipher)))
  }

  /** The time zone in force, read when needed: an admin can change it in Slack. */
  protected timeZone(c: Registry) {
    return async () => (await c.get(Settings).current()).timeZone
  }

  /** For tests: where OAuth's token and account requests go. */
  protected oauthFetch(): Fetch | undefined { return undefined }

  /** Core's model stack: redact, then meter into the spend ledger, then Workers AI through AI Gateway. */
  protected ai(c: Registry) {
    c.bind(LanguageModel, c => this.languageModel(c, this.env.AI_MODEL || DEFAULT_MODEL))
    c.bind(WriterModel, c => this.languageModel(c, this.env.AI_MODEL === 'offline' ? 'offline' : this.env.AI_WRITER_MODEL || DEFAULT_WRITER_MODEL))
    // Only tools call this, and what it says goes on to the main model, which is redacted.
    c.bind(VisionModel, c => {
      const base = this.env.AI_MODEL === 'offline'
        ? new ScriptedVisionModel('(offline stand-in) An image. No real vision model is connected, so nothing more can be said about it.')
        : new WorkersAiVisionModel({ ai: this.env.AI, model: this.env.AI_VISION_MODEL || undefined, gateway: { id: this.env.AI_GATEWAY_ID || DEFAULT_GATEWAY } })
      return new MeteredVisionModel(base, c.get(SpendLedger))
    })
    // Only tools call this, with a prompt they wrote. The image goes to Slack, never to the model.
    c.bind(ImageModel, c => {
      const base = this.env.AI_MODEL === 'offline'
        ? new ScriptedImageModel()
        : new WorkersAiImageModel({ ai: this.env.AI, model: this.env.AI_IMAGE_MODEL || undefined, gateway: { id: this.env.AI_GATEWAY_ID || DEFAULT_GATEWAY } })
      return new MeteredImageModel(base, c.get(SpendLedger))
    })
  }

  protected languageModel(c: Registry, model: string): LanguageModel {
    const base = model === 'offline'
      ? new OfflineModel()
      : new WorkersAiModel({ ai: this.env.AI, model, ...MODEL_OPTIONS[model], gateway: { id: this.env.AI_GATEWAY_ID || DEFAULT_GATEWAY } })
    return new RedactingLanguageModel(new MeteredLanguageModel(base, c.get(SpendLedger)), c.get(Redactor))
  }

  protected slack(c: Registry) {
    c.bind(Chat, c => new SlackChat(c.get(SecretStore).ref('SLACK_BOT_TOKEN')))
  }

  /** Our own tools, then any MCP servers. Override to change the set. */
  protected toolServers(c: Registry): ToolServer[] {
    const own: ToolsContext<E> = {
      env: this.env, cipher: c.get(Cipher), timeZone: this.timeZone(c),
      vision: c.get(VisionModel), images: c.get(ImageModel), model: c.get(LanguageModel), writer: c.get(WriterModel), registry: c,
    }
    const servers: ToolServer[] = this.options.tools ? this.options.tools(own) : [timeTools(own.timeZone), imageTools(own.vision)]
    for (const [name, url] of Object.entries(parseJson<Record<string, string>>('MCP_SERVERS', this.env.MCP_SERVERS) ?? {})) {
      servers.push(new McpToolServer(name, { url }))
    }
    for (const binding of (this.env.MCP_BINDINGS ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
      const fetcher = (this.env as unknown as Record<string, unknown>)[binding] as Fetcher | undefined
      if (!fetcher || typeof fetcher.fetch !== 'function') throw new ConfigError(`${binding} is not a service binding`)
      servers.push(new McpToolServer(binding.toLowerCase().replace(/^mcp_/, ''), { binding: fetcher }))
    }
    return servers
  }

  protected tools(c: Registry) {
    c.bind(TOOL_SERVERS, c => this.toolServers(c))
    c.bind(ToolBox, c => new ToolBox(c.get(TOOL_SERVERS), c.get(Logger)))
    const providers = parseOAuthProviders(this.env.OAUTH_PROVIDERS)
    if (providers.length) {
      const publicUrl = this.env.PUBLIC_URL
      if (!publicUrl) throw new ConfigError('PUBLIC_URL is not set, so OAuth has nowhere to come back to')
      c.bind(ConnectedAccounts, c => new ConnectedAccounts({
        providers, vault: c.get(TokenVault), db: this.env.DB, cipher: c.get(Cipher), secrets: c.get(SecretStore),
        audit: c.get(AuditLog), clock: c.get(Clock), fetch: this.oauthFetch(),
        redirectUri: `${publicUrl.replace(/\/+$/, '')}/oauth/callback`,
        actor: by => `slack:${by}`,
      }))
    }
    c.bind(CredentialBroker, c => new CredentialBroker({
      secrets: c.get(SecretStore),
      hosts: parseJson<CredentialHosts>('CREDENTIAL_HOSTS', this.env.CREDENTIAL_HOSTS) ?? {},
      audit: c.get(AuditLog),
      connected: c.has(ConnectedAccounts) ? c.get(ConnectedAccounts) : undefined,
    }))
  }

  protected agent(c: Registry) {
    c.bind(ToolApprovals, c => new ToolApprovals({ store: c.get(ApprovalStore), tokens: c.get(TokenIssuer), audit: c.get(AuditLog), clock: c.get(Clock) }))
    c.bind(Agent, c => new Agent({
      model: c.get(LanguageModel), tools: c.get(ToolBox), chat: c.get(Chat), conversations: c.get(ConversationStore),
      approvals: c.get(ToolApprovals), spend: c.get(SpendLedger), credentials: c.get(CredentialBroker), audit: c.get(AuditLog),
      vault: c.get(TokenVault), oauth: c.has(ConnectedAccounts) ? c.get(ConnectedAccounts) : undefined,
      settings: c.get(Settings), clock: c.get(Clock), logger: c.get(Logger),
    }))
  }
}
