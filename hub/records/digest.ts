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

/** Same envelope digest without flattening a second string containing the entire stored body. */
export function envelopeDigest(meta: Omit<DigestEnvelope, 'body'>, bodyCanonical: string): string {
  const hash = createHash('sha256').update('{"body":');
  // Reuse one UTF-8 scratch buffer: a string update otherwise allocates native transcoding storage for every chunk.
  if (bodyCanonical.length <= 16 * 1024) hash.update(bodyCanonical);
  else {
    const scratch = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < bodyCanonical.length;) {
      let end = Math.min(bodyCanonical.length, offset + 16 * 1024);
      if (end < bodyCanonical.length && bodyCanonical.charCodeAt(end - 1) >= 0xd800 && bodyCanonical.charCodeAt(end - 1) <= 0xdbff && bodyCanonical.charCodeAt(end) >= 0xdc00 && bodyCanonical.charCodeAt(end) <= 0xdfff) end--;
      const written = scratch.write(bodyCanonical.slice(offset, end), 'utf8');
      hash.update(scratch.subarray(0, written)); offset = end;
    }
  }
  return hash.update(`,"created_at":${JSON.stringify(meta.created_at)},"kind":${JSON.stringify(meta.kind)},"provenance":${JSON.stringify(meta.provenance)},"schema":${JSON.stringify(meta.schema)}}`).digest('hex');
}
