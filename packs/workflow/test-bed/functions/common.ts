// Small pure helpers of the test-bed functions: input guards and clipping. No imports at run time.
// Convention of the pack functions in this repository: pure TypeScript, erasable syntax only, imports end in .ts.

export const PACK = 'test-bed';

export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** At most `max` code points; a clipped text ends with an ellipsis. */
export function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** A number when the value is a finite integer, else null. */
export function intOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
