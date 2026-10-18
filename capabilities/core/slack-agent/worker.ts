import { Clock } from '../kernel/clock'
import { Logger } from '../kernel/logger'
import type { Module, Registry } from '../kernel/registry'
import { Cipher } from '../security/cipher'
import { Telemetry, type SpanOptions } from '../telemetry/telemetry'
import { Agent } from './agent/agent'
import { ToolApprovals } from './agent/approvals'
import { ConversationStore } from './agent/conversations'
import { JobQueue, openJob, type Job, type SealedJob } from './agent/jobs'
import { ConnectedAccounts } from '../integrations/oauth'
import { readForm } from './slack/blocks'
import { escapeSlack } from './slack/mrkdwn'
import { Chat } from './slack/chat'
import { routeEvent, type SlackMessageEvent } from './slack/events'
import { SETTINGS, SLACK_VERIFIER, SlackAgentModule, type AgentEnv, type SlackAgentOptions } from './module'

// The driving side: Slack events and button clicks over HTTP, the queue, and
// cron. Core's createWorker puts every route behind Cloudflare Access; Slack
// can't sign in, so here the two Slack routes are public and every request
// must be signed by Slack (checked before the body is even parsed). The OAuth
// callback is the one unsigned route: it only works with a one-time state that
// an admin asked for in the last 10 minutes. Nothing else answers.

const MAX_BODY = 1024 * 1024
const ok = () => new Response(null, { status: 200 })

const ROUTES = ['/slack/events', '/slack/interactions', '/oauth/callback']
const routeName = (path: string) => (ROUTES.includes(path) ? path : 'unmatched')

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}
const page = (title: string, body: string, status = 200) => new Response(
  `<!doctype html><html lang="en-AU"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px/1.5 system-ui;max-width:32rem;margin:15vh auto;padding:0 16px"><h1>${title}</h1><p>${body}</p></body></html>`,
  { status, headers: PAGE_HEADERS },
)

/** OAuth comes back here. The code is swapped for a token, and the person is told in Slack. */
async function oauthCallback(url: URL, c: Registry): Promise<Response> {
  if (!c.has(ConnectedAccounts)) return new Response('Not found', { status: 404 })
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  if (!state || !code) return page('Not connected', "Nothing was connected. Go back to Slack and ask again if you'd like to.", 400)
  try {
    const done = await c.get(ConnectedAccounts).finish(state, code)
    const who = done.account ? ` as ${escapeSlack(done.account)}` : ''
    await c.get(Chat).post({ channel: done.context.channel, thread: done.context.thread, text: `Connected ${done.provider}${who}, for <@${done.by}>.` })
      .catch(err => c.get(Logger).warn('oauth.notify.failed', { error: err }))
    return page('Connected', 'You can close this tab and go back to Slack.')
  } catch (err) {
    c.get(Logger).warn('oauth.callback.failed', { error: err })
    return page("That link didn't work", 'It may have been used already or run out of time. Ask in Slack for a new one.', 400)
  }
}

/** One invocation in a root span, flushed after the response has gone. */
function traced<T>(c: Registry, ctx: ExecutionContext, name: string, opts: SpanOptions, fn: () => Promise<T>): Promise<T> {
  const t = c.get(Telemetry)
  const p = t.run(() => t.inSpan(name, opts, fn))
  ctx.waitUntil(p.then(() => undefined, () => undefined).then(() => t.flush()))
  return p
}

async function events(raw: string, request: Request, c: Registry): Promise<Response> {
  const body = JSON.parse(raw) as { type?: string; challenge?: string; team_id?: string; event?: SlackMessageEvent; authorizations?: { user_id?: string }[] }
  // Slack checks the URL when it's saved, and won't save it until the challenge comes back.
  if (body.type === 'url_verification') return Response.json({ challenge: body.challenge })
  // Slack retries anything not answered in 3 seconds. The first delivery is already queued.
  if (request.headers.get('x-slack-retry-num')) return ok()
  if (body.type !== 'event_callback' || !body.event) return ok()
  const settings = c.get(SETTINGS)
  if (settings.teamId && body.team_id !== settings.teamId) {
    c.get(Logger).warn('slack.event.dropped', { reason: 'other workspace', team: body.team_id })
    return ok()
  }

  const inbound = await routeEvent(body.event, {
    allowed: settings.allowedUsers,
    botUserId: body.authorizations?.[0]?.user_id,
    known: id => c.get(ConversationStore).has(id),
  })
  if (inbound) await c.get(JobQueue).send({ type: 'message', ...inbound })
  // Not the text: only enough to see why nothing answered.
  else if (body.event.user && !body.event.bot_id && !settings.allowedUsers.includes(body.event.user)) {
    c.get(Logger).warn('slack.event.dropped', { reason: 'not in ALLOWED_USERS', user: body.event.user })
  }
  return ok()
}

interface BlockActions {
  type?: string
  user?: { id?: string }
  team?: { id?: string }
  channel?: { id?: string }
  container?: { channel_id?: string; message_ts?: string }
  actions?: { action_id?: string; value?: string }[]
  state?: { values?: Record<string, Record<string, Record<string, unknown>>> }
}

async function interactions(raw: string, c: Registry): Promise<Response> {
  // Form-encoded, as payload=<json>, not JSON.
  const payload = JSON.parse(new URLSearchParams(raw).get('payload') ?? '{}') as BlockActions
  if (payload.type !== 'block_actions') return ok()
  const settings = c.get(SETTINGS)
  if (settings.teamId && payload.team?.id !== settings.teamId) return ok()
  const action = payload.actions?.[0]
  const user = payload.user?.id
  const channel = payload.channel?.id ?? payload.container?.channel_id
  const messageTs = payload.container?.message_ts
  if (!action?.value || !user || !channel || !messageTs || !settings.allowedUsers.includes(user)) return ok()

  if (action.action_id === 'settings_save' || action.action_id === 'settings_page') {
    const pageNo = Number(action.value)
    if (!Number.isInteger(pageNo) || pageNo < 0 || pageNo > 100) return ok()
    await c.get(JobQueue).send({
      type: 'settings', action: action.action_id === 'settings_save' ? 'save' : 'page', page: pageNo,
      state: payload.state?.values ?? {}, user, channel, messageTs,
    })
    return ok()
  }
  if (action.action_id !== 'tool_yes' && action.action_id !== 'tool_no') return ok()

  await c.get(JobQueue).send({
    type: 'decision', ref: action.value, yes: action.action_id === 'tool_yes',
    values: readForm(payload.state?.values ?? {}), user, channel, messageTs,
  })
  return ok()
}

/** Tells the person something broke, where they'll see it. Never throws. */
async function apologise(c: Registry, job: Job) {
  const text = "Something went wrong there. It's been logged."
  await (job.type === 'message'
    ? c.get(Chat).post({ channel: job.channel, thread: job.thread, text })
    : c.get(Chat).ephemeral({ channel: job.channel, user: job.user, text })
  ).catch(() => {})
}

export function createSlackWorker<E extends AgentEnv>(opts: { module: (env: E) => Module }): ExportedHandler<E, SealedJob> {
  // env is the same object for the life of an isolate, so so is the registry.
  const registries = new WeakMap<object, Registry>()
  const registryFor = (env: E) => {
    let c = registries.get(env)
    if (!c) { c = opts.module(env).build(); registries.set(env, c) }
    return c
  }

  return {
    async fetch(request, env, ctx) {
      const c = registryFor(env)
      const url = new URL(request.url)
      const route = routeName(url.pathname)
      return traced(c, ctx, `${request.method} ${route}`, { kind: 'server', attrs: { 'faas.trigger': 'http', 'http.request.method': request.method, 'http.route': route } }, async () => {
        if (route === '/oauth/callback' && request.method === 'GET') return oauthCallback(url, c)
        if (request.method !== 'POST' || route === 'unmatched' || route === '/oauth/callback') return new Response('Not found', { status: 404 })
        if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return new Response(null, { status: 413 })
        // Verify the bytes Slack signed, not a re-serialised object.
        const raw = await request.text()
        try {
          await c.get(SLACK_VERIFIER).verify(request, raw)
        } catch (err) {
          // Unsigned, stale or a bad signature. A bad one usually means the wrong secret was copied.
          c.get(Logger).warn('slack.request.refused', { route, error: err })
          return new Response(null, { status: 401 })
        }
        try {
          return route === '/slack/events' ? await events(raw, request, c) : await interactions(raw, c)
        } catch (err) {
          c.get(Logger).error('slack.request.failed', { route, error: err })
          // A 200 stops Slack retrying something that will fail the same way.
          return ok()
        }
      })
    },

    async queue(batch, env, ctx) {
      const c = registryFor(env)
      await traced(c, ctx, 'queue jobs', { kind: 'server', attrs: { 'faas.trigger': 'pubsub', 'pf.jobs': batch.messages.length } }, async () => {
        for (const m of batch.messages) {
          let job: Job | undefined
          try {
            job = await openJob(m.body, c.get(Cipher))
            await c.get(Agent).handle(job)
          } catch (err) {
            c.get(Logger).error('job.failed', { type: job?.type ?? 'unopened', error: err })
            if (job) await apologise(c, job)
          }
          // Not retried: a half-done job retried would post twice.
          m.ack()
        }
      })
    },

    async scheduled(controller, env, ctx) {
      const c = registryFor(env)
      await traced(c, ctx, `cron ${controller.cron}`, { kind: 'server', attrs: { 'faas.trigger': 'timer', 'faas.cron': controller.cron } }, async () => {
        const log = c.get(Logger)
        const expired = await c.get(ToolApprovals).expireStale().catch(err => { log.error('approvals.expire.failed', { error: err }); return 0 })
        const before = new Date(c.get(Clock).now().getTime() - 30 * 86_400_000).toISOString()
        const pruned = await c.get(ConversationStore).prune(before).catch(err => { log.error('conversations.prune.failed', { error: err }); return 0 })
        const links = c.has(ConnectedAccounts) ? await c.get(ConnectedAccounts).pruneStates().catch(err => { log.error('oauth.prune.failed', { error: err }); return 0 }) : 0
        log.info('cron.done', { expired, pruned, links })
      })
    },
  }
}

/**
 * A Slack agent Worker. Give it the tool servers that run inside it, and point
 * MCP_SERVERS or MCP_BINDINGS at any that run elsewhere:
 *
 *   export default createSlackAgent({ tools: ({ env, cipher, timeZone }) => [timeTools(timeZone), myTools(env)] })
 *
 * Pass `module` instead to change more than the tools, with a subclass of SlackAgentModule.
 */
export function createSlackAgent<E extends AgentEnv = AgentEnv>(opts: SlackAgentOptions<E> & { module?: (env: E) => Module } = {}): ExportedHandler<E, SealedJob> {
  return createSlackWorker<E>({ module: opts.module ?? (env => new SlackAgentModule<E>(env, opts)) })
}
