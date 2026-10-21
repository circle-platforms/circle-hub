// Entity ids: `<prefix>_<ULID>` in lowercase Crockford base-32 (48-bit millisecond time, 80 random bits).
// Monotonic within a process: ids created in the same millisecond (or after a clock step back) increment the random part.
import { randomFillSync } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const PREFIX = /^[a-z][a-z0-9]{1,15}$/;
const TIME_MAX = 2 ** 48 - 1;
export const ID_PATTERN = /^[a-z][a-z0-9]{1,15}_[0-9a-hjkmnp-tv-z]{26}$/;

let lastTime = -1;
const lastRandom = new Uint8Array(10);

export function newId(prefix: string, now: number = Date.now()): string {
  if (!PREFIX.test(prefix)) throw new TypeError(`invalid id prefix ${JSON.stringify(prefix)}`);
  return `${prefix}_${ulid(now)}`;
}

/** A 26-character lowercase ULID. */
export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > TIME_MAX) throw new RangeError('ULID time out of range');
  let time = now;
  if (time <= lastTime) {
    time = lastTime;
    increment(lastRandom);
  } else {
    lastTime = time;
    randomFillSync(lastRandom);
  }
  return encodeTime(time) + encodeRandom(lastRandom);
}

export function isId(prefix: string, value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${prefix}_`) && ID_PATTERN.test(value);
}

/** Millisecond time encoded in an id or a bare ULID. */
export function idTime(id: string): number {
  const body = id.slice(id.lastIndexOf('_') + 1);
  let time = 0;
  for (const char of body.slice(0, 10)) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new TypeError('not a ULID');
    time = time * 32 + digit;
  }
  return time;
}

function increment(bytes: Uint8Array): void {
  for (let index = bytes.length - 1; index >= 0; index--) {
    if (bytes[index] < 0xff) {
      bytes[index]++;
      return;
    }
    bytes[index] = 0;
  }
  throw new RangeError('ULID random part overflowed within one millisecond');
}

function encodeTime(time: number): string {
  let out = '';
  let rest = time;
  for (let index = 0; index < 10; index++) {
    const digit = rest % 32;
    out = ALPHABET[digit] + out;
    rest = (rest - digit) / 32;
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}
