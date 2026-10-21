// Typed errors of the records package. `code` is a registered protocol code only when the failure belongs to the caller;
// internal faults (integrity, migration, vault key) carry no code and the server reports them as its own failure.
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import type { ProtocolCode } from '../../contracts/generated/protocol.ts';

export interface RecordsErrorOptions {
  code?: ProtocolCode | null;
  fix?: string | null;
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export class RecordsError extends Error {
  readonly code: ProtocolCode | null;
  readonly fix: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(message: string, options: RecordsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RecordsError';
    this.code = options.code ?? null;
    this.fix = options.fix ?? (options.code ? PROTOCOL_CODES[options.code].fix : null);
    this.detail = Object.freeze({ ...(options.detail ?? {}) });
  }
}

/** Stored bytes or rows no longer match their digest. Never repaired silently. */
export class IntegrityError extends RecordsError {
  constructor(message: string, options: RecordsErrorOptions = {}) {
    super(message, options);
    this.name = 'IntegrityError';
  }
}

/** A configured size limit was exceeded. The input is refused whole, never truncated. */
export class LimitError extends RecordsError {
  constructor(message: string, options: RecordsErrorOptions = {}) {
    super(message, options);
    this.name = 'LimitError';
  }
}

/** The acting principal may not make this decision (for example a non-admin assigning a pack). */
export class AccessError extends RecordsError {
  constructor(message: string, options: RecordsErrorOptions = {}) {
    super(message, options);
    this.name = 'AccessError';
  }
}

/** The request conflicts with the current state (for example bootstrapping a second first admin). */
export class ConflictError extends RecordsError {
  constructor(message: string, options: RecordsErrorOptions = {}) {
    super(message, options);
    this.name = 'ConflictError';
  }
}

/** The database schema is not one this program can run against. The process refuses to start. */
export class MigrationError extends RecordsError {
  constructor(message: string, options: RecordsErrorOptions = {}) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/** The vault key is missing or wrong, or a sealed entry was altered or renamed. */
export class VaultError extends RecordsError {
  constructor(message: string, options: RecordsErrorOptions = {}) {
    super(message, options);
    this.name = 'VaultError';
  }
}
