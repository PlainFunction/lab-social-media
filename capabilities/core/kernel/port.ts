// The base of every port. A port is an abstract class; an adapter extends it.
// The abstract class doubles as the registry key (see registry.ts), so a port,
// its adapters and its binding can't drift apart.
//
// Every adapter has to describe itself. The description is what we'd write on a
// client's AI use register and data map anyway, so the code keeps it for us
// (governance/ai-register.ts reads it back out).

/** What an adapter does with data. Columns match the toolkit's AI use register. */
export interface Manifest {
  /** e.g. "Xero (invoices)" */
  name: string
  /** What it's for, in plain English. */
  use: string
  /** Kinds of personal information it handles, e.g. ['name', 'email']. Empty means none. */
  personalInfo: string[]
  /** True when an AI model sees any of the data. */
  usesAi?: boolean
  /** True when it makes, or substantially helps make, a decision about a person (APP 1.7). */
  decides?: boolean
  /** Who or what checks the output before it matters, e.g. "Owner approves every email". */
  checkedBy?: string
  /** Where the data rests, e.g. "Cloudflare D1 (Sydney jurisdiction), encrypted". */
  storesIn: string
  /** Hostnames it is allowed to call. Enforced by HttpClient for adapters that use it. */
  egress?: string[]
}

export abstract class Port {
  abstract describe(): Manifest
}

/**
 * A decorator wraps another adapter of the same port (caching, redaction, metering).
 * It reports the inner adapter's manifest with its own notes merged in, so the
 * register describes the whole stack, not just the outer layer.
 */
export const mergeManifest = (inner: Manifest, outer: Partial<Manifest> & { name: string }): Manifest => ({
  ...inner,
  ...outer,
  name: `${outer.name} → ${inner.name}`,
  personalInfo: [...new Set([...inner.personalInfo, ...(outer.personalInfo ?? [])])],
  usesAi: inner.usesAi || outer.usesAi,
  decides: inner.decides || outer.decides,
  egress: [...new Set([...(inner.egress ?? []), ...(outer.egress ?? [])])],
  storesIn: outer.storesIn ? `${outer.storesIn}; ${inner.storesIn}` : inner.storesIn,
})
