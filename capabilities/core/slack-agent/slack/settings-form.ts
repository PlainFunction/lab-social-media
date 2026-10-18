import { POLICIES, type AgentSettings, type Policy, type SettingsChanges } from '../agent/settings'
import type { ConnectionInfo } from '../../integrations/oauth'
import { LIMITS, readValue, type Block } from './blocks'
import { escapeSlack } from './mrkdwn'

// The settings form. Slack allows 50 blocks a message, so the general settings
// and the first tools go on page one and the rest of the tools are paged.

export interface ToolRow { fullName: string; label: string; policy: Policy }

export interface SettingsView {
  settings: AgentSettings
  servers: string[]
  tools: ToolRow[]
  connections: ConnectionInfo[]
  page: number
  /** A line at the top, e.g. "Saved." */
  note?: string
}

/** Header, intro, six settings, connections and the buttons leave this many for tools on page one. */
export const FIRST_PAGE_TOOLS = LIMITS.blocks - 12
/** Header, intro and buttons on later pages. */
export const PAGE_TOOLS = LIMITS.blocks - 4

export const pageOf = (tools: ToolRow[], page: number) => {
  const start = page === 0 ? 0 : FIRST_PAGE_TOOLS + (page - 1) * PAGE_TOOLS
  return tools.slice(start, start + (page === 0 ? FIRST_PAGE_TOOLS : PAGE_TOOLS))
}
export const pageCount = (tools: ToolRow[]) =>
  tools.length <= FIRST_PAGE_TOOLS ? 1 : 1 + Math.ceil((tools.length - FIRST_PAGE_TOOLS) / PAGE_TOOLS)

const plain = (text: string, max = 150) => ({ type: 'plain_text', text: text.slice(0, max) || ' ', emoji: true })
const mrkdwn = (text: string) => ({ type: 'mrkdwn', text: text.slice(0, LIMITS.sectionText) || ' ' })
const POLICY_TEXT: Record<Policy, string> = { allow: 'Run without asking', ask: 'Ask first', never: 'Never' }
const policyOption = (p: Policy) => ({ text: plain(POLICY_TEXT[p], 75), value: p })
const yes = (label: string) => ({ text: plain(label, 75), value: 'yes' })

const checkbox = (id: string, label: string, on: boolean, hint?: string): Block => ({
  type: 'input', block_id: id, optional: true, label: plain(label),
  element: { type: 'checkboxes', action_id: id, options: [yes(label)], ...(on ? { initial_options: [yes(label)] } : {}) },
  ...(hint ? { hint: plain(hint) } : {}),
})

export function settingsBlocks(v: SettingsView): Block[] {
  const s = v.settings
  const pages = pageCount(v.tools)
  const blocks: Block[] = [
    { type: 'header', text: plain(pages > 1 ? `Settings (${v.page + 1} of ${pages})` : 'Settings') },
    { type: 'context', elements: [mrkdwn(`${v.note ? `*${escapeSlack(v.note)}* ` : ''}Saved settings apply from the next message. Save before changing page. Slack ids, secrets and limits stay in the Worker's config.`)] },
  ]

  if (v.page === 0) {
    blocks.push(
      checkbox('paused', 'Paused', s.paused, 'Answers nothing but settings while paused.'),
      { type: 'input', block_id: 'time_zone', label: plain('Time zone'), element: { type: 'plain_text_input', action_id: 'time_zone', initial_value: s.timeZone }, hint: plain('Like Australia/Sydney. Used for dates, times and the monthly limit.') },
      { type: 'input', block_id: 'instructions', optional: true, label: plain('Instructions'), element: { type: 'plain_text_input', action_id: 'instructions', multiline: true, max_length: 2000, ...(s.instructions ? { initial_value: s.instructions } : {}) }, hint: plain('Anything it should always know or do.') },
      { type: 'input', block_id: 'cap', label: plain('Monthly AI limit (US$)'), element: { type: 'number_input', action_id: 'cap', is_decimal_allowed: true, min_value: '0', max_value: String(s.maxCapUsd), initial_value: String(s.capUsd) }, hint: plain(`Stops new work at 90%. Up to $${s.maxCapUsd}.`) },
      checkbox('ask_read_only', 'Ask before read-only tools too', s.askForReadOnly),
    )
    if (v.servers.length) {
      const opt = (name: string) => ({ text: plain(name, 75), value: name })
      const on = v.servers.filter(n => !s.disabledServers.includes(n))
      blocks.push({
        type: 'input', block_id: 'servers', optional: true, label: plain('Tool servers on'),
        element: { type: 'checkboxes', action_id: 'servers', options: v.servers.slice(0, 10).map(opt), ...(on.length ? { initial_options: on.slice(0, 10).map(opt) } : {}) },
      })
    }
    const connected = v.connections.length
      ? v.connections.map(c => `${escapeSlack(c.name)}${c.account ? ` as ${escapeSlack(c.account)}` : ''} (<@${c.by.replace(/^slack:/, '')}>, ${c.at.slice(0, 10)})`).join(' · ')
      : 'None. Say `connect <name>` to connect one.'
    blocks.push({ type: 'context', elements: [mrkdwn(`*Connected accounts:* ${connected}`)] })
  }

  for (const t of pageOf(v.tools, v.page)) {
    blocks.push({
      type: 'input', block_id: `tool:${t.fullName}`, label: plain(t.label),
      element: { type: 'static_select', action_id: 'policy', options: POLICIES.map(policyOption), initial_option: policyOption(t.policy) },
    })
  }

  const buttons: Block[] = [{ type: 'button', style: 'primary', text: plain('Save'), action_id: 'settings_save', value: String(v.page) }]
  if (v.page > 0) buttons.push({ type: 'button', text: plain('Back'), action_id: 'settings_page', value: String(v.page - 1) })
  if (v.page + 1 < pages) buttons.push({ type: 'button', text: plain('More tools'), action_id: 'settings_page', value: String(v.page + 1) })
  blocks.push({ type: 'actions', block_id: 'settings', elements: buttons })
  return blocks
}

type State = Record<string, Record<string, Record<string, unknown> & { type?: string }>>
const first = (state: State, id: string) => (state[id] ? Object.values(state[id])[0] : undefined)

/** Reads only the fields that were on the page, so another page's settings are left alone. */
export function readSettings(state: State, servers: string[]): SettingsChanges {
  const out: SettingsChanges = {}
  const get = (id: string) => { const v = first(state, id); return v ? readValue(v) : undefined }
  if (state.paused) out.paused = get('paused') === true
  if (state.ask_read_only) out.askForReadOnly = get('ask_read_only') === true
  if (state.time_zone) out.timeZone = String(get('time_zone') ?? '')
  if (state.instructions) out.instructions = String(get('instructions') ?? '')
  if (state.cap) out.capUsd = Number(get('cap'))
  if (state.servers) {
    const on = ((first(state, 'servers')?.selected_options ?? []) as { value: string }[]).map(o => o.value)
    out.disabledServers = servers.filter(n => !on.includes(n))
  }
  const tools: Record<string, Policy> = {}
  for (const id of Object.keys(state)) {
    if (!id.startsWith('tool:')) continue
    const v = get(id)
    if (typeof v === 'string' && (POLICIES as string[]).includes(v)) tools[id.slice(5)] = v as Policy
  }
  if (Object.keys(tools).length) out.tools = tools
  return out
}
