// runCheck: one declared check (a core interpreter with its table, or a pack function in the sandbox) on one subject.
// Total: every failure becomes unknown with a reason from the vocabulary (V01 R[2]); nothing is thrown. A check that is not
// installed gives no outcome at all, because no check is not a verdict (V01 R[1], R[5]): the caller records unchecked (no_check).
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { ReasonSchema } from '../../contracts/generated/vocabulary.ts';
import type { CheckTier, Reason, SourceRole } from '../../contracts/generated/vocabulary.ts';
import { CheckOutcome as CheckOutcomeShape, type CatalogEntry, type CheckOutcome } from '../../contracts/src/tables.ts';
import type { CatalogView } from './catalog/view.ts';
import { getInterpreter } from './interpreters/registry.ts';
import { hasBasis, unknown, type OutcomeBase } from './outcome.ts';
import { SandboxError } from './sandbox/errors.ts';
import { callPackFunction, type SandboxLimits, type SandboxOptions } from './sandbox/sandbox.ts';
import type { CheckContext, SourceView } from './types.ts';

export interface CheckDeclaration {
  /** Check id inside the pack (checks.json), used in statements. */
  id?: string;
  /** A core interpreter, for example catalog@1. Exactly one of `interpreter` and `function`. */
  interpreter?: string;
  /** A pack function: module relative to the pack directory, and its export (default `default`). */
  function?: { module: string; export?: string };
  /**
   * Tier of the check's outcomes, in place of the table's; outcomes marked data.negative_case keep their own tier. Without a
   * tier: the table's for an interpreter; a pack function without one is a check error (publication refuses it,
   * checks.tier_missing; no fallback).
   */
  tier?: CheckTier;
  /** The acceptance contract clause a blocking check relies on (C05 R[1]); for an interpreter the table may give it instead. */
  basis?: string;
  /** Give a pack function the catalog entries (they can be large). */
  catalogEntries?: boolean;
  limits?: Partial<SandboxLimits>;
  /** Bound sources the check declares to read (checks.json reads). */
  reads?: { roles: SourceRole[]; types?: string[]; max_bytes?: number };
}

export interface UnreadSource {
  reference: string;
  reason: string;
  external?: string;
  slot?: string;
  missing_fact?: string;
  next_action?: string;
}

export interface CheckBindings {
  /** The table, already read from the pack. */
  table?: unknown;
  subject: unknown;
  catalog?: CatalogView;
  sources?: SourceView;
  /** context.pack is required for a pack function: its codes must be under `<pack>.`. */
  context: CheckContext;
  /** The extracted pack directory; required for a pack function. */
  packDir?: string;
  /** Fragment texts by reference for a pack function, which cannot call back into a SourceView. */
  sourceTexts?: Readonly<Record<string, string>>;
  /** Sources that could not be read or exceeded max bytes. */
  unreadSources?: ReadonlyArray<UnreadSource>;
  sandbox?: SandboxOptions;
  /** Trusted parent runner; outcomes are still validated normally. Not supplied by pack input. */
  functionRunner?: typeof callPackFunction;
  /**
   * Receives the error behind an unknown outcome with what outcomes leave out (stack, timings, host paths, captured output),
   * for the admin log. Outcomes keep only a stable, path-free part.
   */
  onError?: (error: unknown, check: string) => void;
}

/** Input a pack check function receives. Its output must be an array of check-outcome@1. */
export interface PackCheckInput {
  check: string | null;
  table: unknown;
  subject: unknown;
  context: CheckContext;
  sources: Readonly<Record<string, string>>;
  unread_sources?: ReadonlyArray<UnreadSource>;
  catalog?: CatalogEntry[];
}

const Outcomes = z.array(CheckOutcomeShape).max(10_000);

/**
 * Reasons a check gives for unknown: check error, timeout and missing input (V01 R[2]), an unproven closed world (C07 R[1]) and
 * a used-up budget and a pack-owned output/read-back failure (P05 R[0]). The others belong to models, submissions and runs.
 */
const CHECK_REASONS: readonly Reason[] = ReasonSchema.extract(['check_error', 'timeout', 'missing_input', 'integrity_unproven', 'budget_exhausted', 'output_failed']).options;

/** Problems with outcomes a pack function returned: verdict shape, reasons, and the code namespace of the pack. */
function outcomeProblems(outcomes: CheckOutcome[], pack: string): string | undefined {
  for (const [i, o] of outcomes.entries()) {
    const at = `第 ${i + 1} 项`;
    if (o.verdict === 'refute' && o.code === undefined) return `${at}是反驳却没有码`;
    if (o.verdict !== 'refute' && o.code !== undefined) return `${at}不是反驳却带了码 ${o.code}`;
    if (o.verdict === 'unknown' && (typeof o.missing !== 'string' || !o.missing.trim())) return `${at}是未知却没有顶层 missing`;
    if (o.verdict === 'unknown' && o.reason === undefined) return `${at}是未知却没有原因`;
    if (o.verdict !== 'unknown' && o.reason !== undefined) return `${at}不是未知却带了原因 ${o.reason}`;
    if (o.reason !== undefined && !CHECK_REASONS.includes(o.reason)) return `${at}的原因 ${o.reason} 不是检查能给的原因（只能是 ${CHECK_REASONS.join('、')}）`;
    if (o.code !== undefined) {
      if (o.code.startsWith('core.') || Object.hasOwn(PROTOCOL_CODES, o.code)) return `${at}的码 ${o.code} 属于核心解释器或协议，包内函数不能给出`;
      if (!o.code.startsWith(`${pack}.`) || o.code.length <= pack.length + 1) return `${at}的码 ${o.code} 不在包命名空间 ${pack}. 下`;
    }
  }
  return undefined;
}

/** The check's tier for its outcomes; a negative-case outcome keeps its own, but never blocks without a basis. */
function withTier(outcomes: CheckOutcome[], tier: CheckTier, basis: boolean): CheckOutcome[] {
  return outcomes.map((o) => {
    if (o.data?.negative_case === true) return o.tier === 'blocking' && !basis ? { ...o, tier: 'advisory' } : o;
    return o.tier === tier ? o : { ...o, tier };
  });
}

/** Detail kinds that are stable and path-free; anything else (messages, stacks, timings, specifiers) goes to onError only. */
const PUBLIC_DETAIL = ['reason', 'limit', 'stream', 'phase'] as const;

function publicDetail(error: SandboxError, module: string): Record<string, unknown> {
  const data: Record<string, unknown> = { sandbox: error.code };
  if (!isAbsolute(module) && !module.split(/[\\/]/).includes('..')) data.module = module;
  for (const key of PUBLIC_DETAIL) {
    const value = error.detail[key];
    if (typeof value === 'string' && /^[a-z_]{1,40}$/.test(value)) data[key] = value;
  }
  return data;
}

/** The reason an unknown outcome gives for a sandbox failure. */
export function sandboxReason(error: SandboxError): Reason {
  if (error.code === 'SANDBOX_TIMEOUT') return 'timeout';
  if (error.code === 'SANDBOX_UNAVAILABLE' && error.detail.reason === 'queue_full') return 'budget_exhausted';
  return 'check_error';
}

// One entry list per catalog view, shared by every call that waits for a slot (a view does not change).
const entryLists = new WeakMap<CatalogView, CatalogEntry[]>();
function entriesOf(view: CatalogView): CatalogEntry[] {
  let entries = entryLists.get(view);
  if (!entries) {
    entries = view.entries();
    entryLists.set(view, entries);
  }
  return entries;
}

const tableBasis = (table: unknown): unknown => (typeof table === 'object' && table !== null ? (table as { basis?: unknown }).basis : undefined);

export async function runCheck(declaration: CheckDeclaration, bindings: CheckBindings): Promise<CheckOutcome[]> {
  const name = declaration.id ?? declaration.interpreter ?? declaration.function?.module ?? '检查';
  const basis = hasBasis(declaration.basis) || (declaration.interpreter !== undefined && hasBasis(tableBasis(bindings.table)));
  // The tier on an error outcome is inert (a tier reaches a layer only with a code): fixed advisory, never guessed
  // from a basis. Publication requires every check to declare its tier (checks.tier_missing); there is no fallback.
  const inert: OutcomeBase = { tier: 'advisory', grounds: [] };
  if ((declaration.interpreter === undefined) === (declaration.function === undefined)) {
    return [unknown(inert, 'check_error', `检查 ${name} 的声明要么用核心解释器，要么用包内函数`)];
  }
  if (declaration.tier === 'blocking' && !basis) {
    return [unknown({ tier: 'blocking', grounds: [] }, 'check_error', `检查 ${name} 声明为阻断档，却没有写明所依据的验收合同条款（basis，C05 R[1]）`)];
  }
  if (declaration.interpreter !== undefined) {
    // A declaration without tier leaves the table's own tier to the interpreter (tierOf, C05 R[1]).
    const interpreter = getInterpreter(declaration.interpreter);
    if (!interpreter) return [];
    const outcomes = await interpreter.run({
      interpreter: interpreter.id,
      table: bindings.table,
      tier: declaration.tier,
      subject: bindings.subject,
      catalog: bindings.catalog,
      sources: bindings.sources,
      context: bindings.context,
    });
    return outcomes.map(o => o.verdict === 'unknown' && !o.missing ? {...o, missing: o.statement} : o);
  }
  if (declaration.tier === undefined) {
    // A pack function without a declared tier is a pack defect (publication refuses it, checks.tier_missing): do not
    // run it and do not guess one. Unchecked with check_error (attribution producer_error by reason, V04); the admin
    // log gets the missing-tier detail.
    const detail = `检查 ${name} 没有声明档位（tier）：发布时应被拒绝（checks.tier_missing），不猜档`;
    try {
      bindings.onError?.(new Error(detail), name);
    } catch {
      // The log must not change the outcome.
    }
    return [unknown(inert, 'check_error', detail)];
  }
  const base: OutcomeBase = { tier: declaration.tier, grounds: [] };
  const fn = declaration.function as { module: string; export?: string };
  const pack = bindings.context.pack;
  // Fail closed: without the pack's name its codes cannot be checked against its namespace.
  if (typeof pack !== 'string' || pack === '') return [unknown(base, 'missing_input', `检查 ${name} 是包内函数，但没有给出包名（context.pack），无法核对它给出的码`)];
  if (bindings.packDir === undefined) return [unknown(base, 'missing_input', `检查 ${name} 是包内函数，但没有给出解包后的包目录`)];
  const report = (error: unknown): void => {
    try {
      bindings.onError?.(error, name);
    } catch {
      // The log must not change the outcome.
    }
  };
  const input: PackCheckInput = {
    check: declaration.id ?? null,
    table: bindings.table ?? null,
    subject: bindings.subject,
    context: bindings.context,
    sources: bindings.sourceTexts ?? {},
    unread_sources: bindings.unreadSources ?? [],
    ...(declaration.catalogEntries && bindings.catalog ? { catalog: entriesOf(bindings.catalog) } : {}),
  };
  try {
    const result = await (bindings.functionRunner ?? callPackFunction)({ packDir: bindings.packDir, module: fn.module, export: fn.export }, input, declaration.limits, bindings.sandbox);
    const parsed = Outcomes.safeParse(result.output);
    if (!parsed.success) return [unknown(base, 'check_error', `包内函数 ${name} 的输出不是 check-outcome@1 数组`, { data: { issues: parsed.error.issues.slice(0, 5).map((i) => i.message) } })];
    const problem = outcomeProblems(parsed.data, pack);
    if (problem) return [unknown(base, 'check_error', `包内函数 ${name} 的输出无效：${problem}`)];
    if (parsed.data.length === 0) return [unknown(base, 'check_error', `包内函数 ${name} 没有给出结果`)];
    return withTier(parsed.data, base.tier, basis);
  } catch (error) {
    report(error);
    if (error instanceof SandboxError) return [unknown(base, sandboxReason(error), `包内函数 ${name}：${error.message}`, { data: publicDetail(error, fn.module) })];
    // Invalid calls (input not JSON, input too large, bad limits) carry their own fixed messages; anything else is internal.
    const own = error instanceof TypeError || error instanceof RangeError;
    return [unknown(base, 'check_error', own ? `包内函数 ${name} 无法运行：${error.message}` : `包内函数 ${name} 无法运行（内部错误，详情在管理员日志里）`)];
  }
}
