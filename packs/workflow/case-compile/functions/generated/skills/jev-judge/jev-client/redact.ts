// Secret handling of the Jev client: redaction of text that leaves the process, detection of an answer that echoes the key, and the
// digest used by the audit record.
import { createHash } from 'node:crypto';

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/giu;
// This many consecutive key characters in anything the service sent count as an echo of the key.
const KEY_ECHO_RUN = 12;
// Shorter keys are not realistic; a test on them would flag ordinary text.
const MIN_ECHO_KEY_LENGTH = 8;
const MIN_REDACT_KEY_LENGTH = 4;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The text with every bearer credential and every given secret replaced; for output that leaves the process. */
export function redactSecret(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_REDACT_KEY_LENGTH) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/**
 * A test for text the service sent back (an echoing proxy or a misconfigured endpoint): true when the text holds the key, a run
 * of KEY_ECHO_RUN key characters, or is itself a piece of the key of at least 8 characters.
 */
export function keyEchoTest(key: string): (text: string) => boolean {
  if (key.length < MIN_ECHO_KEY_LENGTH) return () => false;
  const runs = new Set<string>();
  for (let at = 0; at + KEY_ECHO_RUN <= key.length; at += 1) runs.add(key.slice(at, at + KEY_ECHO_RUN));
  return (text) => {
    if (text.includes(key) || (text.length >= MIN_ECHO_KEY_LENGTH && key.includes(text))) return true;
    for (let at = 0; at + KEY_ECHO_RUN <= text.length; at += 1) if (runs.has(text.slice(at, at + KEY_ECHO_RUN))) return true;
    return false;
  };
}
