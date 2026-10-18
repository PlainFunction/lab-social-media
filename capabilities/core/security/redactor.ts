import { Port } from '../kernel/port'

/**
 * Swaps personal details for placeholders before text goes to an AI model,
 * and swaps them back in the reply. The model writes "Hi [NAME_1]" and never
 * sees who the customer is, which also means AI responses can be cached
 * without caching anyone's details.
 *
 * Regexes can't find every name, so callers pass the ones they know about
 * (the customer's name from Xero, the business name) as `known`.
 */
export interface RedactionSession {
  redact(text: string): string
  restore(text: string): string
  /** How many of each kind were replaced, for the audit log. */
  counts(): Record<string, number>
}

export abstract class Redactor extends Port {
  abstract session(known?: { label: string; value: string }[]): RedactionSession
}

interface Pattern { label: string; re: RegExp }

// Order matters: longer and more specific patterns first, so a card number
// isn't half-eaten by the phone pattern.
export const AU_PATTERNS: Pattern[] = [
  { label: 'EMAIL', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { label: 'URL', re: /https?:\/\/[^\s<>"')]+/gi },
  { label: 'CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g },
  { label: 'ABN', re: /\b\d{2} ?\d{3} ?\d{3} ?\d{3}\b/g },
  { label: 'BSB', re: /\b\d{3}-\d{3}\b/g },
  { label: 'TFN', re: /\b\d{3} ?\d{3} ?\d{3}\b/g },
  { label: 'PHONE', re: /(?:\+?61[ -]?|\b0)[2-478](?:[ -]?\d){8}\b/g },
  { label: 'PHONE', re: /\b1[38]00(?:[ -]?\d){6}\b/g },
]

export class PatternRedactor extends Redactor {
  readonly #patterns: Pattern[]
  constructor(patterns: Pattern[] = AU_PATTERNS) {
    super()
    this.#patterns = patterns
  }

  session(known: { label: string; value: string }[] = []): RedactionSession {
    const byValue = new Map<string, string>()
    const byPlaceholder = new Map<string, string>()
    const counts: Record<string, number> = {}

    const placeholder = (label: string, value: string) => {
      const existing = byValue.get(value)
      if (existing) return existing
      counts[label] = (counts[label] ?? 0) + 1
      const p = `[${label}_${counts[label]}]`
      byValue.set(value, p)
      byPlaceholder.set(p, value)
      return p
    }

    // Longest first, so "Dan Smith" is replaced before "Dan".
    const knownSorted = known
      .filter(k => k.value.trim().length > 1)
      .sort((a, b) => b.value.length - a.value.length)

    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    return {
      redact: (text: string) => {
        let out = text
        // Patterns first, so "Jane" doesn't half-replace jane@example.com and leave the domain behind.
        for (const { label, re } of this.#patterns) {
          out = out.replace(re, m => placeholder(label, m))
        }
        for (const k of knownSorted) {
          const v = k.value.trim()
          // Whole words only: "Dan" shouldn't eat the middle of "Danger".
          const re = new RegExp(`${/^\w/.test(v) ? '\\b' : ''}${escape(v)}${/\w$/.test(v) ? '\\b' : ''}`, 'gi')
          out = out.replace(re, m => placeholder(k.label.toUpperCase(), m))
        }
        return out
      },
      restore: (text: string) => text.replace(/\[[A-Z]+_\d+\]/g, p => byPlaceholder.get(p) ?? p),
      counts: () => ({ ...counts }),
    }
  }

  describe() {
    return { name: 'Pattern redactor', use: 'Removing names, emails, phone numbers, ABNs, TFNs and card numbers before text reaches an AI model', personalInfo: [], storesIn: 'Nowhere (memory, per request)' }
  }
}
