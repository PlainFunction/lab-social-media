// Instagram for the Slack agent: drafts a caption and a picture around the
// business's themes, and posts through Zernio once someone approves it in a
// form. See README.spec.md.
//
//   import { socialTools } from '@plainfunction/capabilities/social'
//   createSlackAgent({ tools: ({ timeZone, writer, images }) => [socialTools({ timeZone, writer, images, brand })] })
//
// Its own entry point, like slack-agent, since it builds on the agent's tool contract.

export { socialTools, localDateTime, type SocialToolsOptions } from './tools'
export { KvDraftStore, MemoryDraftStore, DraftStore, type SavedDraft } from './drafts'
export { draftTool, reviseTool, problemWith, slidesProblem, copiedFrom, FORMATS, MAX_MIDDLE, PICTURES, STOCK, MAX_SOURCE, MAX_CAPTION, DEFAULT_ILLUSTRATION_STYLE, type Theme, type DraftOptions } from './draft'
export {
  CardRenderer, ResvgCardRenderer, cardSvg, slideSvg, slideProblem, slideKeys, SLIDE_LIMITS, MAX_SLIDES, advanceWidths, measure, wrap, CARD_SIZE, ART_SIZE, MAX_HEADLINE, MAX_SUB,
  type Card, type CardArt, type CardBrand, type Slide,
} from './card'
export { ZernioPublisher, ZERNIO_API, ZERNIO_UPLOAD_HOSTS, type ZernioCall } from './zernio'
export {
  SocialPublisher, MemorySocialPublisher, checkPost, CAPTION_LIMIT, HASHTAG_LIMIT, POST_IMAGE_TYPES,
  type SocialAccount, type MediaFile, type NewPost, type PostResult, type PostTiming,
} from './publisher'
