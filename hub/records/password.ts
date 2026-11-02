import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { LimitError } from './errors.ts';

// OWASP's scrypt baseline; bound concurrent derivations as each uses about 128 MiB. Further derivations wait their turn
// (several people may sign in at once); only an overlong queue is refused.
const OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const MAX_ACTIVE = 2, MAX_WAITING = 32;
let active = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < MAX_ACTIVE) { active++; return; }
  if (waiting.length >= MAX_WAITING) throw new LimitError('密码校验繁忙，请稍后重试');
  // The releasing derivation hands its slot over, so `active` stays unchanged.
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next === undefined) active--; else next();
}
export const initialPassword = (): string => randomBytes(18).toString('base64url');
export function validPassword(password: string): boolean {
  return typeof password === 'string' && password.length <= 1024 && password.isWellFormed() && [...password].length >= 12 && [...password].length <= 256 && !/[\p{Cc}]/u.test(password);
}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  await acquire();
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, OPTIONS, (error, key) => error ? reject(error) : resolve(key)));
  } finally { release(); }
}
export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) throw new TypeError('passwords must contain 12 to 256 characters without control characters');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$131072$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function matchesPassword(password: string, hash: string | null): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 1024 || !password.isWellFormed()) return false;
  const parts = hash === null ? null : /^scrypt\$131072\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(hash);
  const key = await derive(password, parts ? Buffer.from(parts[1], 'hex') : Buffer.alloc(16));
  return timingSafeEqual(key, parts ? Buffer.from(parts[2], 'hex') : Buffer.alloc(32)) && parts !== null;
}
