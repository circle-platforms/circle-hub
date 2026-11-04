// What a reader may be given of an answer held for scan findings: the same JSON with every value the scanner matched taken out
// of its strings. The answer stays stored as it came and held (B02 R[4]); this is a generated copy, never the original (R[6]).
import { scanAllCredentials } from './scan.ts';

const MASK = '[已隐去]';
/** Taking a value out can bring the next one into view; a document that is not clean after this many rounds stays held. */
const ROUNDS = 4;

function masked(value: unknown, found: readonly string[]): unknown {
  if (typeof value === 'string') return found.reduce((text, match) => text.replaceAll(match, MASK), value);
  if (Array.isArray(value)) return value.map((item) => masked(item, found));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, masked(item, found)]));
  return value;
}

/**
 * The JSON document without what the scanner matched, or null when that cannot be shown: the bytes are no JSON, the scan is not
 * complete, or a hit is left, as one inside an encoded value is. The last scan is of the bytes returned, so they are clean by the
 * same scan that holds the original. The matches never leave this function.
 */
export function maskedJson(bytes: Uint8Array): Uint8Array | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  let current = bytes;
  for (let round = 0; round <= ROUNDS; round++) {
    const { scan, matches, complete } = scanAllCredentials(current);
    if (!complete || scan.truncated || !scan.inspected) return null;
    if (scan.findings.length === 0) return current;
    if (round === ROUNDS) return null;
    const found = [...new Set(matches)].filter((text) => text !== '').sort((a, b) => b.length - a.length);
    value = masked(value, found);
    const next = Buffer.from(JSON.stringify(value));
    if (next.equals(current)) return null;
    current = next;
  }
  return null;
}
