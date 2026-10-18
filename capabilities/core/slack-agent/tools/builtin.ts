import { z } from 'zod'
import { randomId } from '../../kernel/encoding'
import type { VisionModel } from '../../ai/vision-model'
import type { Cipher } from '../../security/cipher'
import { LocalToolServer, out, tool, ui } from './contract'

// The tools we tried it with. Time is read-only, so it runs without asking.
// Notes writes, so saving one shows the approval form first.

/** YYYY-MM-DD for `at` in a time zone. */
export const localDate = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

const dayNumber = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000

const longDate = (isoDate: string) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${isoDate}T00:00:00Z`))

/** `zone` is read on every call, since it can change in Slack settings. */
export function timeTools(zone: string | (() => Promise<string>)) {
  const tz = () => (typeof zone === 'string' ? Promise.resolve(zone) : zone())
  return new LocalToolServer('time', {
    now: tool({
      title: 'Current time',
      description: "The current date and time where the team is",
      input: z.object({}),
      output: z.object({ header: out.header('Today'), time: out.field('Time'), zone: out.context('Time zone') }),
      annotations: { readOnlyHint: true },
      run: async (_input, ctx) => {
        const timeZone = await tz()
        return {
          header: longDate(localDate(ctx.now, timeZone)),
          time: new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit' }).format(ctx.now),
          zone: timeZone,
        }
      },
    }),
    days_until: tool({
      title: 'Days until',
      description: 'How many days and weeks until a date',
      input: z.object({ date: ui.date('Date', { description: 'The date, as YYYY-MM-DD' }) }),
      output: z.object({ header: out.header('Date'), days: out.field('Days'), weeks: out.field('Weeks') }),
      annotations: { readOnlyHint: true },
      run: async ({ date }, ctx) => {
        const days = dayNumber(date) - dayNumber(localDate(ctx.now, await tz()))
        return { header: longDate(date), days: String(days), weeks: String(Math.trunc(days / 7)) }
      },
    }),
  }, { use: 'Dates and times', personalInfo: [], storesIn: 'Nowhere' })
}

interface Note { title: string; body: string; by: string; at: string }

/** Short notes in KV, sealed, so a note can hold anything without it sitting there readable. */
export function noteTools(kv: KVNamespace, cipher: Cipher) {
  const PREFIX = 'note:'

  /** Every note, newest first, with its key. */
  const all = async (limit = 1000) => {
    const { keys } = await kv.list<{ at: string }>({ prefix: PREFIX, limit: 1000 })
    const newest = keys.sort((a, b) => (b.metadata?.at ?? '').localeCompare(a.metadata?.at ?? '')).slice(0, limit)
    const notes = await Promise.all(newest.map(async k => {
      const sealed = await kv.get(k.name)
      return sealed ? { key: k.name, note: await cipher.decryptJson<Note>(sealed, k.name) } : undefined
    }))
    return notes.filter(n => n !== undefined)
  }

  return new LocalToolServer('notes', {
    save: tool({
      title: 'Save a note',
      description: 'Save a short note for the team',
      input: z.object({
        title: ui.text('Title', { description: 'A few words' }),
        body: ui.text('Note', { description: 'The note itself', multiline: true }),
      }),
      output: z.object({ header: out.header('Saved'), title: out.field('Title') }),
      run: async ({ title, body }, ctx) => {
        const id = randomId()
        const note: Note = { title, body, by: ctx.user, at: ctx.now.toISOString() }
        await kv.put(`${PREFIX}${id}`, await cipher.encryptJson(note, `${PREFIX}${id}`), { metadata: { at: note.at } })
        return { header: 'Note saved', title }
      },
    }),
    list: tool({
      title: 'Recent notes',
      description: 'The ten most recent notes, newest first',
      input: z.object({}),
      output: z.object({ header: out.header('Notes'), notes: out.text('Notes') }),
      annotations: { readOnlyHint: true },
      run: async () => {
        // Plain text: results are escaped before they reach Slack, so a note can't @channel anyone.
        const lines = (await all(10)).map(({ note: n }) => `• ${n.title} (${n.at.slice(0, 10)})\n${n.body}`)
        return { header: 'Recent notes', notes: lines.join('\n') || 'No notes yet.' }
      },
    }),
    forget: tool({
      title: 'Forget a note',
      description: 'Delete a note by part of its title. Asks which one when several match',
      input: z.object({ search: ui.text('Title has', { description: "Part of the note's title" }) }),
      output: z.object({ header: out.header('Notes'), outcome: out.field('Outcome') }),
      annotations: { destructiveHint: true },
      run: async ({ search }, ctx) => {
        const matches = (await all()).filter(m => m.note.title.toLowerCase().includes(search.toLowerCase())).slice(0, 100)
        if (matches.length === 0) return { header: 'Nothing forgotten', outcome: `No note has "${search}" in its title.` }

        // Which notes match is only known now, so this can't be one of the tool's inputs.
        const labels = matches.map((m, i) => `${m.note.title} (${m.note.at.slice(0, 10)})${matches.slice(0, i).some(o => o.note.title === m.note.title && o.note.at.slice(0, 10) === m.note.at.slice(0, 10)) ? ` #${i + 1}` : ''}`)
        const answer = await ctx.elicit(
          matches.length === 1 ? 'One note matches. Forget it?' : `${matches.length} notes match. Which one should I forget?`,
          z.object({ note: ui.select('Note', labels as [string, ...string[]]) }),
        )
        if (answer.action !== 'accept') return { header: 'Nothing forgotten', outcome: 'Left as it was.' }

        // The only side effect, after the last question, so replaying never deletes twice.
        const hit = matches[labels.indexOf(answer.content.note)]
        await kv.delete(hit.key)
        return { header: 'Note forgotten', outcome: hit.note.title }
      },
    }),
  }, { use: 'Notes the team asks it to keep', personalInfo: ['whatever people write in a note'], storesIn: 'Cloudflare KV, AES-256-GCM encrypted' })
}

const LOOK = [
  "Describe this image for someone who can't see it, in a few sentences.",
  'Read out any text in it exactly, including numbers, dates and totals.',
  "Say what you can't make out rather than guessing.",
].join(' ')

/**
 * Lets the agent answer "what's this?" about an attached image. The image goes
 * to a vision model only when this runs, and the main model reads the text
 * that comes back. Read-only, so it runs without asking.
 */
export function imageTools(vision: VisionModel) {
  return new LocalToolServer('images', {
    describe: tool({
      title: 'Describe an image',
      description: 'Describes an attached image and reads any text in it. Use it whenever someone asks about an image they attached',
      input: z.object({
        image: ui.image('Image'),
        question: ui.text('Question', { description: 'Anything in particular to look for' }).optional(),
      }),
      output: z.object({ description: out.text('What it shows') }),
      annotations: { readOnlyHint: true },
      run: async ({ image, question }, ctx) => {
        const f = await ctx.file(image)
        const prompt = question ? `${LOOK} The person asked: ${question}` : LOOK
        const { text } = await vision.look({ image: { bytes: f.bytes, mimetype: f.mimetype }, prompt, feature: 'slack-agent-vision' })
        return { description: text.slice(0, 3000) }
      },
    }),
  }, { use: 'Describing images people attach', personalInfo: ['whatever is in the image'], storesIn: 'Nowhere' })
}
