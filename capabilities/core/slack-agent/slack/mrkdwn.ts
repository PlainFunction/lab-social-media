// Models write Markdown; Slack has its own format (mrkdwn). Text is escaped
// first, so nothing a model or a tool writes can fake a link, a mention or
// an @channel. Only the links we build from Markdown come out as links.

/** Slack reads <...> as links and mentions, and & starts an entity. */
export const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * What someone typed, as plain text for the model. Slack sends links as
 * `<https://x.example|x.example>`, channels as `<#C123|general>` and escapes
 * `&`, `<` and `>`. User mentions stay as `<@U123>`, because tools take user ids.
 */
export function fromSlackText(text: string): string {
  return text
    .replace(/<((?:https?|mailto):[^|>\s]+)(?:\|([^>]*))?>/g, (_m, url: string, label?: string) => {
      const bare = url.replace(/^mailto:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '')
      if (!label || label === bare || label === url || label === url.replace(/^mailto:/, '')) return url.replace(/^mailto:/, '')
      return `${label} (${url})`
    })
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => name ? `#${name}` : `<#${id}>`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

const BOLD = '\u0001'

function inline(line: string): string {
  // Links first, while the URL is still intact. Only http(s), so no `javascript:` or `slack://`.
  let s = line.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => `<${url.replace(/\|/g, '%7C')}|${text.replace(/\|/g, '/')}>`)
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a?: string, b?: string) => `${BOLD}${a ?? b}${BOLD}`)
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1_$2_')
  s = s.replace(/~~(.+?)~~/g, '~$1~')
  return s.replaceAll(BOLD, '*')
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)

export function toMrkdwn(markdown: string): string {
  const lines = escapeSlack(markdown.replace(/\r\n/g, '\n')).split('\n')
  const outLines: string[] = []
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      outLines.push('```')
      continue
    }
    if (fenced) { outLines.push(line); continue }

    // Slack has no tables, so a table becomes a code block, minus the |---| row.
    if (isTableRow(line)) {
      const rows: string[] = []
      while (i < lines.length && isTableRow(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim())
        i++
      }
      i--
      outLines.push('```', ...rows, '```')
      continue
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    if (heading) { outLines.push(`*${heading[1].replace(/\*\*/g, '')}*`); continue }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (bullet) { outLines.push(`${bullet[1]}• ${inline(bullet[2])}`); continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { outLines.push('───'); continue }
    outLines.push(inline(line))
  }
  if (fenced) outLines.push('```')
  return outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
