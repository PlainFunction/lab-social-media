// Errors carry a stable code so callers can branch without matching on messages,
// and so nothing sensitive needs to go into the message to be useful.

export class CapabilityError extends Error {
  readonly code: string
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** Identity missing or not trusted, egress to a host that isn't allowed, wrong approver. */
export class NotAllowedError extends CapabilityError {
  constructor(message: string) { super('not_allowed', message) }
}

/** A binding, secret or setting is missing or malformed. */
export class ConfigError extends CapabilityError {
  constructor(message: string) { super('config', message) }
}

/** Input failed validation, including an AI model's output. */
export class ValidationError extends CapabilityError {
  constructor(message: string, options?: ErrorOptions) { super('invalid', message, options) }
}

/** Someone else got there first: an approval already decided, a sequence number taken. */
export class ConflictError extends CapabilityError {
  constructor(message: string) { super('conflict', message) }
}

/** A system we call (Xero, ServiceM8, Slack) said no. Never includes credentials. */
export class UpstreamError extends CapabilityError {
  readonly status: number
  constructor(service: string, status: number, detail = '') {
    super('upstream', `${service} responded ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    this.status = status
  }
}

/** The adapter exists but this operation isn't built for it yet. */
export class NotSupportedError extends CapabilityError {
  constructor(message: string) { super('not_supported', message) }
}
