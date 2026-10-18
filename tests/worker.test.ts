import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { AesGcmCipher, ScriptedImageModel, ScriptedLanguageModel, ScriptedVisionModel, SlackWebhookVerifier, b64url, randomBytes, type AgentEnv } from '#capabilities'
import worker from '../src/worker'
import { THEMES, tools } from '../src/tools'

// The agent and the social tools are tested with our capabilities. These check
// this Worker's own part: that it starts with this config and has these tools.

const SECRET = 'slack-signing-secret-for-tests'
const keyring = () => JSON.stringify({ current: 'k1', keys: { k1: b64url(randomBytes(32)) } })
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext

const labEnv = (): AgentEnv => ({
  AI: {} as Ai, DB: env.DB, KV: env.KV, JOBS: {} as Queue,
  ALLOWED_USERS: 'UOWNER1', ADMIN_USERS: 'UOWNER1', SLACK_TEAM_ID: 'T0TEAM001', TIME_ZONE: 'Australia/Sydney',
  SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: 'xoxb-test', KEYRING: keyring(), SIGNING_KEY: 's'.repeat(32),
  CREDENTIAL_HOSTS: '{"zernio":{"hosts":["zernio.com"],"uploads":["*.r2.cloudflarestorage.com"]}}',
})

async function signed(body: string) {
  const ts = Math.floor(Date.now() / 1000)
  return new Request('https://agent.example/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': await SlackWebhookVerifier.signature(SECRET, ts, body) },
    body,
  })
}

describe('this Worker', () => {
  it("starts with this config and answers Slack's URL check", async () => {
    const res = await worker.fetch!(await signed('{"type":"url_verification","challenge":"abc"}') as never, labEnv(), ctx)
    expect(await res.json()).toEqual({ challenge: 'abc' })
    const unsigned = await worker.fetch!(new Request('https://agent.example/slack/events', { method: 'POST', body: '{}' }) as never, labEnv(), ctx)
    expect(unsigned.status).toBe(401)
  })

  it('has the time, image and social tools, drafts around its themes, and asks before posting', async () => {
    const cipher = new AesGcmCipher(JSON.parse(keyring()))
    const servers = tools({ env: labEnv(), cipher, timeZone: async () => 'Australia/Sydney', vision: new ScriptedVisionModel('x'), images: new ScriptedImageModel(), model: new ScriptedLanguageModel('{}'), writer: new ScriptedLanguageModel('{}'), registry: {} as never })
    const specs = (await Promise.all(servers.map(async s => (await s.list()).map(t => ({ ...t, name: `${s.name}__${t.name}` }))))).flat()
    expect(specs.map(t => t.name)).toEqual(['time__now', 'time__days_until', 'images__describe', 'social__accounts', 'social__draft', 'social__revise', 'social__post'])
    expect(specs.find(t => t.name === 'social__draft')?.inputSchema.properties?.theme?.enum).toEqual(THEMES.map(t => t.name))
    const post = specs.find(t => t.name === 'social__post')!
    expect(post.annotations?.readOnlyHint).toBeUndefined()
    expect(post.description).toContain("ai_label")
  })
})
