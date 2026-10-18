import { AsyncLocalStorage } from 'node:async_hooks'
import type { SpanHandle, SpanOptions, AttrValue } from './telemetry'

// The telemetry and span for the code running now, carried across awaits.
// Its own file so HttpClient can open spans without importing the exporters.

export interface ActiveTelemetry {
  inSpan<T>(name: string, opts: SpanOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T>
}

export interface Active { telemetry: ActiveTelemetry; span?: SpanHandle }

export const context = new AsyncLocalStorage<Active>()

export const activeTelemetry = (): Active | undefined => context.getStore()

export type { AttrValue }
