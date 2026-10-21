// Digest helpers. Hashes are lowercase hex SHA-256; the digest of a JSON value is the hash of its RFC 8785 canonical UTF-8 text.
import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.ts';

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/** SHA-256 of bytes, or of the UTF-8 encoding of a string. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of the canonical JSON of a value. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export interface DigestEnvelope {
  kind: string;
  schema: string;
  provenance: string;
  created_at: string;
  body: unknown;
}

/** Digest of a record: SHA-256 of the RFC 8785 canonical JSON of {kind, schema, provenance, created_at, body}. */
export function recordDigest(envelope: DigestEnvelope): string {
  const { kind, schema, provenance, created_at, body } = envelope;
  return digestOf({ kind, schema, provenance, created_at, body });
}

/**
 * Canonical envelope text built from an already canonical body (member order body, created_at, kind, provenance, schema).
 * Equal to canonicalize({kind, schema, provenance, created_at, body}) whenever `bodyCanonical` is canonical.
 */
export function envelopeCanonical(meta: Omit<DigestEnvelope, 'body'>, bodyCanonical: string): string {
  return `{"body":${bodyCanonical},"created_at":${JSON.stringify(meta.created_at)},"kind":${JSON.stringify(meta.kind)},"provenance":${JSON.stringify(meta.provenance)},"schema":${JSON.stringify(meta.schema)}}`;
}
