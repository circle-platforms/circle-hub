// The one-time setup code that lets the web console create the first administrator: `circle-hub setup-code` (or the
// installer, through it) prints a fresh code once and keeps only its SHA-256 in <data dir>/config/setup-code.json (0600);
// /console/setup accepts it while no administrator exists, at most for SETUP_CODE_TTL_MS, and removes the file when the
// administrator is created. Whoever can read the operator's terminal output, or run the CLI as the deployment's account,
// can create the first administrator anyway (records' bootstrapAdmin); the code carries that right to a browser without
// putting it on the network before an administrator exists.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const SETUP_CODE_SCHEMA = 'circle-hub-setup-code@1';
export const SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;
/** Crockford base32 without I, L, O and U: easy to read off a terminal and type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const SetupCodeFile = z.object({ schema: z.literal(SETUP_CODE_SCHEMA), sha256: z.string().regex(/^[0-9a-f]{64}$/), created_at: z.string() }).strict();

export function setupCodePath(dataDir: string): string {
  return join(dataDir, 'config', 'setup-code.json');
}

/** Upper case, without the dashes and spaces a person types between the groups. */
export function normalizeSetupCode(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, '');
}

const digest = (code: string): string => createHash('sha256').update(normalizeSetupCode(code), 'utf8').digest('hex');

/** A new code (25 characters in five groups, 125 bits), replacing any earlier one. */
export async function issueSetupCode(dataDir: string, now: Date = new Date()): Promise<string> {
  const bytes = randomBytes(25);
  const plain = [...bytes].map((byte) => ALPHABET[byte % 32]).join('');
  const code = plain.match(/.{5}/g)!.join('-');
  const path = setupCodePath(dataDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schema: SETUP_CODE_SCHEMA, sha256: digest(code), created_at: now.toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  return code;
}

export type SetupCodeCheck = 'ok' | 'none' | 'expired' | 'wrong';

/** Compares `code` with the kept digest in constant time; an expired code is never accepted. */
export async function checkSetupCode(dataDir: string, code: string, now: Date = new Date()): Promise<SetupCodeCheck> {
  let text: string;
  try {
    text = await readFile(setupCodePath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw error;
  }
  const parsed = SetupCodeFile.safeParse(JSON.parse(text));
  if (!parsed.success) return 'none';
  const created = Date.parse(parsed.data.created_at);
  if (Number.isNaN(created) || now.getTime() - created > SETUP_CODE_TTL_MS) return 'expired';
  const expected = Buffer.from(parsed.data.sha256, 'hex');
  const actual = Buffer.from(digest(code), 'hex');
  return timingSafeEqual(expected, actual) ? 'ok' : 'wrong';
}

export async function removeSetupCode(dataDir: string): Promise<void> {
  await rm(setupCodePath(dataDir), { force: true });
}
