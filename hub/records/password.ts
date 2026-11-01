import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { LimitError } from './errors.ts';

// OWASP's scrypt baseline; bound concurrent derivations as each uses about 128 MiB.
const OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let active = 0;
export const initialPassword = (): string => randomBytes(18).toString('base64url');
export function validPassword(password: string): boolean {
  return typeof password === 'string' && password.length <= 1024 && password.isWellFormed() && [...password].length >= 12 && [...password].length <= 256 && !/[\p{Cc}]/u.test(password);
}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (active >= 2) throw new LimitError('口令校验繁忙，请稍后重试');
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, OPTIONS, (error, key) => error ? reject(error) : resolve(key)));
  } finally { active--; }
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
