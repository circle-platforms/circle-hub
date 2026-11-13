// Call-log query shared by the records page and /console/api/records (K4).
import type { CallLogLine, Page } from '../../records/api.ts';
import type { PageContext } from './context.ts';
import { USER_ID, isoOrUndefined, param } from './params.ts';

export interface CallLogFilters {
  user?: string;
  tool?: string;
  run?: string;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | null;
  limit: number;
  /** When set, fill a default window ending at `now` (page behaviour). */
  defaultDays?: number;
  now?: number;
}

export interface CallLogQueryReady {
  /** null = bad from/to; empty userId means unknown member name. */
  problems: string[];
  from: string | undefined | null;
  to: string | undefined | null;
  userId: string | undefined;
  tool: string | undefined;
  run: string | undefined;
  rangeFrom: string | undefined;
  rangeTo: string | undefined;
  cursor: string | null;
  limit: number;
}

/** Resolve member name/id and time bounds the same way for the page and the API. */
export async function resolveCallLogFilters(ctx: PageContext, input: CallLogFilters): Promise<CallLogQueryReady> {
  const from = isoOrUndefined(input.from);
  const to = isoOrUndefined(input.to);
  const problems: string[] = [];
  if (from === null) problems.push('“从”不是时间');
  if (to === null) problems.push('“到”不是时间');
  const now = input.now ?? (ctx.deps.now?.() ?? new Date()).getTime();
  let rangeFrom = from ?? undefined;
  let rangeTo = to ?? undefined;
  // Page default window: fill whichever bound the URL omitted (same as the old records page).
  if (input.defaultDays !== undefined) {
    const beginning = new Date(now);
    beginning.setDate(beginning.getDate() - (input.defaultDays - 1));
    beginning.setHours(0, 0, 0, 0);
    if (from === undefined) rangeFrom = beginning.toISOString();
    if (to === undefined) rangeTo = new Date(now + 1).toISOString();
  }
  if (rangeFrom !== undefined && rangeTo !== undefined && Date.parse(rangeFrom) >= Date.parse(rangeTo)) {
    problems.push('结束时间须晚于开始时间');
  }
  let userId: string | undefined;
  if (input.user !== undefined) {
    userId = USER_ID.test(input.user) ? input.user : ((await ctx.deps.records.principals.findByName(input.user))?.id ?? '');
  }
  return {
    problems,
    from,
    to,
    userId,
    tool: input.tool,
    run: input.run,
    rangeFrom,
    rangeTo,
    cursor: input.cursor ?? null,
    limit: input.limit,
  };
}

/** Filters taken from the request URL (admin may pass user). */
export function callLogFiltersFromUrl(ctx: PageContext, limit: number, defaultDays?: number): CallLogFilters {
  return {
    user: ctx.admin ? param(ctx, 'user') : undefined,
    tool: param(ctx, 'tool'),
    run: param(ctx, 'run'),
    from: param(ctx, 'from'),
    to: param(ctx, 'to'),
    cursor: param(ctx, 'cursor') ?? null,
    limit,
    ...(defaultDays === undefined ? {} : { defaultDays }),
  };
}

export async function queryCallLog(ctx: PageContext, ready: CallLogQueryReady): Promise<Page<CallLogLine>> {
  if (ready.userId === '') return { items: [], next: null };
  return ctx.deps.records.callLog.query(ctx.principal, {
    ...(ready.userId === undefined ? {} : { userId: ready.userId }),
    ...(ready.tool === undefined ? {} : { tool: ready.tool }),
    ...(ready.run === undefined ? {} : { runId: ready.run }),
    ...(ready.rangeFrom ? { from: ready.rangeFrom } : {}),
    ...(ready.rangeTo ? { to: ready.rangeTo } : {}),
    limit: ready.limit,
    cursor: ready.cursor,
  });
}
