import { Port } from './port'

export abstract class Clock extends Port {
  abstract now(): Date

  /** Whole days from `iso` (a date or timestamp) to now. Negative if `iso` is in the future. */
  daysSince(iso: string): number {
    return Math.floor((this.now().getTime() - new Date(iso).getTime()) / 86_400_000)
  }

  describe() {
    return { name: 'Clock', use: 'Telling the time', personalInfo: [], storesIn: 'Nowhere' }
  }
}

export class SystemClock extends Clock {
  now() { return new Date() }
}

/** For tests: time only moves when you move it. */
export class FixedClock extends Clock {
  #t: number
  constructor(at: string | Date) {
    super()
    this.#t = new Date(at).getTime()
  }
  now() { return new Date(this.#t) }
  advance(ms: number) { this.#t += ms }
  advanceDays(days: number) { this.advance(days * 86_400_000) }
}
