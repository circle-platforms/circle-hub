// Shared primitives of the Hub contracts. Enumerations never appear here: they come from the generated vocabulary.
// Every object is strict: an unknown or misspelled key is an issue with a path, never silently dropped.
import { z } from 'zod';
import { AcceptanceSchema, CallResultSchema } from '../generated/vocabulary.ts';

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex SHA-256');
export type Sha256 = z.infer<typeof Sha256>;

/** ISO 8601 in UTC with `Z`; offsets are rejected. */
export const IsoTime = z.iso.datetime();
export type IsoTime = z.infer<typeof IsoTime>;

/** Lowercase Crockford base-32 ULID: 26 characters without i, l, o, u; the first is 0-7 (128 bits). */
const ULID = '[0-7][0-9a-hjkmnp-tv-z]{25}';

/** Identifier of a Hub entity: a short lowercase prefix naming the kind, `_`, then a lowercase ULID. */
export const idOf = (prefix: string) => {
  if (!/^[a-z]{2,8}$/.test(prefix)) throw new Error(`id prefix must be 2 to 8 lowercase letters: ${prefix}`);
  return z.string().regex(new RegExp(`^${prefix}_${ULID}$`), `${prefix}_ followed by a 26 character lowercase ULID`);
};
export const RunId = idOf('run');
export const UserId = idOf('usr');
export const TokenId = idOf('tok');
export const RecordId = idOf('rcd');
/** A lease identity: `lse_` plus a 26 character lowercase ULID (the identity the keys of one grant are held under). */
export const LeaseId = idOf('lse');
export type RunId = z.infer<typeof RunId>;
export type UserId = z.infer<typeof UserId>;
export type TokenId = z.infer<typeof TokenId>;
export type RecordId = z.infer<typeof RecordId>;
export type LeaseId = z.infer<typeof LeaseId>;

/** Identity of an item inside one run. Chosen by the pack's projection function, opaque to the Hub core. */
export const ItemId = z.string().min(1).max(200);
export type ItemId = z.infer<typeof ItemId>;

/** An integer major version without leading zeros, so `x@01` and `x@1` cannot both exist. */
const MAJOR = '(?:0|[1-9][0-9]*)';

/** `name@version` with an integer major version, for interpreters, parsers and check contracts. */
export const Versioned = z.string().regex(new RegExp(`^[a-z][a-z0-9_.-]*@${MAJOR}$`), 'name@major');
export type Versioned = z.infer<typeof Versioned>;

/** `name@major` key of a registered record or pack-file shape (SCHEMA_REGISTRY, RecordEnvelope.schema). */
export const SchemaId = z.string().regex(new RegExp(`^[a-z][a-z0-9_-]*@${MAJOR}$`), 'name@major');
export type SchemaId = z.infer<typeof SchemaId>;

/** `1.2.3`-style pack version. */
export const PackVersion = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);
export const PackId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);

/** W3C Trace Context trace-id: 32 lowercase hex characters, not all zero. */
export const TraceId = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'W3C trace-id: 32 lowercase hex characters')
  .refine((id) => !/^0+$/.test(id), 'the all-zero trace-id is invalid (W3C Trace Context)');
export type TraceId = z.infer<typeof TraceId>;

/** RFC 6901 JSON Pointer; the empty string is the whole value. At most 8192 characters: the check aborts before the pattern, which overflows on megabytes. */
export const JsonPointer = z
  .string()
  .max(8192, { abort: true })
  .regex(/^(?:\/(?:[^~/]|~[01])*)*$/, 'RFC 6901 JSON Pointer')
  .describe('RFC 6901 JSON Pointer; the empty string is the whole value');
export type JsonPointer = z.infer<typeof JsonPointer>;

/** Coverage of a read or search: complete only when the whole requested scope was examined (A05 R[1], D05). */
export const Coverage = z
  .strictObject({
    complete: z.boolean(),
    examined: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
    note: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.total === undefined) return;
    if (c.examined > c.total) ctx.addIssue({ code: 'custom', path: ['examined'], message: 'examined cannot exceed total' });
    else if (c.complete && c.examined !== c.total) ctx.addIssue({ code: 'custom', path: ['complete'], message: 'coverage is complete only when examined equals total' });
  });
export type Coverage = z.infer<typeof Coverage>;

/** One protocol error or item-level refutation with its fix (D05). `code` is a protocol code or a namespaced violation code. */
export const ProtocolError = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  fix: z.string().optional(),
  path: JsonPointer.optional().describe('JSON Pointer into the call arguments; for submit_result, into the submission'),
  item: ItemId.optional(),
  requirement: z.string().optional(),
  rounds_left: z.number().int().nonnegative().optional(),
  request_id: z.string().optional(),
  options: z.array(z.string()).optional(),
});
export type ProtocolError = z.infer<typeof ProtocolError>;

/**
 * Fields every tool result carries (D05). `call_result` agrees with MCP isError: an error names at least one code, and
 * a receipt (`acceptance`, only on submit, upload and effect writes) is `accepted` exactly when the call is ok (D05 R[1]).
 */
export const Envelope = z
  .strictObject({
    call_result: CallResultSchema.extract(['ok', 'error']),
    acceptance: AcceptanceSchema.optional(),
    coverage: Coverage.optional(),
    next: z.string().nullable().optional(),
    errors: z.array(ProtocolError),
    trace: TraceId,
  })
  .superRefine((e, ctx) => {
    if (e.call_result === 'error' && e.errors.length === 0) ctx.addIssue({ code: 'custom', path: ['errors'], message: 'an error result names at least one code' });
    if (e.acceptance !== undefined && (e.acceptance === 'accepted') !== (e.call_result === 'ok')) {
      ctx.addIssue({ code: 'custom', path: ['acceptance'], message: 'an accepted call is ok and a call that is not accepted is an error (D05 R[1])' });
    }
  });
export type Envelope = z.infer<typeof Envelope>;
