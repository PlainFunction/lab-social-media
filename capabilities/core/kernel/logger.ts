import { Port } from './port'

export type LogFields = Record<string, unknown>

// Logs go to Workers Logs, which people other than the client can read, so the
// logger scrubs before it writes. Callers should still log ids, not content.

const SECRET_KEY = /(secret|token|password|authori[sz]ation|api[-_]?key|cookie|keyring|webhook)/i
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[deep]'
  if (typeof value === 'string') return value.replace(EMAIL, '[email]')
  if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1))
  if (value instanceof Error) return { name: value.name, message: scrub(value.message, depth + 1) }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1)]))
  }
  return value
}

export abstract class Logger extends Port {
  abstract write(level: 'info' | 'warn' | 'error', message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields) { this.write('info', message, fields) }
  warn(message: string, fields?: LogFields) { this.write('warn', message, fields) }
  error(message: string, fields?: LogFields) { this.write('error', message, fields) }
}

/** One JSON line per entry, scrubbed. Workers Logs indexes the fields. */
export class JsonLogger extends Logger {
  readonly #base: LogFields
  constructor(base: LogFields = {}) {
    super()
    this.#base = base
  }
  write(level: 'info' | 'warn' | 'error', message: string, fields: LogFields = {}) {
    const line = JSON.stringify(scrub({ level, message, ...this.#base, ...fields }))
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  describe() {
    return { name: 'Workers Logs', use: 'Operational logs, scrubbed of emails and secrets', personalInfo: [], storesIn: 'Cloudflare Workers Logs' }
  }
}

/** Keeps entries in memory. For tests. */
export class MemoryLogger extends Logger {
  readonly entries: { level: string; message: string; fields: LogFields }[] = []
  write(level: 'info' | 'warn' | 'error', message: string, fields: LogFields = {}) {
    this.entries.push({ level, message, fields: scrub(fields) as LogFields })
  }
  describe() {
    return { name: 'Memory log', use: 'Tests', personalInfo: [], storesIn: 'Memory' }
  }
}
