// Redaction for everything the connectors write to a log or put into an error or a reason: every credential value, token and
// header value the process has handled is replaced by *** wherever it appears. This is defence in depth: messages are built
// from route ids, codes and counts, never from header values, URLs with hosts or bodies.
// Values the Hub has SENT in a credential header (tokens, static credentials) are also kept apart: an answer that carries one
// (an echo of the request's own credential, for example a debug page) is stored at read tier retain_only, and a planned
// request that would carry one is refused. Login credentials that are only sent in the login body (a user name, a password
// digest) are masked in texts but are not looked for in answers: a user name may appear in ordinary data.

import {createHash} from 'node:crypto';

const MASK = '***';
/** Values shorter than this are not masked (they would mask ordinary words); credentials are longer. */
const MIN_SECRET = 4;
/** Sent values shorter than this are not looked for in answers (too short to tell from ordinary bytes). */
const MIN_SENT = 8;
const MAX_TEXT = 2000;

function forms(secret: string): string[] {
  return [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64'),createHash('sha256').update(secret).digest('hex'),createHash('sha512').update(secret).digest('hex')];
}

function charsetOf(mediaType: string): string {
  const match = /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/i.exec(mediaType);
  return match === null ? 'utf-8' : match[1].toLowerCase();
}

function decode(bytes: Uint8Array, mediaType: string): string {
  try {
    return new TextDecoder(charsetOf(mediaType)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export class Redactor {
  readonly #secrets = new Set<string>();
  readonly #sent = new Set<string>();
  #sentBytes: Buffer[] | null = null;

  /** Remembers a secret (and its common encodings) so that it is masked from now on. */
  add(secret: string | null | undefined): void {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET) return;
    for (const form of forms(secret)) if (form.length >= MIN_SECRET) this.#secrets.add(form);
  }

  /**
   * Remembers a value the Hub sends in a credential header (a token, a static credential, the header value). It is masked
   * like any secret and, from now on, looked for in answers (echoedIn) and in planned requests (carriesSent). For a value
   * with an authentication scheme word (`Bearer x`, `Basic x`) the part after it counts as well.
   */
  addSent(secret: string | null | undefined): void {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET) return;
    this.add(secret);
    const space = secret.indexOf(' ');
    const values = space > 0 ? [secret, secret.slice(space + 1)] : [secret];
    // RFC 7617: `Basic base64(user-id:password)`; the password is sent too (the user-id may be an ordinary word).
    if (space > 0 && secret.slice(0, space).toLowerCase() === 'basic') {
      const decoded = Buffer.from(secret.slice(space + 1), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0 && /^[\x20-\x7e]+$/.test(decoded)) {
        this.add(decoded);
        values.push(decoded.slice(0,colon),decoded.slice(colon + 1));
      }
    }
    for (const value of values) {
      this.add(value);
      if (value.length < MIN_SENT) continue;
      for (const form of forms(value)) {
        if (form.length < MIN_SENT || this.#sent.has(form)) continue;
        this.#sent.add(form);
        this.#sentBytes = null;
      }
    }
  }

  /** Whether any of the texts contains a sent value in one of its encodings. */
  carriesSent(texts: readonly string[]): boolean {
    if (this.#sent.size === 0) return false;
    for (const text of texts) for (const form of this.#sent) if (text.includes(form)) return true;
    return false;
  }

  /**
   * Whether stored bytes carry a sent value: in the bytes as they are, in their text decoded by the charset of the media
   * type, and in that text without NUL (UTF-16 read as bytes).
   */
  echoedIn(bytes: Uint8Array, mediaType: string): boolean {
    if (this.#sent.size === 0 || bytes.byteLength === 0) return false;
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#sentBytes ??= [...this.#sent].map((form) => Buffer.from(form, 'utf8'));
    for (const form of this.#sentBytes) if (buffer.indexOf(form) >= 0) return true;
    const text = decode(bytes, mediaType);
    if (this.carriesSent([text])) return true;
    return text.includes('\u0000') && this.carriesSent([text.replaceAll('\u0000', '')]);
  }

  /** A copy of a JSON value with every sent value masked in its strings and keys; the structure is kept whole. */
  maskSent(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return this.#maskSentText(value);
    if (value === null || typeof value !== 'object' || depth > 64) return value;
    if (Array.isArray(value)) return value.map((item) => this.maskSent(item, depth + 1));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [this.#maskSentText(key), this.maskSent(item, depth + 1)]));
  }

  #maskSentText(text: string): string {
    let out = text;
    for (const form of [...this.#sent].sort((a, b) => b.length - a.length)) if (out.includes(form)) out = out.split(form).join(MASK);
    return out;
  }

  /** Masks known material without truncating or changing structural whitespace in captured responses. */
  maskText(value:string):string {let text=value;for(const secret of [...this.#secrets].sort((a,b)=>b.length-a.length))if(text.includes(secret))text=text.split(secret).join(MASK);return text;}
  /** The text with every known secret masked, control characters removed and at most 2000 characters. */
  text(value: unknown): string {
    let text = typeof value === 'string' ? value : String(value);
    // Longest first, so that a secret containing another is masked whole.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      if (text.includes(secret)) text = text.split(secret).join(MASK);
    }
    text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  }

  /** A JSON-safe copy of a log detail with every string redacted (depth and size bounded). */
  value(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return this.text(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (depth > 6) return '[…]';
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => this.value(item, depth + 1));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) out[this.text(key)] = this.value(item, depth + 1);
      return out;
    }
    return undefined;
  }
}
