import { KvDraftStore, imageTools, socialTools, timeTools, type CardBrand, type Theme, type ToolsContext, type ToolServer } from '#capabilities'

/**
 * The tool servers that run inside this Worker: the social tools, plus time
 * (for "next Tuesday at 9") and images (so it can say what's in a photo).
 *
 * Everything below is an example: a made-up plumbing business, who reads its
 * posts, how it writes, what it posts about, a post in its voice, and its
 * colours for the picture. Swap each one for your own. The drafts are only as
 * good as these.
 */
export const BUSINESS = "Harbour Plumbing, a three-person plumbing business in Sydney's inner west: blocked drains, hot water, leaks and bathroom renovations"

export const AUDIENCE = 'homeowners, renters and property managers nearby. Busy, not technical, wary of tradies who upsell, and quick to scroll past anything that sounds like an ad'

export const VOICE = [
  'Sounds like the plumber who did the job telling a customer about it, not a marketing team.',
  'Australian spelling. Short sentences, contractions, specifics (the suburb, the part, the price) over claims.',
  'Say what was wrong and what we did, including when the fix was cheaper than they feared.',
  'No hashtags unless asked, no emoji, no exclamation marks.',
].join(' ')

export const THEMES: Theme[] = [
  { name: 'Jobs this week', about: 'A job we did: what was wrong, what we found, what we did and roughly what it cost.' },
  { name: 'Before you call us', about: "A check a homeowner can do themselves first, and when it's time to call a plumber." },
  { name: 'What it costs', about: 'Honest prices for a common job, and what makes it cost more or less.' },
  { name: 'The team', about: 'Who we are, the van, the tools, a day on the road.' },
]

/** A post in the business's voice. The model matches how it sounds, never its words or its story. */
export const EXAMPLES = [
  `We pulled a tennis ball out of a stormwater pipe in Leichhardt on Tuesday.

The courtyard had flooded after every storm for three weeks. Another plumber had quoted to dig up the pavers. Our camera found the ball about four metres in.

Twenty minutes with the jetter and it was out. No digging, and about a tenth of the quote.

If your courtyard pools after rain, it's worth getting a camera down the pipe before anyone lifts a paver.`,
]

/** The colours of the picture, as #rrggbb. */
export const BRAND: CardBrand = {
  name: 'Harbour Plumbing', site: 'harbourplumbing.example',
  background: '#FFFFFF', text: '#1B1B1B', muted: '#5C6670', accent: '#E8702A', rule: '#0F4C5C', panel: '#F1EDE6',
}

export const tools = ({ env, cipher, timeZone, vision, writer, images }: ToolsContext): ToolServer[] => [
  timeTools(timeZone),
  imageTools(vision),
  socialTools({ timeZone, writer, images, vision, drafts: new KvDraftStore(env.KV, cipher), brand: BRAND, themes: THEMES, business: BUSINESS, audience: AUDIENCE, voice: VOICE, examples: EXAMPLES }),
]
