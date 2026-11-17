// Shared URL / form query helpers for console pages (K4).
import type { PageContext } from './context.ts';

export const DAY_MS = 86_400_000;
export const SHA256 = /^[0-9a-f]{64}$/;
export const RUN_ID = /^run_[0-9a-z]{26}$/;
export const USER_ID = /^usr_[0-9a-z]{26}$/;

export const param = (ctx: PageContext, name: string): string | undefined => {
  const value = ctx.url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
};

/** ISO instant, or undefined when absent, or null when present but not a time. */
export function isoOrUndefined(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
