import { describe, expect, it } from 'vitest'
import {
  CredentialBroker, FixedClock, MemoryAuditLog, MemorySecretStore, MemorySocialPublisher, ScriptedImageModel, ScriptedLanguageModel, ZERNIO_UPLOAD_HOSTS, socialTools,
  type CallContext, type FileData,
} from '#capabilities'
import { BRAND } from '../src/tools'

// The social tools with a fake Zernio behind the real credential broker, so
// this repo shows on its own what reaches Zernio and what doesn't.

const NOW = '2026-10-17T00:00:00Z' // 11am in Sydney
const PNG: FileData = { id: 'F0IMAGE01', name: 'card.png', mimetype: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }
const LAB: FileData = { id: 'F0TEXT001', name: 'lab.md', mimetype: 'text/markdown', bytes: new TextEncoder().encode('# A lab\n\nIt needed four extra settings.') }

function fakeZernio() {
  const calls: Request[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push(req.clone())
    const url = new URL(req.url)
    if (url.hostname.endsWith('.r2.cloudflarestorage.com')) return new Response(null, { status: 200 })
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [{ _id: 'ig-1', platform: 'instagram', username: 'example.co', isActive: true }] })
    if (url.pathname === '/api/v1/media/presign') return Response.json({ uploadUrl: 'https://bucket.r2.cloudflarestorage.com/temp/card.png?X-Amz-Signature=sig', publicUrl: 'https://media.zernio.com/temp/card.png' })
    if (url.pathname === '/api/v1/posts') return Response.json({ post: { _id: 'p-1', status: 'published', platforms: [{ platform: 'instagram', status: 'published', platformPostUrl: 'https://www.instagram.com/p/1' }] } }, { status: 201 })
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  return { fetch, calls }
}

const ctx = (o: Partial<CallContext> = {}): CallContext => ({
  user: 'UOWNER1', now: new Date(NOW), fetch: async () => { throw new Error('no network') },
  file: async id => (id === LAB.id ? LAB : PNG), ...o,
})

describe('social tools', () => {
  it('posts an attached picture to Instagram, with the key going only to Zernio', async () => {
    const z = fakeZernio()
    const broker = new CredentialBroker({
      secrets: new MemorySecretStore({ CREDENTIAL_ZERNIO: 'sk_test' }),
      hosts: { zernio: { hosts: ['zernio.com'], uploads: ZERNIO_UPLOAD_HOSTS } },
      audit: new MemoryAuditLog(new FixedClock(NOW)), fetch: z.fetch,
    })
    const r = await socialTools({ timeZone: 'Australia/Sydney' }).call('post',
      { caption: 'Our blog needed four extra settings.', images: [PNG.id], ai_label: true, when: 'Now' },
      ctx({ fetch: (url, init) => broker.fetch(url, init, { tool: 'social__post' }) }))
    expect(r).toEqual({ ok: true, content: { header: 'Posted', outcome: 'On Instagram now', link: 'https://www.instagram.com/p/1' } })
    expect(z.calls.map(c => [c.method, new URL(c.url).hostname, c.headers.get('authorization')])).toEqual([
      ['GET', 'zernio.com', 'Bearer sk_test'],
      ['POST', 'zernio.com', 'Bearer sk_test'],
      ['PUT', 'bucket.r2.cloudflarestorage.com', null],
      ['POST', 'zernio.com', 'Bearer sk_test'],
    ])
  })

  it('drafts from an attached write-up, checks it, and draws the carousel, without posting anything', async () => {
    const caption = 'Our blog needed four extra settings before we moved it.'
    const slides = [
      { kind: 'point', title: 'It started somewhere separate', body: 'It needed four extra settings.' },
      { kind: 'point', title: 'Now it sits with the site', body: 'Moving it in got rid of them.' },
    ]
    const replies = [
      JSON.stringify({ facts: ['four extra settings'], caption, headline: 'Four extra settings, gone.', slides, close: { headline: 'Four settings fewer' }, scene: 'A juggler dropping four spanners' }),
      JSON.stringify({ problems: [], caption, headline: 'Four extra settings, gone.' }),
    ]
    const writer = new ScriptedLanguageModel(() => replies.shift()!)
    const images = new ScriptedImageModel()
    const pub = new MemorySocialPublisher([])
    const server = socialTools({ timeZone: 'Australia/Sydney', writer, images, brand: BRAND, themes: [{ name: 'Labs', about: 'An experiment.' }], publisher: () => pub })
    const r = await server.call('draft', { theme: 'Labs', request: 'Focus on the four settings', source: LAB.id }, ctx())
    // A carousel by default: the cover, the two points and the close, with no AI picture.
    expect(r).toMatchObject({ ok: true, content: { header: 'Draft for Instagram: 4 slides', caption, image: expect.stringMatching(/^data:image\/png;base64,/), slide_4: expect.stringMatching(/^data:image\/png;base64,/) } })
    expect(writer.requests[0].messages[1].content).toContain('It needed four extra settings.')
    expect(images.requests).toHaveLength(0)
    expect(pub.posts).toHaveLength(0)
  })

  it("refuses what Instagram would, before anything goes", async () => {
    const pub = new MemorySocialPublisher([{ id: 'ig-1', name: 'example.co' }])
    const server = socialTools({ timeZone: 'Australia/Sydney', publisher: () => pub })
    expect(await server.call('post', { caption: 'No picture', when: 'Now' }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining('need a picture') })
    expect(await server.call('post', { caption: 'x'.repeat(2300), image_url: 'https://example.com/card.jpg', when: 'Now' }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining('2,200') })
    expect(await server.call('post', { caption: 'Too late', image_url: 'https://example.com/card.jpg', when: 'Scheduled', date: '2026-10-17', time: '10:00' }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining('already passed') })
    expect(pub.posts).toHaveLength(0)
  })
})
