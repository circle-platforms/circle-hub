// Runtime constants shared by the records modules (kept apart from api.ts so implementation modules import only types from it).
import type { RecordKind } from '../../contracts/generated/protocol.ts';

/** Subject or object meaning "the whole Hub", for example the object of a publish-right grant. */
export const WHOLE_HUB = '*';

/**
 * Object key of a share authorization for one source artifact record: `rec:<record digest>`. A share covers that record
 * only, never other records of the same bytes (another user's upload of identical bytes stays private).
 */
export function artifactShareKey(artifact: { kind: string; digest: string }): string {
  if (artifact?.kind !== 'source_artifact' || typeof artifact.digest !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.digest)) {
    throw new TypeError('a share key names a source_artifact record');
  }
  return `rec:${artifact.digest}`;
}

/**
 * Resource id of an admin's acceptance of the credential findings of some exact bytes: `scan:<sha256>`. The acceptance is a
 * resource configuration (B04, subject WHOLE_HUB) bound to scanDigest of the scan it covers (README decision 18).
 */
export function scanAcceptanceKey(sha256: string): string {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError('a scan acceptance names the SHA-256 of the bytes');
  return `scan:${sha256}`;
}

/** Schemas of the record bodies this package writes. */
export const RECORD_SCHEMAS = {
  source_artifact: 'source_artifact@1',
  action: 'action@1',
  authorization: 'authorization@1',
  call_log: 'call_log@1',
} as const satisfies Partial<Record<RecordKind, string>>;
