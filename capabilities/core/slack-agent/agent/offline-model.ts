import { LanguageModel, type Completion, type CompletionRequest } from '../../ai/language-model'
import type { Manifest } from '../../kernel/port'
/**
 * A stand-in for the model, for trying the Slack side for free (AI_MODEL =
 * "offline"). It picks a tool by keyword and labels every reply, so nobody
 * mistakes a transcript for a real answer.
 */
export class OfflineModel extends LanguageModel {
  async complete(req: CompletionRequest): Promise<Completion> {
    const last = req.messages.at(-1)?.content ?? ''
    const reply = (text: string) => JSON.stringify({ action: 'reply', text: `_(offline stand-in)_ ${text}` })
    let text: string

    if (last.startsWith('Tool result')) {
      text = reply(`Here's what the tool said: ${last.slice(last.indexOf(':') + 1).trim().slice(0, 500)}`)
    } else if (last.startsWith('[')) {
      text = reply('Okay.')
    } else {
      // Tool lines in the system prompt look like "- server__tool: description".
      // The tool matching the most words wins, and a word in its name counts double,
      // so "list notes" picks notes__list over notes__save.
      const words = last.toLowerCase().match(/[a-z]{4,}/g) ?? []
      const score = (name: string, about: string) => words.reduce((n, w) => n + (name.includes(w) ? 2 : about.includes(w) ? 1 : 0), 0)
      const hit = [...(req.messages[0]?.content ?? '').matchAll(/^- (\w+__\w+): (.*)$/gm)]
        .map(m => ({ name: m[1], score: score(m[1].toLowerCase(), m[2].toLowerCase()) }))
        .filter(t => t.score > 0)
        .sort((a, b) => b.score - a.score)[0]
      text = hit
        ? JSON.stringify({ action: 'tool', tool: hit.name, args: {} })
        : reply('No real model is connected. Mention a tool by name, like "days until" or "notes", to try one.')
    }
    return { text, model: 'offline', usage: { inputTokens: 0, outputTokens: 0 } }
  }

  describe(): Manifest {
    return { name: 'Offline stand-in', use: 'Trying forms and tools without a model', personalInfo: [], usesAi: false, storesIn: 'Nowhere' }
  }
}
