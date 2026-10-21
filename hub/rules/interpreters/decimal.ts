// Exact decimals for range@1. JSON numbers count by their shortest decimal text (0.1 is 0.1, as the author wrote it) and decimal
// strings by every digit, so values beyond 2^53 or with hundreds of digits are compared and summed without rounding.

/** value = coefficient × 10^-scale, scale >= 0 */
export interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

/** Longest decimal text that is compared; a longer one is not judged (unknown). */
export const MAX_DECIMAL_LENGTH = 1000;

const DECIMAL_STRING = /^([+-]?)([0-9]+)(?:\.([0-9]+))?$/;
// What String(number) gives for a finite number: 12, -0.5, 1e+21, 5e-324, 1.5e-7.
const NUMBER_TEXT = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-][0-9]+))?$/;

function build(sign: string, whole: string, fraction: string | undefined, exponent: number): Decimal {
  let coefficient = BigInt(`${whole}${fraction ?? ''}`);
  if (sign === '-') coefficient = -coefficient;
  let scale = (fraction?.length ?? 0) - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

/** A decimal string such as 12, -3.50 or +7 (surrounding white space is the caller's to trim). */
export function parseDecimal(text: string): Decimal | undefined {
  const m = DECIMAL_STRING.exec(text);
  return m ? build(m[1], m[2], m[3], 0) : undefined;
}

export function decimalOfNumber(n: number): Decimal | undefined {
  if (!Number.isFinite(n)) return undefined;
  const m = NUMBER_TEXT.exec(String(n));
  return m ? build(m[1], m[2], m[3], m[4] === undefined ? 0 : Number(m[4])) : undefined;
}

const align = (d: Decimal, scale: number): bigint => d.coefficient * 10n ** BigInt(scale - d.scale);

export function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const x = align(a, scale);
  const y = align(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { coefficient: align(a, scale) + align(b, scale), scale };
}

export const ZERO: Decimal = { coefficient: 0n, scale: 0 };

export function isIntegral(d: Decimal): boolean {
  return d.coefficient % 10n ** BigInt(d.scale) === 0n;
}

/** Plain decimal text without trailing fractional zeros. */
export function decimalText(d: Decimal): string {
  const negative = d.coefficient < 0n;
  const digits = (negative ? -d.coefficient : d.coefficient).toString().padStart(d.scale + 1, '0');
  const whole = digits.slice(0, digits.length - d.scale);
  const fraction = digits.slice(digits.length - d.scale).replace(/0+$/, '');
  return `${negative && (whole !== '0' || fraction !== '') ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Text for statements: long values keep their first and last digits. */
export function shownDecimal(d: Decimal): string {
  const text = decimalText(d);
  return text.length > 40 ? `${text.slice(0, 20)}…${text.slice(-8)}（${text.length} 个字符）` : text;
}

/** A JSON number when one represents the value exactly, else its decimal text. */
export function decimalJson(d: Decimal): number | string {
  const text = decimalText(d);
  const n = Number(text);
  const back = decimalOfNumber(n);
  return back !== undefined && compareDecimal(back, d) === 0 ? n : text;
}
