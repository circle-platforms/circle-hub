// Shared primitives of the Hub contracts. Enumerations never appear here: they come from the generated vocabulary.
import { z } from 'zod';
import { AcceptanceSchema, CallResultSchema } from '../generated/vocabulary.ts';

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex SHA-256');
export type Sha256 = z.infer<typeof Sha256>;

export const IsoTime = z.iso.datetime();
export type IsoTime = z.infer<typeof IsoTime>;

/** Identifier of a Hub entity: a short lowercase prefix naming the kind, then a lowercase base-32 ULID. */
export const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{26}$`), `${prefix}_ followed by a 26 character ULID`);
export const RunId = idOf('run');
export const UserId = idOf('usr');
export const TokenId = idOf('tok');
export type RunId = z.infer<typeof RunId>;
export type UserId = z.infer<typeof UserId>;
export type TokenId = z.infer<typeof TokenId>;

/** Identity of an item inside one run. Chosen by the pack's projection function, opaque to the Hub core. */
export const ItemId = z.string().min(1).max(200);
export type ItemId = z.infer<typeof ItemId>;

/** `name@version` with an integer major version, for interpreters, parsers and check contracts. */
export const Versioned = z.string().regex(/^[a-z][a-z0-9_.-]*@[0-9]+$/, 'name@major');
export type Versioned = z.infer<typeof Versioned>;

/** `1.2.3`-style pack version. */
export const PackVersion = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);
export const PackId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);

/** W3C Trace Context trace-id: 32 lowercase hex characters. */
export const TraceId = z.string().regex(/^[0-9a-f]{32}$/);

/** Coverage of a read or search: complete only when the whole requested scope was examined (D05). */
export const Coverage = z.object({
  complete: z.boolean(),
  examined: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});
export type Coverage = z.infer<typeof Coverage>;

/** One protocol error or item-level refutation with its fix (D05). `code` is a protocol code or a namespaced violation code. */
export const ProtocolError = z.object({
  code: z.string().min(1),
  message: z.string(),
  fix: z.string().optional(),
  path: z.string().optional().describe('JSON Pointer into the submission'),
  item: z.string().optional(),
  requirement: z.string().optional(),
  rounds_left: z.number().int().nonnegative().optional(),
  request_id: z.string().optional(),
  options: z.array(z.string()).optional(),
});
export type ProtocolError = z.infer<typeof ProtocolError>;

/** Fields every tool result carries (D05). `call_result` agrees with MCP isError; `acceptance` only on submit, upload and effect writes. */
export const Envelope = z.object({
  call_result: CallResultSchema.extract(['ok', 'error']),
  acceptance: AcceptanceSchema.optional(),
  coverage: Coverage.optional(),
  next: z.string().nullable().optional(),
  errors: z.array(ProtocolError),
  trace: z.string().regex(/^[0-9a-f]{32}$/),
});
export type Envelope = z.infer<typeof Envelope>;
