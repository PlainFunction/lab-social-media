import { z } from 'zod'
import type { ImageModel } from '../ai/image-model'
import type { LanguageModel } from '../ai/language-model'
import type { VisionModel } from '../ai/vision-model'
import { ValidationError } from '../kernel/errors'
import { LocalToolServer, out, tool, ui, type ToolContext } from '../slack-agent/tools/contract'
import { ResvgCardRenderer, type CardBrand, type CardRenderer } from './card'
import { draftTool, reviseTool, type Theme } from './draft'
import { MemoryDraftStore, type DraftStore } from './drafts'
import { checkPost, type PostTiming, type SocialAccount, type SocialPublisher } from './publisher'
import { ZernioPublisher } from './zernio'

// Instagram tools for the Slack agent. Reading which accounts are connected
// and drafting run without asking. Posting always shows the post as a form
// first, so the words can be changed before anything goes out.

export interface SocialToolsOptions {
  /** The team's time zone, for scheduled posts. Read on every call, since it can change in Slack settings. */
  timeZone: string | (() => Promise<string>)
  /** The credential holding the Zernio API key. Default `zernio`. */
  credential?: string
  /** House rules for the words. Return what's wrong and the post is refused before anything goes. */
  check?: (text: string) => string | undefined
  /** Who posts. Default Zernio through `ctx.fetch`. Tests pass a MemorySocialPublisher. */
  publisher?: (ctx: ToolContext) => SocialPublisher

  /** With a writer there's a `draft` tool: a caption around one of `themes`, and a picture. */
  writer?: LanguageModel
  /** For illustrations on the picture. */
  images?: ImageModel
  /** Looks at an attached photo, so a draft can be written around it. */
  vision?: VisionModel
  /** The business's colours and name, for the picture. Needed with `writer`. */
  brand?: CardBrand
  /** Draws the picture. Default resvg with `brand`. */
  cards?: CardRenderer
  /** What the business posts about, again and again. The draft form offers these. */
  themes?: Theme[]
  /** Who the business is, in a sentence. */
  business?: string
  /** Who reads its posts, in a sentence. */
  audience?: string
  /** How the business writes, for drafting. A few sentences. */
  voice?: string
  /** A post or two in the business's voice, for drafting. */
  examples?: string[]
  /** How illustrations should look. */
  illustrationStyle?: string
  /** Where drafts are kept so feedback can change them: a KvDraftStore in a Worker. Default in memory. */
  drafts?: DraftStore
}

const WHEN = ['Now', 'Scheduled', 'Draft'] as const
/** Instagram's carousel limit, through the publishing API Zernio uses. */
const MAX_IMAGES = 10

/** YYYY-MM-DDTHH:mm for `at` in a time zone. */
export const localDateTime = (at: Date, timeZone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

export function socialTools(o: SocialToolsOptions) {
  const tz = () => (typeof o.timeZone === 'string' ? Promise.resolve(o.timeZone) : o.timeZone())
  const credential = o.credential ?? 'zernio'
  const publisherFor = o.publisher ?? ((ctx: ToolContext) => new ZernioPublisher((url, init) => ctx.fetch(url, { ...init, credential })))
  const cards = o.cards ?? (o.brand ? new ResvgCardRenderer(o.brand) : undefined)
  if (o.writer && !cards) throw new ValidationError('Drafting needs a brand (or a card renderer) for the picture')

  return new LocalToolServer('social', {
    accounts: tool({
      title: 'Instagram accounts',
      description: 'The Instagram accounts it can post to',
      input: z.object({}),
      output: z.object({ header: out.header('Accounts'), accounts: out.text('Accounts') }),
      annotations: { readOnlyHint: true },
      run: async (_input, ctx) => {
        const accounts = await publisherFor(ctx).accounts()
        return { header: 'Instagram accounts', accounts: accounts.map(a => `• ${a.name}`).join('\n') || 'None connected yet. Connect Instagram in Zernio first.' }
      },
    }),
    ...(o.writer && cards ? (() => {
      // One store for both, so feedback finds the draft it's about.
      const options = {
        writer: o.writer, cards, images: o.images, vision: o.vision, themes: o.themes, business: o.business, audience: o.audience,
        voice: o.voice, examples: o.examples, illustrationStyle: o.illustrationStyle, check: o.check, drafts: o.drafts ?? new MemoryDraftStore(),
      }
      return { draft: draftTool(options), revise: reviseTool(options) }
    })() : {}),
    post: tool({
      title: 'Instagram post',
      description: [
        'Posts to Instagram, now, at a set time, or as a draft to finish later.',
        'Instagram needs a picture: pass images, the ids of pictures attached or made in this conversation, in order (several make a carousel, up to 10), or a link to one. Captions take up to 2,200 characters and can\'t have links; a link goes in first_comment.',
        'Set ai_label when a picture has an AI-made illustration in it. They can change anything in the form before it goes.',
      ].join(' '),
      input: z.object({
        caption: ui.text('Caption', { description: 'The words of the post', multiline: true }),
        images: ui.images('Pictures', { description: 'One, or several in order for a carousel', max: MAX_IMAGES }).optional(),
        image_url: ui.url('Picture link', { description: 'Or a public link to a JPEG or PNG' }).optional(),
        first_comment: ui.text('First comment', { description: 'Posted straight after, as the first comment. Where a link goes' }).optional(),
        ai_label: ui.checkbox('Label as AI-made', { description: 'Instagram\'s "AI info" label, for a picture with an AI-made illustration' }).optional(),
        when: ui.select('When', WHEN, { description: 'Draft saves it in Zernio without posting' }),
        date: ui.date('Date', { description: 'For a scheduled post, as YYYY-MM-DD' }).optional(),
        time: ui.time('Time', { description: 'For a scheduled post, as HH:mm, where the team is' }).optional(),
      }),
      output: z.object({
        header: out.header('Post'),
        outcome: out.field('Outcome'),
        link: out.link('On Instagram').optional(),
        problem: out.text('What went wrong').optional(),
      }),
      run: async (input, ctx) => {
        if (input.images?.length && input.image_url) throw new ValidationError('Use the pictures or the link, not both')
        const problem = o.check?.(input.caption)
        if (problem) throw new ValidationError(problem)
        // Without the bytes the types aren't known yet; they're checked again once read.
        checkPost({ caption: input.caption, hasImage: !!(input.images?.length || input.image_url) })

        const timeZone = await tz()
        let when: PostTiming = { kind: input.when === 'Now' ? 'now' : 'draft' }
        if (input.when === 'Scheduled') {
          if (!input.date || !input.time) throw new ValidationError('A scheduled post needs a date and a time')
          const at = `${input.date}T${input.time.slice(0, 5)}`
          if (at <= localDateTime(ctx.now, timeZone)) throw new ValidationError(`${input.date} at ${input.time.slice(0, 5)} has already passed where the team is (${timeZone})`)
          when = { kind: 'scheduled', at, timeZone }
        }

        const publisher = publisherFor(ctx)
        const connected = await publisher.accounts()
        if (connected.length === 0) throw new ValidationError('No Instagram account is connected. Connect one in Zernio first')
        const accountId = connected.length === 1 ? connected[0].id : await pick(ctx, connected)

        // Nothing leaves before the last question, so a replayed call never uploads or posts twice.
        const images = input.image_url ? [input.image_url] : []
        // Every picture is read and checked before any is uploaded, so a bad one doesn't leave half a carousel behind.
        const files = await Promise.all((input.images ?? []).map(id => ctx.file(id)))
        for (const file of files) checkPost({ caption: input.caption, hasImage: true, imageType: file.mimetype })
        for (const file of files) images.push(await publisher.upload({ name: file.name, mimetype: file.mimetype, bytes: file.bytes }))
        const made = await publisher.publish({ caption: input.caption, accountId, images, when, firstComment: input.first_comment, aiLabel: input.ai_label })

        return {
          header: HEADERS[made.status] ?? `Post ${made.status}`,
          outcome: outcome(made.status, when),
          link: made.url,
          problem: made.error ?? (made.status === 'failed' ? 'Instagram refused it' : undefined),
        }
      },
    }),
  }, {
    use: "Drafting and posting to the business's Instagram",
    personalInfo: ['whatever the post says or shows'],
    storesIn: 'Zernio, and Instagram',
  })
}

/** Which account, when more than one Instagram account is connected. */
async function pick(ctx: ToolContext, accounts: SocialAccount[]) {
  const labels = accounts.map((a, i) => accounts.slice(0, i).some(b => b.name === a.name) ? `${a.name} #${i + 1}` : a.name)
  const answer = await ctx.elicit(
    `There are ${accounts.length} Instagram accounts. Which one should this go to?`,
    z.object({ account: ui.select('Account', labels as [string, ...string[]]) }),
  )
  if (answer.action !== 'accept') throw new ValidationError('Not posted')
  return accounts[labels.indexOf(answer.content.account)].id
}

const HEADERS: Record<string, string> = {
  published: 'Posted',
  publishing: 'Posting',
  scheduled: 'Scheduled',
  draft: 'Saved as a draft',
  failed: 'Not posted',
}

function outcome(status: string, when: PostTiming) {
  if (status === 'scheduled' && when.kind === 'scheduled') return `Going to Instagram on ${when.at.replace('T', ' at ')} (${when.timeZone})`
  if (status === 'draft') return 'Saved in Zernio, not posted'
  if (status === 'published') return 'On Instagram now'
  if (status === 'publishing') return 'On its way to Instagram'
  return "Instagram didn't take it"
}
