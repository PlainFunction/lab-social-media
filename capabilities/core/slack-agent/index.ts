// A Slack agent: an AI assistant that lives in Slack, asks before it changes
// anything, and draws every tool's inputs and outputs as Slack forms. One
// Worker per workspace. See README.spec.md.
//
//   import { createSlackAgent, timeTools } from '@plainfunction/capabilities/slack-agent'
//   export default createSlackAgent({ tools: ({ timeZone }) => [timeTools(timeZone)] })
//
// Not exported from core's index: names like Settings and Chat would clash there.

export { createSlackAgent, createSlackWorker } from './worker'
export {
  SlackAgentModule, SETTINGS, SLACK_VERIFIER, TOOL_SERVERS, DEFAULT_MODEL, DEFAULT_WRITER_MODEL, WriterModel, MODEL_OPTIONS,
  type AgentEnv, type SlackAgentOptions, type ToolsContext,
} from './module'

// Writing tools
export {
  ui, out, tool, LocalToolServer, ToolServer, ElicitationNeeded, needsAnswer, toJsonSchema, NAME, IMAGE_ID, IMAGE_TYPES, MAX_IMAGE_BYTES, isImage, filesOfKind, fileIds, FILE_ELEMENTS,
  type FileRef, type FileData,
  type ToolDef, type ToolContext, type CallContext, type ToolResult, type ToolSpec, type ToolAnnotations,
  type ElicitAnswer, type ElicitResult, type Elicitation, type JsonSchema, type JsonSchemaProp, type SlackHint, type FieldOptions,
} from './tools/contract'
export { McpToolServer, serveMcp } from './tools/mcp'
export { timeTools, noteTools, imageTools } from './tools/builtin'
export { VisionModel, WorkersAiVisionModel, MeteredVisionModel, ScriptedVisionModel, type LookRequest } from '../ai/vision-model'
export { ImageModel, WorkersAiImageModel, MeteredImageModel, ScriptedImageModel, PLACEHOLDER_PNG, type ImageRequest, type GeneratedImage } from '../ai/image-model'
export { LanguageModel, ScriptedLanguageModel, type CompletionRequest } from '../ai/language-model'

// The ports and services, for tests and for modules that change them
export { Agent, decisionSchema, MAX_RESULT_CHARS, MAX_QUESTIONS, MAX_TEXT_CHARS, type AgentDeps } from './agent/agent'
export { ToolApprovals, type PendingCall } from './agent/approvals'
export { ConversationStore, MemoryConversationStore, D1ConversationStore, KEEP_MESSAGES } from './agent/conversations'
export { CredentialBroker, type ConnectedTokens, type CredentialHosts } from './agent/credentials'
export { JobQueue, MemoryJobQueue, CloudflareJobQueue, sealJob, openJob, type Job, type SealedJob } from './agent/jobs'
export { OfflineModel } from './agent/offline-model'
export {
  Settings, SettingsStore, MemorySettingsStore, D1SettingsStore, parseSettings, policyFor, defaultPolicy,
  type AgentSettings, type SettingsChanges, type SettingsEnv, type Policy,
} from './agent/settings'
export { SpendLedger, MemorySpendLedger, D1SpendLedger, PRICES, UNKNOWN_PRICE, costOf, monthOf } from './agent/spend'
export { ToolBox, type NamedTool } from './agent/toolbox'
export { Chat, SlackChat, MemoryChat } from './slack/chat'
export { routeEvent, stripMention, attachments, TEXT_TYPES, MAX_TEXT_BYTES, type SlackMessageEvent } from './slack/events'
export { toMrkdwn, escapeSlack } from './slack/mrkdwn'
