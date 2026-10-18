import { FILE_ELEMENTS, MAX_IMAGE_BYTES, fileIds, filesOfKind, type FileRef, type JsonSchema, type JsonSchemaProp, type ListItem, type SlackHint, type SlackInput } from '../tools/contract'
import { escapeSlack } from './mrkdwn'

// Block Kit, drawn from a tool's JSON Schema. One declaration gives the
// approval form, the missing-input form and the result.

export type Block = Record<string, unknown>

export const LIMITS = { blocks: 50, sectionText: 3000, header: 150, fields: 10, buttonValue: 2000, label: 2000, initialText: 3000 } as const

const plain = (text: string, max = 2000) => ({ type: 'plain_text', text: text.slice(0, max) || ' ', emoji: true })
const mrkdwn = (text: string) => ({ type: 'mrkdwn', text: text.slice(0, LIMITS.sectionText) || ' ' })

/** Our own tools always have a hint. A remote server's may not, so guess from the JSON Schema. */
export function hintFor(name: string, prop: JsonSchemaProp): SlackHint {
  if (prop['x-slack']) return prop['x-slack']
  const label = name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
  if (prop.enum) return { element: 'static_select', label }
  if (prop.type === 'boolean') return { element: 'checkboxes', label }
  if (prop.type === 'number' || prop.type === 'integer') return { element: 'number_input', label }
  if (prop.format === 'date') return { element: 'datepicker', label }
  if (prop.format === 'email') return { element: 'email_text_input', label }
  if (prop.format === 'uri') return { element: 'url_text_input', label }
  return { element: 'plain_text_input', label }
}

const option = (v: unknown) => ({ text: plain(String(v), 75), value: String(v).slice(0, 150) })

const kb = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
const fileOption = (f: FileRef) => ({ text: plain(`${f.name} (${kb(f.size)})`, 75), value: f.id })

function element(name: string, prop: JsonSchemaProp, hint: SlackHint, value: unknown, files: FileRef[]): Block {
  const base: Block = { type: hint.element, action_id: name }
  const has = value !== undefined && value !== null && value !== ''
  switch (hint.element) {
    case 'datepicker': return has ? { ...base, initial_date: String(value) } : base
    case 'timepicker': return has ? { ...base, initial_time: String(value).slice(0, 5) } : base
    case 'users_select': return has ? { ...base, initial_user: String(value) } : base
    case 'conversations_select': return has ? { ...base, initial_conversation: String(value) } : base
    case 'static_select': {
      const options = (prop.enum ?? []).slice(0, 100).map(option)
      return { ...base, options, ...(has && prop.enum?.includes(value) ? { initial_option: option(value) } : {}) }
    }
    case 'image_select':
    case 'document_select': {
      // Newest first: the one just attached is usually the one meant.
      const mine = filesOfKind(files, FILE_ELEMENTS[hint.element]!)
      const options = [...mine].reverse().slice(0, 100).map(fileOption)
      const picked = mine.find(f => f.id === value)
      return { type: 'static_select', action_id: name, options, ...(picked ? { initial_option: fileOption(picked) } : {}) }
    }
    case 'images_select': {
      // In the order given, so a carousel keeps its slide order; then the rest, newest first.
      const mine = filesOfKind(files, 'image')
      const picked = fileIds(value).map(id => mine.find(f => f.id === id)).filter((f): f is FileRef => !!f)
      const options = [...picked, ...[...mine].reverse().filter(f => !picked.includes(f))].slice(0, 100).map(fileOption)
      return { type: 'multi_static_select', action_id: name, options, ...(picked.length ? { initial_options: picked.map(fileOption) } : {}) }
    }
    case 'checkboxes': {
      const yes = { text: plain(hint.label, 75), value: 'yes' }
      return { ...base, options: [yes], ...(value === true ? { initial_options: [yes] } : {}) }
    }
    case 'number_input':
      return { ...base, is_decimal_allowed: prop.type !== 'integer', ...(has ? { initial_value: String(value) } : {}) }
    default:
      return { ...base, ...(hint.multiline ? { multiline: true } : {}), ...(has ? { initial_value: String(value).slice(0, LIMITS.initialText) } : {}) }
  }
}

export function inputBlock(name: string, prop: JsonSchemaProp, value: unknown, required: boolean, missing = false, files: FileRef[] = []): Block {
  const hint = hintFor(name, prop)
  // A select needs at least one option, so with nothing attached there's nothing to pick.
  const kind = FILE_ELEMENTS[hint.element as SlackInput]
  if (kind && filesOfKind(files, kind).length === 0) {
    const what = kind === 'image' ? 'an image' : 'a text file (.md, .txt, .csv or .json)'
    return { type: 'section', block_id: name, text: mrkdwn(`*${escapeSlack(hint.label)}*\nAttach ${what} in this conversation, then ask again.`) }
  }
  const help = missing ? 'Needed before this can run.' : prop.description
  return {
    type: 'input',
    block_id: name,
    optional: !required,
    label: plain(hint.label),
    element: element(name, prop, hint, value, files),
    ...(help ? { hint: plain(help) } : {}),
  }
}

export const missingRequired = (schema: JsonSchema, args: Record<string, unknown>) =>
  (schema.required ?? []).filter(k => args[k] === undefined || args[k] === null || args[k] === '')

export interface FormOptions {
  /** What the person sees first, e.g. "*Save a note* wants to run." Already mrkdwn. */
  intro: string
  schema: JsonSchema
  args: Record<string, unknown>
  /** Travels in each button's value and comes back with the click. */
  ref: string
  /** approve: Approve/Deny. missing: Submit/Cancel, empty required fields flagged. question: a tool's follow-up, Answer/Skip. */
  mode: 'approve' | 'missing' | 'question'
  /** Images attached in the conversation, for image fields. */
  files?: FileRef[]
}

/** Every argument the model chose, as an editable field. */
export function toolForm(o: FormOptions): Block[] {
  if (o.ref.length > LIMITS.buttonValue) throw new Error('Button value too long')
  const required = new Set(o.schema.required ?? [])
  const missing = new Set(o.mode === 'question' ? [] : missingRequired(o.schema, o.args))
  const fields = Object.entries(o.schema.properties ?? {})
    .slice(0, LIMITS.blocks - 3)
    .map(([k, p]) => inputBlock(k, p, o.args[k], required.has(k), missing.has(k), o.files))
  const [yes, no] = { approve: ['Approve', 'Deny'], missing: ['Submit', 'Cancel'], question: ['Answer', 'Skip'] }[o.mode]
  return [
    { type: 'section', text: mrkdwn(o.intro) },
    ...fields,
    {
      type: 'actions',
      block_id: 'decision',
      elements: [
        { type: 'button', text: plain(yes), style: 'primary', action_id: 'tool_yes', value: o.ref },
        { type: 'button', text: plain(no), style: 'danger', action_id: 'tool_no', value: o.ref },
      ],
    },
  ]
}

type ElementState = Record<string, unknown> & { type?: string }

/** Each element type puts its value somewhere different. */
export function readValue(v: ElementState): unknown {
  switch (v.type) {
    case 'datepicker': return v.selected_date
    case 'timepicker': return v.selected_time
    case 'datetimepicker': return v.selected_date_time
    case 'static_select': return (v.selected_option as { value?: string } | null)?.value
    case 'multi_static_select': return (v.selected_options as { value: string }[] | undefined)?.map(o => o.value)
    case 'checkboxes': return ((v.selected_options as unknown[] | undefined)?.length ?? 0) > 0
    case 'users_select': return v.selected_user
    case 'conversations_select': return v.selected_conversation
    case 'number_input': return v.value == null || v.value === '' ? undefined : Number(v.value)
    default: return v.value
  }
}

/** `state.values` is `{ [block_id]: { [action_id]: state } }`, and block_id is the field name. */
export function readForm(values: Record<string, Record<string, ElementState>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([field, actions]) => [field, readValue(Object.values(actions)[0] ?? {})] as const)
      .filter(([, v]) => v !== null && v !== undefined && v !== ''),
  )
}

/** Splits text into sections under Slack's 3,000 characters, on line breaks where it can. */
export function textBlocks(text: string): Block[] {
  const chunks: string[] = []
  let rest = text.trim() || ' '
  while (rest.length > 0 && chunks.length < LIMITS.blocks) {
    if (rest.length <= LIMITS.sectionText) { chunks.push(rest); break }
    let cut = rest.lastIndexOf('\n', LIMITS.sectionText)
    if (cut < LIMITS.sectionText / 2) cut = LIMITS.sectionText
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  return chunks.map(c => ({ type: 'section', text: mrkdwn(c) }))
}

const show = (v: unknown) => escapeSlack(typeof v === 'string' ? v : JSON.stringify(v))

const isHttps = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 3000) return false
  try { return new URL(v).protocol === 'https:' } catch { return false }
}
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/
/** A link Slack will show as `label`. Its own characters can't break out of the <...>. */
const link = (url: string, label: string) => `<${url.replace(/[|<>]/g, c => encodeURIComponent(c))}|${escapeSlack(label).replace(/\|/g, '/')}>`

/** An image a tool made, to upload after the result. */
export interface MadeImage { field: string; label: string; mimetype: string; bytes: Uint8Array }

/** Images a tool handed back as data URLs, decoded. Anything malformed or too big is left out. */
export function madeImages(schema: JsonSchema | undefined, content: Record<string, unknown>): MadeImage[] {
  const out: MadeImage[] = []
  for (const [k, v] of Object.entries(content)) {
    const prop = schema?.properties?.[k]
    if (!prop || hintFor(k, prop).element !== 'image' || typeof v !== 'string') continue
    const m = v.match(DATA_IMAGE)
    if (!m) continue
    const bin = atob(m[2])
    if (bin.length > MAX_IMAGE_BYTES) continue
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    out.push({ field: k, label: hintFor(k, prop).label, mimetype: m[1], bytes })
  }
  return out
}

/** What the model reads instead of an image's bytes. */
export function withoutImageData(content: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(content).map(([k, v]) =>
    [k, typeof v === 'string' && v.startsWith('data:image/') ? `[an image, ${kb(Math.floor(v.length * 3 / 4))}, shown to the person in Slack]` : v]))
}

/** An `out.list`: one line per row, the meta in front like a time on a run sheet. */
function listBlocks(label: string, v: unknown): Block[] {
  if (!Array.isArray(v) || v.length === 0) return []
  const rows = v.map(item => {
    const i = item as ListItem
    const first = `• ${i.meta ? `${escapeSlack(i.meta)}  ` : ''}*${escapeSlack(i.title)}*`
    return i.detail ? `${first}\n   ${escapeSlack(i.detail)}` : first
  })
  return textBlocks(`*${escapeSlack(label)}*\n${rows.join('\n')}`)
}

/** A tool's result, laid out from its output hints. Values are escaped: tools return plain text. */
export function resultBlocks(title: string, schema: JsonSchema | undefined, content: Record<string, unknown>): Block[] {
  const blocks: Block[] = [{ type: 'context', elements: [mrkdwn(`✓ ${escapeSlack(title)}`)] }]
  const fields: Block[] = []
  const props = schema?.properties ?? {}
  for (const [k, v] of Object.entries(content)) {
    if (v === undefined || v === null || v === '') continue
    const hint = props[k] ? hintFor(k, props[k]) : { element: 'field' as const, label: k }
    // An image's bytes with no image hint (a server without one) would print as a wall of base64.
    if (hint.element !== 'image' && typeof v === 'string' && v.startsWith('data:')) continue
    if (hint.element === 'header') blocks.push({ type: 'header', text: plain(String(v), LIMITS.header) })
    // An https image Slack fetches itself. One the tool made is uploaded after (madeImages).
    else if (hint.element === 'image') { if (isHttps(v)) blocks.push({ type: 'image', image_url: v, alt_text: hint.label.slice(0, 2000) }) }
    else if (hint.element === 'link') fields.push(mrkdwn(`*${escapeSlack(hint.label)}*\n${isHttps(v) ? link(v, v.replace(/^https:\/\//, '').slice(0, 80)) : show(v)}`))
    else if (hint.element === 'context') blocks.push({ type: 'context', elements: [mrkdwn(show(v))] })
    else if (hint.element === 'list') blocks.push(...listBlocks(hint.label, v))
    else if (hint.element === 'text') blocks.push(...textBlocks(show(v)))
    else fields.push(mrkdwn(`*${escapeSlack(hint.label)}*\n${show(v)}`))
  }
  for (let i = 0; i < fields.length; i += LIMITS.fields) blocks.push({ type: 'section', fields: fields.slice(i, i + LIMITS.fields) })
  return blocks.slice(0, LIMITS.blocks)
}

/** What a form becomes once someone has answered it: no buttons left to press. */
export function decidedBlocks(intro: string, outcome: string, args: Record<string, unknown> = {}): Block[] {
  const shown = Object.entries(args).filter(([, v]) => v !== undefined && v !== '').slice(0, LIMITS.fields)
  return [
    { type: 'section', text: mrkdwn(intro), ...(shown.length ? { fields: shown.map(([k, v]) => mrkdwn(`*${escapeSlack(k)}*\n${show(v)}`)) } : {}) },
    { type: 'context', elements: [mrkdwn(outcome)] },
  ]
}

export const errorBlocks = (title: string, error: string): Block[] =>
  [{ type: 'context', elements: [mrkdwn(`✗ ${escapeSlack(title)}: ${escapeSlack(error)}`)] }]
