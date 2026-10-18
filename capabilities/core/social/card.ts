import { initWasm, Resvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import { ValidationError } from '../kernel/errors'
import { Port, type Manifest } from '../kernel/port'
import displayFont from './fonts/fraunces-600.bin'
import bodyFont from './fonts/inter-400.bin'
import monoFont from './fonts/jetbrains-mono-500.bin'

// The picture that goes with a post: a card with a real headline, in the
// business's colours, and optionally an illustration or a screenshot inside
// it. Laid out here as SVG, then drawn to a PNG with resvg (WebAssembly), so
// the words are set in real type, never drawn by an image model.

/** Instagram's tallest feed shape, 4:5. It takes the most room in the feed. */
export const CARD_SIZE = { width: 1080, height: 1350 } as const
/** The size to ask an image model for, to fill the picture panel without much cropping. */
export const ART_SIZE = { width: 1024, height: 768 } as const

/** Colours as #rrggbb. The fonts are fixed: Fraunces for headlines, Inter for text, JetBrains Mono for labels. */
export interface CardBrand {
  /** Shown at the bottom of every card. */
  name: string
  /** Shown bottom right, like "example.com.au". */
  site?: string
  background: string
  text: string
  muted: string
  /** The small label above the headline. */
  accent: string
  /** Rules and the window frame round a screenshot. */
  rule: string
  /** Behind an illustration, where it doesn't reach the edges. */
  panel: string
}

export interface CardArt {
  bytes: Uint8Array
  mimetype: 'image/png' | 'image/jpeg'
  /** An illustration fills a rounded panel; a screenshot sits in a window frame. */
  frame: 'panel' | 'window'
}

export interface Card {
  /** A few words above the headline, like the theme. */
  label?: string
  /** The point of the post, in real words. Up to 120 characters. */
  headline: string
  /** A line under the headline, on cards with no picture. Up to 200 characters. */
  sub?: string
  art?: CardArt
}

export const MAX_HEADLINE = 120
export const MAX_SUB = 200

export abstract class CardRenderer extends Port {
  /** A PNG of the card. */
  abstract render(card: Card): Promise<Uint8Array>
  /** A PNG per slide, in order, each with its page count. With `which`, only those slides (by index) are drawn. */
  abstract renderSlides(slides: Slide[], which?: number[]): Promise<(Uint8Array | undefined)[]>
}

// --- Measuring text: advance widths straight from the fonts' own tables ---

type Font = 'display' | 'body' | 'mono'
const FONT_FILES: Record<Font, ArrayBuffer> = { display: displayFont, body: bodyFont, mono: monoFont }
const FAMILIES: Record<Font, string> = { display: 'Fraunces', body: 'Inter', mono: 'JetBrains Mono' }

/** Each character's width in em, read from a TrueType font's cmap, hmtx, hhea and head tables. */
export function advanceWidths(font: ArrayBuffer | Uint8Array): (ch: string) => number {
  const v = font instanceof Uint8Array ? new DataView(font.buffer, font.byteOffset, font.byteLength) : new DataView(font)
  const tables = new Map<string, number>()
  for (let i = 0, n = v.getUint16(4); i < n; i++) {
    const at = 12 + i * 16
    tables.set(String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3)), v.getUint32(at + 8))
  }
  const need = (t: string) => { const at = tables.get(t); if (at === undefined) throw new ValidationError(`The font has no ${t} table`); return at }
  const unitsPerEm = v.getUint16(need('head') + 18)
  const metrics = v.getUint16(need('hhea') + 34)
  const hmtx = need('hmtx')
  const advance = (glyph: number) => v.getUint16(hmtx + Math.min(glyph, metrics - 1) * 4) / unitsPerEm

  // Format 4 (the usual one for Latin) or 12; whichever the font has for Unicode.
  const cmap = need('cmap')
  let glyphOf: (code: number) => number = () => 0
  for (let i = 0, n = v.getUint16(cmap + 2); i < n; i++) {
    const platform = v.getUint16(cmap + 4 + i * 8), encoding = v.getUint16(cmap + 6 + i * 8)
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue
    const sub = cmap + v.getUint32(cmap + 8 + i * 8)
    const format = v.getUint16(sub)
    if (format === 4) {
      const segs = v.getUint16(sub + 6) / 2
      const ends = sub + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, offsets = deltas + segs * 2
      glyphOf = code => {
        for (let s = 0; s < segs; s++) {
          if (code > v.getUint16(ends + s * 2)) continue
          const start = v.getUint16(starts + s * 2)
          if (code < start) return 0
          const offset = v.getUint16(offsets + s * 2)
          if (!offset) return (code + v.getInt16(deltas + s * 2)) & 0xffff
          const g = v.getUint16(offsets + s * 2 + offset + (code - start) * 2)
          return g ? (g + v.getInt16(deltas + s * 2)) & 0xffff : 0
        }
        return 0
      }
      break
    }
    if (format === 12) {
      const groups = v.getUint32(sub + 12)
      glyphOf = code => {
        for (let g = 0; g < groups; g++) {
          const at = sub + 16 + g * 12, start = v.getUint32(at), end = v.getUint32(at + 4)
          if (code >= start && code <= end) return v.getUint32(at + 8) + code - start
        }
        return 0
      }
      break
    }
  }
  const cache = new Map<string, number>()
  return ch => {
    let w = cache.get(ch)
    if (w === undefined) {
      const glyph = glyphOf(ch.codePointAt(0) ?? 0)
      // A character the font doesn't have is drawn with a fallback; count it as wide, to be safe.
      w = glyph ? advance(glyph) : 0.6
      cache.set(ch, w)
    }
    return w
  }
}

let widthsOf: Record<Font, (ch: string) => number> | undefined
const widths = () => (widthsOf ??= {
  display: advanceWidths(FONT_FILES.display),
  body: advanceWidths(FONT_FILES.body),
  mono: advanceWidths(FONT_FILES.mono),
})

export const measure = (font: Font, size: number, text: string) => [...text].reduce((w, ch) => w + widths()[font](ch) * size, 0)

/** Breaks text into lines no wider than `max`, at spaces. A word wider than a line gets a line of its own. */
export function wrap(font: Font, size: number, text: string, max: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.trim().split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (line && measure(font, size, next) > max) { lines.push(line); line = word } else line = next
  }
  if (line) lines.push(line)
  return lines
}

/** The biggest size, in steps of 4 down to `min`, at which the text fits in `maxLines`. */
function fit(font: Font, text: string, width: number, maxLines: number, from: number, min: number) {
  for (let size = from; size >= min; size -= 4) {
    const lines = wrap(font, size, text, width)
    if (lines.length <= maxLines) return { size, lines }
  }
  return { size: min, lines: wrap(font, min, text, width) }
}

// --- Layout ---

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const HEX = /^#[0-9a-f]{6}$/i

const toBase64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** The card as SVG. Exported so tests can check the layout without drawing it. */
export function cardSvg(card: Card, brand: CardBrand): string {
  const headline = card.headline.trim()
  if (!headline) throw new ValidationError('A card needs a headline')
  if (headline.length > MAX_HEADLINE) throw new ValidationError(`A card headline takes up to ${MAX_HEADLINE} characters, and this is ${headline.length}`)
  if (card.sub && card.sub.length > MAX_SUB) throw new ValidationError(`The line under a card headline takes up to ${MAX_SUB} characters`)
  for (const [k, c] of Object.entries(brand)) if (k !== 'name' && k !== 'site' && !HEX.test(c)) throw new ValidationError(`The brand's ${k} colour should look like #0f4c5c`)

  const { width: W, height: H } = CARD_SIZE
  const pad = 88
  const max = W - pad * 2
  const text = (font: Font, size: number, x: number, y: number, fill: string, s: string, extra = '') =>
    `<text x="${x}" y="${y.toFixed(1)}" font-family="${FAMILIES[font]}" font-size="${size}" fill="${fill}"${extra}>${esc(s)}</text>`

  const parts = [`<rect width="${W}" height="${H}" fill="${brand.background}"/>`]
  let y = pad
  if (card.label) {
    parts.push(text('mono', 28, pad, y + 28, brand.accent, card.label.toUpperCase().slice(0, 40), ' letter-spacing="3"'))
    y += 28 + 44
  }
  const footer = H - pad
  parts.push(`<line x1="${pad}" y1="${footer - 64}" x2="${W - pad}" y2="${footer - 64}" stroke="${brand.rule}" stroke-opacity="0.25" stroke-width="2"/>`)
  parts.push(text('display', 38, pad, footer, brand.text, brand.name.slice(0, 40)))
  if (brand.site) parts.push(text('mono', 25, W - pad, footer, brand.muted, brand.site.slice(0, 40), ' text-anchor="end"'))

  if (!card.art) {
    // Headline only: as big as it'll go, in the middle of the space.
    const head = fit('display', headline, max, 6, 108, 56)
    const sub = card.sub ? wrap('body', 38, card.sub, max) : []
    const lh = head.size * 1.12, subLh = 38 * 1.45
    const block = head.lines.length * lh + (sub.length ? 64 + sub.length * subLh : 0)
    let top = Math.max(y + 40, (footer - 64 + y - block) / 2)
    for (const l of head.lines) { top += lh; parts.push(text('display', head.size, pad, top - lh * 0.22, brand.text, l)) }
    if (sub.length) {
      top += 28
      parts.push(`<rect x="${pad}" y="${top.toFixed(1)}" width="72" height="6" fill="${brand.accent}"/>`)
      top += 30
      for (const l of sub) { top += subLh; parts.push(text('body', 38, pad, top - subLh * 0.3, brand.muted, l)) }
    }
  } else {
    // Headline on top, up to three lines, and the picture filling the rest.
    const head = fit('display', headline, max, 3, 84, 48)
    const lh = head.size * 1.1
    for (const l of head.lines) { y += lh; parts.push(text('display', head.size, pad, y - lh * 0.2, brand.text, l)) }
    const top = y + 40, bottom = footer - 64 - 48, h = bottom - top
    const href = `data:${card.art.mimetype};base64,${toBase64(card.art.bytes)}`
    parts.push(`<defs><clipPath id="art"><rect x="${pad}" y="${top.toFixed(1)}" width="${max}" height="${h.toFixed(1)}" rx="28"/></clipPath></defs>`)
    if (card.art.frame === 'window') {
      parts.push(`<rect x="${pad}" y="${top.toFixed(1)}" width="${max}" height="${h.toFixed(1)}" rx="28" fill="${brand.rule}"/>`)
      for (const [i, c] of [brand.background, brand.accent, brand.panel].entries()) parts.push(`<circle cx="${pad + 40 + i * 30}" cy="${(top + 32).toFixed(1)}" r="9" fill="${c}"/>`)
      parts.push(`<image href="${href}" x="${pad + 16}" y="${(top + 60).toFixed(1)}" width="${max - 32}" height="${(h - 76).toFixed(1)}" preserveAspectRatio="xMidYMin slice" clip-path="url(#art)"/>`)
    } else {
      parts.push(`<rect x="${pad}" y="${top.toFixed(1)}" width="${max}" height="${h.toFixed(1)}" rx="28" fill="${brand.panel}"/>`)
      parts.push(`<image href="${href}" x="${pad}" y="${top.toFixed(1)}" width="${max}" height="${h.toFixed(1)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#art)"/>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}

// --- Carousels ---
//
// Laid out the way the type-led accounts we looked at do it: one idea per
// slide, big type, wide margins, the same grid and footer on every slide, the
// brand's colours as whole backgrounds, and a page count so people know
// there's more. No pictures unless they're the person's own.

export type Slide =
  /** The first slide, the only one most people see: the hook, big. */
  | { kind: 'cover'; label?: string; headline: string; sub?: string }
  /** One idea: a number, a short title, a sentence or two. */
  | { kind: 'point'; number?: string; title: string; body?: string }
  /** A real number, huge, and what it means. */
  | { kind: 'stat'; figure: string; caption: string }
  /** Something someone actually said or wrote, as it was. */
  | { kind: 'quote'; quote: string; by?: string }
  /** The person's photo or screenshot, or an illustration, with a line above it. */
  | { kind: 'image'; art: CardArt; caption?: string }
  /** The last slide: what it comes to, and what to do next. */
  | { kind: 'close'; headline: string; action?: string }

/** Character limits per slide, so the type stays big. Checked before drawing. */
export const SLIDE_LIMITS = { headline: 90, sub: 120, title: 70, body: 170, figure: 10, caption: 110, quote: 150, by: 40, action: 90 } as const
export const MAX_SLIDES = 10

/** What's wrong with a slide's words for its layout, or undefined. */
export function slideProblem(s: Slide): string | undefined {
  for (const [k, v] of Object.entries(s)) {
    const max = SLIDE_LIMITS[k as keyof typeof SLIDE_LIMITS]
    if (max && typeof v === 'string' && v.length > max) return `The ${s.kind} slide's ${k} is ${v.length} characters; it takes ${max}`
  }
  if ((s.kind === 'cover' || s.kind === 'close') && !s.headline.trim()) return `The ${s.kind} slide needs a headline`
  if (s.kind === 'point' && !s.title.trim()) return 'A point slide needs a title'
  if (s.kind === 'stat' && (!s.figure.trim() || !s.caption.trim())) return 'A stat slide needs a figure and a caption'
  if (s.kind === 'quote' && !s.quote.trim()) return 'A quote slide needs the quote'
  return undefined
}

/** A colour part way from `a` to `b`, for muted text on a dark slide. */
const mix = (a: string, b: string, t: number) => {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map(i => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

/**
 * One slide as SVG. `page` is 1-based. `variant` counts the slides of the same
 * kind before this one, so a run of points or stats alternates colours instead
 * of repeating. Exported so tests can check the layout without drawing it.
 */
export function slideSvg(slide: Slide, brand: CardBrand, page: number, total: number, variant = 0): string {
  const problem = slideProblem(slide)
  if (problem) throw new ValidationError(problem)
  for (const [k, c] of Object.entries(brand)) if (k !== 'name' && k !== 'site' && !HEX.test(c)) throw new ValidationError(`The brand's ${k} colour should look like #0f4c5c`)

  const { width: W, height: H } = CARD_SIZE
  const pad = 96, max = W - pad * 2
  const odd = variant % 2 === 1
  // Navy for stats and the close, the accent for every second stat; cream for quotes and every second point.
  const solid = slide.kind === 'stat' ? (odd ? brand.accent : brand.rule) : slide.kind === 'close' ? brand.rule : undefined
  const tint = slide.kind === 'quote' || (slide.kind === 'point' && odd)
  const bg = solid ?? (tint ? brand.panel : brand.background)
  const fg = solid ? '#FFFFFF' : brand.text
  const muted = solid ? mix(solid, '#FFFFFF', solid === brand.accent ? 0.85 : 0.72) : brand.muted
  const accent = solid === brand.accent ? '#FFFFFF' : brand.accent
  const text = (font: Font, size: number, x: number, y: number, fill: string, s: string, extra = '') =>
    `<text x="${x}" y="${y.toFixed(1)}" font-family="${FAMILIES[font]}" font-size="${size}" fill="${fill}"${extra}>${esc(s)}</text>`
  const lines = (font: Font, size: number, x: number, top: number, fill: string, ls: string[], lh: number) =>
    ls.map((l, i) => text(font, size, x, top + size * 0.8 + i * lh, fill, l)).join('')

  const p: string[] = [`<rect width="${W}" height="${H}" fill="${bg}"/>`]
  // The footer, the same on every slide: the business, and where you are in the carousel.
  const foot = H - pad
  p.push(text('display', 34, pad, foot, fg, brand.name.slice(0, 40)))
  if (total > 1) p.push(text('mono', 26, W - pad, foot, muted, `${String(page).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, ' text-anchor="end" letter-spacing="2"'))
  const bottom = foot - 90

  switch (slide.kind) {
    case 'cover': {
      // A big soft circle off the top corner, the hook low and large, and a cue to swipe.
      p.push(`<circle cx="${W - 60}" cy="140" r="330" fill="${brand.panel}"/>`)
      p.push(`<circle cx="${W - 60}" cy="140" r="330" fill="none" stroke="${accent}" stroke-width="3" stroke-opacity="0.35"/>`)
      if (slide.label) {
        p.push(`<rect x="${pad}" y="${pad + 6}" width="18" height="18" fill="${accent}"/>`)
        p.push(text('mono', 28, pad + 34, pad + 24, brand.text, slide.label.toUpperCase().slice(0, 32), ' letter-spacing="3"'))
      }
      const head = fit('display', slide.headline.trim(), max, 5, 128, 72)
      const lh = head.size * 1.06
      const sub = slide.sub ? wrap('body', 40, slide.sub, max) : []
      const block = head.lines.length * lh + (sub.length ? 40 + sub.length * 58 : 0)
      let top = bottom - 70 - block
      p.push(lines('display', head.size, pad, top, fg, head.lines, lh))
      top += head.lines.length * lh
      if (sub.length) p.push(lines('body', 40, pad, top + 40, muted, sub, 58))
      if (total > 1) {
        const y = bottom - 6
        p.push(text('mono', 26, pad, y, accent, 'SWIPE', ' letter-spacing="3"'))
        p.push(`<path d="M ${pad + 112} ${y - 9} h 56 m -16 -14 l 16 14 l -16 14" fill="none" stroke="${accent}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`)
      }
      break
    }
    case 'point': {
      // The number, a rule, the title and the body as one block, a little above the middle.
      const title = fit('display', slide.title.trim(), max, 4, 88, 56)
      const tlh = title.size * 1.1
      const body = slide.body ? wrap('body', 44, slide.body, max).slice(0, 7) : []
      const block = (slide.number ? 200 : 0) + 56 + title.lines.length * tlh + (body.length ? 44 + body.length * 64 : 0)
      let top = Math.max(pad, (pad + bottom - block) / 2 - 40)
      if (slide.number) {
        p.push(text('display', 150, pad - 6, top + 130, accent, slide.number.slice(0, 3)))
        top += 200
      }
      p.push(`<rect x="${pad}" y="${top.toFixed(1)}" width="88" height="6" fill="${fg}"/>`)
      top += 56
      p.push(lines('display', title.size, pad, top, fg, title.lines, tlh))
      top += title.lines.length * tlh + 44
      if (body.length) p.push(lines('body', 44, pad, top, muted, body, 64))
      break
    }
    case 'stat': {
      const fig = fit('display', slide.figure.trim(), max, 1, 300, 120)
      const cap = wrap('body', 46, slide.caption, max - 40).slice(0, 4)
      const block = fig.size * 0.9 + 60 + cap.length * 66
      const top = (pad + bottom - block) / 2
      p.push(text('display', fig.size, pad - 8, top + fig.size * 0.78, fg, fig.lines[0]))
      p.push(`<rect x="${pad}" y="${(top + fig.size * 0.9 + 20).toFixed(1)}" width="88" height="6" fill="${accent}"/>`)
      p.push(lines('body', 46, pad, top + fig.size * 0.9 + 60, muted, cap, 66))
      break
    }
    case 'quote': {
      // The quote mark sits just above the quote, and the two are centred together.
      const q = fit('display', slide.quote.trim(), max, 7, 80, 50)
      const qlh = q.size * 1.18
      const block = 170 + q.lines.length * qlh + (slide.by ? 90 : 0)
      const top = Math.max(pad, (pad + bottom - block) / 2)
      p.push(text('display', 300, pad - 16, top + 230, accent, '“'))
      p.push(lines('display', q.size, pad, top + 170, fg, q.lines, qlh))
      if (slide.by) {
        const y = top + 170 + q.lines.length * qlh + 70
        p.push(`<rect x="${pad}" y="${(y - 12).toFixed(1)}" width="40" height="4" fill="${accent}"/>`)
        p.push(text('mono', 26, pad + 60, y, muted, slide.by.slice(0, 40).toUpperCase(), ' letter-spacing="2"'))
      }
      break
    }
    case 'image': {
      let top = pad
      if (slide.caption) {
        const c = fit('display', slide.caption.trim(), max, 2, 64, 44)
        const clh = c.size * 1.12
        p.push(lines('display', c.size, pad, top, fg, c.lines, clh))
        top += c.lines.length * clh + 48
      }
      const h = bottom - top
      const href = `data:${slide.art.mimetype};base64,${toBase64(slide.art.bytes)}`
      p.push(`<defs><clipPath id="art"><rect x="${pad}" y="${top}" width="${max}" height="${h.toFixed(1)}" rx="24"/></clipPath></defs>`)
      if (slide.art.frame === 'window') {
        p.push(`<rect x="${pad}" y="${top}" width="${max}" height="${h.toFixed(1)}" rx="24" fill="${brand.rule}"/>`)
        for (const [i, c] of [brand.background, accent, brand.panel].entries()) p.push(`<circle cx="${pad + 38 + i * 28}" cy="${top + 30}" r="8" fill="${c}"/>`)
        p.push(`<image href="${href}" x="${pad + 14}" y="${top + 56}" width="${max - 28}" height="${(h - 70).toFixed(1)}" preserveAspectRatio="xMidYMin slice" clip-path="url(#art)"/>`)
      } else {
        p.push(`<rect x="${pad}" y="${top}" width="${max}" height="${h.toFixed(1)}" rx="24" fill="${brand.panel}"/>`)
        p.push(`<image href="${href}" x="${pad}" y="${top}" width="${max}" height="${h.toFixed(1)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#art)"/>`)
      }
      break
    }
    case 'close': {
      const head = fit('display', slide.headline.trim(), max, 5, 100, 60)
      const lh = head.size * 1.1
      const act = slide.action ? wrap('body', 42, slide.action, max).slice(0, 3) : []
      const block = head.lines.length * lh + (act.length ? 70 + act.length * 60 : 0)
      let top = (pad + bottom - block) / 2
      p.push(`<rect x="${pad}" y="${(top - 70).toFixed(1)}" width="88" height="6" fill="${accent}"/>`)
      p.push(lines('display', head.size, pad, top, fg, head.lines, lh))
      top += head.lines.length * lh + 70
      if (act.length) p.push(lines('body', 42, pad, top, muted, act, 60))
      if (brand.site) p.push(text('mono', 28, pad, bottom - 10, accent, brand.site.slice(0, 40), ' letter-spacing="2"'))
      break
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${p.join('')}</svg>`
}

/** How many slides of the same kind come before slide `i`: what alternates its colours. */
const variantOf = (slides: Slide[], i: number) => slides.slice(0, i).filter(x => x.kind === slides[i].kind).length

/**
 * One key per slide, for everything that changes how it's drawn: its words,
 * its picture, where it sits and its colours. Two drafts' slides with the same
 * key look the same, so a revision only redraws the ones whose key changed.
 */
export function slideKeys(slides: Slide[]): string[] {
  return slides.map((s, i) => {
    const art = s.kind === 'image' ? { ...s, art: { mimetype: s.art.mimetype, frame: s.art.frame, size: s.art.bytes.byteLength, head: Array.from(s.art.bytes.subarray(0, 64)).join(',') } } : s
    return JSON.stringify({ slide: art, page: i + 1, of: slides.length, variant: variantOf(slides, i) })
  })
}

let ready: Promise<void> | undefined

/** Draws cards with resvg compiled to WebAssembly, with the fonts bundled in the Worker. No network. */
export class ResvgCardRenderer extends CardRenderer {
  readonly #brand: CardBrand
  constructor(brand: CardBrand) { super(); this.#brand = brand }

  async #draw(svg: string): Promise<Uint8Array> {
    // Once per isolate. A failed start is tried again next time.
    await (ready ??= initWasm(resvgWasm).catch(err => { ready = undefined; throw err }))
    const fontBuffers = Object.values(FONT_FILES).map(f => new Uint8Array(f))
    return new Resvg(svg, { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng()
  }

  render(card: Card): Promise<Uint8Array> {
    return this.#draw(cardSvg(card, this.#brand))
  }

  async renderSlides(slides: Slide[], which?: number[]): Promise<(Uint8Array | undefined)[]> {
    if (slides.length === 0 || slides.length > MAX_SLIDES) throw new ValidationError(`A carousel has 1 to ${MAX_SLIDES} slides`)
    // Every slide is laid out (so a bad one is caught), but only the ones asked for are drawn.
    const svgs = slides.map((s, i) => slideSvg(s, this.#brand, i + 1, slides.length, variantOf(slides, i)))
    const out: (Uint8Array | undefined)[] = []
    for (const [i, svg] of svgs.entries()) out.push(!which || which.includes(i) ? await this.#draw(svg) : undefined)
    return out
  }

  describe(): Manifest {
    return { name: 'Post cards (resvg)', use: 'Drawing the picture for a social post', personalInfo: ['whatever the headline says'], storesIn: 'Not stored' }
  }
}
