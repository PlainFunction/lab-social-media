# Lab 005: Instagram posts from Slack

The code behind our lab [We Let AI Write Our Instagram Posts, Then Read Every One](https://plainfunction.com.au/labs/social-media).
We drop one of our write-ups into Slack, or say what happened, and ask our
Slack agent for an Instagram post. It writes the caption and draws the
picture: a card in our colours with the point of the post on it in real type,
and a drawn illustration or a screenshot inside. When we want it posted, it
shows up as a Slack form: the caption, the picture and when. We fix anything
we don't like and press Approve. Only then does it go to
[Zernio](https://zernio.com), which posts it.

The agent is our `slack-agent` capability and the tools are our `social`
capability. This lab is a Worker that uses both: a config file, and the tools
it has.

```ts
// src/worker.ts
export default createSlackAgent({ tools })

// src/tools.ts
export const tools = ({ timeZone, vision, writer, images }: ToolsContext) => [
  timeTools(timeZone),
  imageTools(vision),
  socialTools({ timeZone, writer, images, brand: BRAND, themes: THEMES, business: BUSINESS, audience: AUDIENCE, voice: VOICE, examples: EXAMPLES }),
]
```

`src/tools.ts` holds an example business (Harbour Plumbing, made up): who it
is, who reads its posts, its voice, themes, an example post and colours. Swap
each for your own: the drafts are only as good as these. Nothing about the
business is built into the prompts, so a café or a clinic works the same way.

```bash
npm install
npm test          # checks the capabilities copy, then this Worker's tests
npm run typecheck
npm run dev       # wrangler dev, with real models on Workers AI
```

## The tools

| Tool | What it does |
|---|---|
| `social__accounts` | Lists the Instagram accounts connected in Zernio. Read-only, so it runs without asking. |
| `social__draft` | Writes a caption around one of the business's themes, following what you asked for word for word, from what happened: a line, a text file attached in Slack (read whole) or a photo you attached (described by a vision model). Draws the picture. Nothing leaves, so it runs without asking. The picture is shared in the thread and kept with the conversation. |
| `social__revise` | Changes a draft from your feedback: only what you ask, the rest kept word for word. Replays the conversation that made the draft, so most of it comes from the model's prompt cache, and only the slides that changed are drawn and posted again. Runs without asking. |
| `social__post` | Posts to Instagram: now, at a date and time, or as a draft in Zernio. Takes pictures attached in Slack or drawn by `social__draft`, in order (several make a carousel), or a link to one, plus an optional first comment (where a link goes) and Instagram's AI label. Always asks first. |

### How a draft is written

The writer is a stronger model than the agent's own (DeepSeek V4 Pro by
default, about 1c a draft). It lists the facts in the brief and source first,
then writes about one moment from them. Then:

- Code checks the caption: Instagram's limits, under 800 characters (longer
  ones were summaries every time we tried), no links in it, none of the stock
  phrases that make people scroll past ("It's not X, it's Y", "Here's the
  thing", emoji), no sentences copied from the example post, and your house
  rules (`check`). A draft that fails goes back once with the reason.
- A second call looks only for made-up facts and stock phrases, with the
  source in front of it. If what it returns breaks a rule, the first version
  stands.

### The pictures

A carousel by default: a cover with the hook, two to six slides the writer
plans (numbered points, a real number shown big, a quote taken word for word),
and a closing slide, each 1080x1350 (Instagram's 4:5) and drawn in the Worker
with resvg and three open source fonts. One idea per slide, big type, the
brand's colours as backgrounds, a page count, and no AI picture unless you ask
for one. Or a single card, on request. On top of that, one of:

- an **illustration**: a caricature-style scene the writer describes, drawn by
  Lucid Origin on Workers AI (about 2.5c). The draft says it's AI-made so the
  post can carry Instagram's label.
- a **photo** you attached, which the post is written around.
- a **screenshot** you attached, in a window frame.
- **the headline alone**, big, with a line under it.

`socialTools` takes:

- `timeZone`: for scheduled posts
- `writer`, `images`, `vision`: from the tools context. With `writer` there's a draft tool, with `images` it can draw illustrations, and with `vision` it can write around a photo
- `brand`: name, site and `#rrggbb` colours for the card. Needed with `writer`
- `themes`: what the business posts about, `{ name, about }`. The draft form offers them
- `business`, `audience`, `voice`, `examples`: who you are, who reads your posts, how you write, and a post or two in your voice
- `illustrationStyle`: how illustrations should look, if not the default caricature style
- `check`: house rules for the words, e.g. `text => text.includes('!') ? 'No exclamation marks' : undefined`
- `credential`: the credential name, default `zernio`
- `publisher`: who posts. Default Zernio; tests pass `MemorySocialPublisher`

## The Zernio key

The key is the `CREDENTIAL_ZERNIO` secret. The tools never see it: they call
`ctx.fetch(url, { credential: 'zernio' })`, and the agent's credential broker
attaches it, only for `zernio.com`.

Pictures are the awkward part. Zernio uploads go in two steps: ask Zernio for
an upload link, then send the bytes to that link, which is presigned
Cloudflare R2 storage. That second request mustn't carry the key, so the
credential lists R2 as an upload host:

```toml
CREDENTIAL_HOSTS = '{"zernio":{"hosts":["zernio.com"],"uploads":["*.r2.cloudflarestorage.com"]}}'
```

The broker sends requests to upload hosts as the tool wrote them, never with
the key, and audits them like any other use.

## AI Gateway

Every model call goes through the AI Gateway called `default`, which
Cloudflare creates on the first request, with prompt logging off. Set
`AI_GATEWAY_ID` to use another. FLUX.2 image models take a multipart stream
that the gateway refuses, so naming one in `AI_IMAGE_MODEL` is refused rather
than sent around the gateway.

## What it uses from capabilities

`capabilities/` holds copies of the parts of our capabilities it uses, so it
runs on its own. `capabilities/index.ts` says which parts, and the copies are kept in step
with ours automatically. **Don't
edit the copies**: they're overwritten from the source on every sync.

- `capabilities/core/social`: the `SocialPublisher` port, `ZernioPublisher`, the card renderer and its fonts, and `socialTools`
- `capabilities/core/slack-agent`: the agent, the tool contract, forms, approvals, the credential broker, the queue and the Worker

Each has a `README.spec.md`. Their own tests stay with the source, so this
copy has a smaller set: this Worker's config and tools, and the social tools
against a fake Zernio behind the real credential broker.

## Setting it up

1. Connect your Instagram (a Business or Creator account) in Zernio, and make
   an API key.
2. Create the Slack app from `slack-manifest.json` (api.slack.com/apps,
   Create New App, From a manifest), with `YOUR-HOST` swapped for your
   Worker's URL. Start the Worker first: Slack checks the events URL when it
   saves. Then install it to the workspace.
3. `wrangler d1 create social-media --location oc`, `wrangler kv namespace create social-media`,
   `wrangler queues create social-media-jobs`, and put the ids in `wrangler.toml`.
4. Apply the schema: `npm run db:local` for `wrangler dev`, `npm run db:remote`
   for the deployed one.
5. Secrets: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `KEYRING`, `SIGNING_KEY`,
   `ALLOWED_USERS`, `ADMIN_USERS`, `SLACK_TEAM_ID` and `CREDENTIAL_ZERNIO`.
   `.dev.vars.example` has the formats. For `wrangler dev`, `npm run dev:secrets`
   writes `.dev.vars` with a new `KEYRING` and `SIGNING_KEY` and blank lines for
   the rest. For the deployed one, `wrangler secret put <NAME> --config wrangler.toml`.

## Tested, and not yet tested

Tested here and with our capabilities: drafting from an attached write-up
(read by its id, whole), the checks and the one rewrite, the checker's fixes
and when they're ignored, the card in all three layouts, the drawn card being
kept so the posting tool can take it (end to end through the agent, approval
form and all), the request shapes Zernio documents (accounts, the two-step
upload, posting now, scheduled and as a draft, first comments and the AI
label), a post Instagram refused (Zernio answers 207 and says why), the key
going to `zernio.com` and never to the upload host, and asking which account
before anything is uploaded.

Run for real: the draft tool with our config against the real writer, image
model and AI Gateway, and posts drafted in Slack, approved in the form and
published to our own Instagram through the deployed agent and Zernio.

Not built yet: Reels and Stories. Zernio's API has them.

## About this repo

This repo is synced automatically from another source, so it's read-only: pull requests and pushes aren't accepted here. If you spot a problem, tell us through [plainfunction.com.au/contact](https://plainfunction.com.au/contact).

Fork it and do what you like with it under the licence below.
