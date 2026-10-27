// The publish check (T02, C05 R[0]): every sample of a workflow pack is run through runCheck with the declared check, its
// table and the sample's subject, sources and catalog, and compared with what the sample expects. A failing sample, or a
// check without a positive and a negative sample, refuses the publication. Counts are reported by source, and a check with
// no sample from outside its author is marked author_samples_only (T02 R[1]).
import { labelOf, type QualifierMark } from '../../../contracts/generated/vocabulary.ts';
import { SAMPLE_SOURCES, type CheckEntry, type PackSample } from '../../../contracts/src/pack.ts';
import type { CheckOutcome } from '../../../contracts/src/tables.ts';
import { buildCatalog, runCheck, sourcesFrom, type CatalogSpec, type CatalogView, type CheckContext, type SandboxOptions } from '../../rules/api.ts';
import { sampleMarks } from './marks.ts';
import { problem, readJsonFile } from './problems.ts';
import type { CheckSamples, LoadedSample, PackProblem, PublishReport, SampleFailure, SamplePolarity, SampleSource, UnsampledCheck, ValidatedPack } from './types.ts';
import { closedSetsOf, effectiveTier } from './validate.ts';

export interface PublishCheckInput {
  pack: ValidatedPack;
  /** The extracted, read-only pack directory; needed when a sample exercises a pack function. */
  packDir: string | null;
  sandbox?: SandboxOptions;
  /** Receives the error behind an unknown outcome (admin log). */
  onError?: (error: unknown, check: string) => void;
}

const AUTHOR_ONLY: QualifierMark = 'author_samples_only';
const POLARITY_TEXT: Readonly<Record<SamplePolarity, string>> = { positive: '正例', negative: '反例' };
/** Samples run at once; the sandbox has its own, smaller pool of children. */
const BATCH = 16;

const zeroSources = (): Record<SampleSource, number> => Object.fromEntries(SAMPLE_SOURCES.map((s) => [s, 0])) as Record<SampleSource, number>;

const clip = (text: string, length = 160): string => (text.length > length ? `${text.slice(0, length)}…` : text);

function describe(o: CheckOutcome): string {
  return `${labelOf('verdict', o.verdict)}${o.code ? ` ${o.code}` : ''}${o.reason ? `（${labelOf('reason', o.reason)}）` : ''}：${clip(o.statement)}`;
}

/** What differs between a sample's expectation and the outcomes: every outcome in order, with the fields it names. */
export function sampleDifferences(sample: PackSample, outcomes: readonly CheckOutcome[]): string[] {
  const out: string[] = [];
  if (outcomes.length === 0) out.push('检查没有给出任何结果（检查没有安装）');
  else if (sample.expect.length !== outcomes.length) out.push(`期望 ${sample.expect.length} 个结果，实际 ${outcomes.length} 个`);
  sample.expect.forEach((e, i) => {
    const o = outcomes[i];
    if (o === undefined) return;
    const n = `第 ${i + 1} 个结果`;
    if (e.verdict !== o.verdict) out.push(`${n}应为${labelOf('verdict', e.verdict)}，实际是${describe(o)}`);
    for (const key of ['code', 'reason', 'tier', 'item'] as const) {
      if (e[key] !== undefined && e[key] !== o[key]) out.push(`${n}的 ${key} 应为 ${e[key]}，实际是 ${o[key] ?? '（无）'}（${describe(o)}）`);
    }
  });
  outcomes.slice(sample.expect.length).forEach((o, k) => out.push(`多出的第 ${sample.expect.length + k + 1} 个结果：${describe(o)}`));
  return out;
}

function tableOf(pack: ValidatedPack, check: CheckEntry): unknown {
  if (check.table === undefined) return undefined;
  const file = pack.directory.files.find((f) => f.path === check.table);
  if (file === undefined) return undefined;
  const json = readJsonFile(file.path, file.bytes);
  return json.ok ? json.value : undefined;
}

/** True when some sample exercises a pack function, which needs the extracted directory and the sandbox. */
export function needsSandbox(pack: ValidatedPack): boolean {
  const d = pack.declarations.kind === 'skill' ? pack.declarations.method : pack.declarations;
  if (!d || d.kind !== 'workflow') return false;
  const functions = new Set(d.checks.checks.filter((c) => c.function !== undefined).map((c) => c.id));
  return pack.samples.some((s) => functions.has(s.sample.check));
}

async function runSample(input: PublishCheckInput, check: CheckEntry, table: unknown, context: CheckContext, loaded: LoadedSample): Promise<string[]> {
  const { sample } = loaded;
  let catalog: CatalogView | undefined;
  // A run binds a catalog only to a check that declares one (validation refuses a sample catalog for any other check).
  if (sample.catalog !== undefined && check.catalog !== undefined) {
    try {
      catalog = buildCatalog(sample.catalog as CatalogSpec);
    } catch (error) {
      return [`样例的 catalog 不是有效的目录（hub/rules 的 CatalogSpec）：${error instanceof Error ? error.message : String(error)}`];
    }
  }
  if (check.function !== undefined && input.packDir === null) return ['检查是包内函数，没有解包后的目录可以运行它'];
  const outcomes = await runCheck(
    {
      id: check.id,
      interpreter: check.interpreter,
      function: check.function === undefined ? undefined : { module: check.function.module, export: check.function.export },
      tier: check.tier,
      basis: check.basis,
      catalogEntries: check.function !== undefined && check.catalog !== undefined,
      ...(check.reads !== undefined ? { reads: check.reads } : {}),
    },
    {
      table,
      subject: sample.subject,
      catalog,
      sources: sourcesFrom(sample.sources ?? {}),
      sourceTexts: sample.sources ?? {},
      unreadSources: sample.unread_sources ?? [],
      context,
      packDir: input.packDir ?? undefined,
      sandbox: input.sandbox,
      onError: input.onError,
    },
  );
  return sampleDifferences(sample, outcomes);
}

/** Runs every sample and reports by check and by source. Product and system packs have no samples: an empty report. */
export async function runPublishCheck(input: PublishCheckInput): Promise<PublishReport> {
  const report: PublishReport = { samples: { total: 0, passed: 0, failed: 0, sources: zeroSources() }, checks: [], failures: [], unsampled: [], warnings: [] };
  const d = input.pack.declarations.kind === 'skill' ? input.pack.declarations.method : input.pack.declarations;
  if (!d || d.kind !== 'workflow') return report;
  const sets = closedSetsOf(d.slots);
  const byId = new Map(d.checks.checks.map((c) => [c.id, c]));
  const tables = new Map(d.checks.checks.map((c) => [c.id, tableOf(input.pack, c)]));
  // The context a run gives the check: the pack id, the first requirement that lists the check, the declared closed sets.
  const contextOf = (check: string): CheckContext => {
    const requirement = d.requirements.requirements.find((r) => r.checks.includes(check))?.key;
    return { pack: input.pack.directory.manifest.id, ...(requirement === undefined ? {} : { requirement }), sets };
  };

  const samples = input.pack.samples;
  const runnable = samples.filter((s) => byId.has(s.sample.check));
  for (let start = 0; start < runnable.length; start += BATCH) {
    const batch = runnable.slice(start, start + BATCH);
    const results = await Promise.all(batch.map((s) => runSample(input, byId.get(s.sample.check) as CheckEntry, tables.get(s.sample.check), contextOf(s.sample.check), s)));
    batch.forEach((s, i) => {
      report.samples.total += 1;
      report.samples.sources[s.sample.source] += 1;
      const differences = results[i];
      if (differences.length === 0) report.samples.passed += 1;
      else {
        report.samples.failed += 1;
        const failure: SampleFailure = { check: s.sample.check, sample: s.sample.id, file: s.file, source: s.sample.source, differences };
        report.failures.push(failure);
      }
    });
  }

  for (const check of d.checks.checks) {
    const own = samples.filter((s) => s.sample.check === check.id);
    const sources = zeroSources();
    for (const s of own) sources[s.sample.source] += 1;
    const positive = own.filter((s) => s.polarity === 'positive').length;
    const negative = own.filter((s) => s.polarity === 'negative').length;
    const entry: CheckSamples = { check: check.id, tier: effectiveTier(check, tables.get(check.id)), positive, negative, sources, marks: sampleMarks(sources) };
    report.checks.push(entry);
    const missing: SamplePolarity[] = [];
    if (positive === 0) missing.push('positive');
    if (negative === 0) missing.push('negative');
    if (missing.length > 0) {
      const unsampled: UnsampledCheck = { check: check.id, tier: entry.tier, missing };
      report.unsampled.push(unsampled);
    }
    if (entry.marks.includes(AUTHOR_ONLY) && own.length > 0) {
      report.warnings.push(problem('publish.author_samples_only', 'checks.json', `检查 ${check.id} 只有作者样例，它支撑的结论标“${labelOf('qualifier_mark', AUTHOR_ONLY)}”`, '把核实运行里的失败条目写成回流反例，或加入外部留存交付的样例（T02 R[1]、R[2]）'));
    }
  }
  return report;
}

/** The problems that refuse a publication: failing samples and checks without both kinds of sample, whatever their tier. */
export function refusalsOf(report: PublishReport, pack: ValidatedPack): PackProblem[] {
  const out: PackProblem[] = report.failures.map((f) =>
    problem('publish.sample_failed', f.file, `样例 ${f.sample}（检查 ${f.check}）不符合它的期望：${f.differences.join('；')}`, '改正检查（表或函数）或者样例的期望；有样例不过就不发布（T02 R[0]）'),
  );
  const declarations=pack.declarations.kind==='skill'?pack.declarations.method:pack.declarations;
  const checks = declarations?.kind === 'workflow' ? declarations.checks.checks : [];
  for (const u of report.unsampled) {
    const k = checks.findIndex((c) => c.id === u.check);
    out.push(
      problem(
        'publish.unsampled',
        'checks.json',
        `检查 ${u.check}（${labelOf('check_tier', u.tier)}档）没有${u.missing.map((m) => POLARITY_TEXT[m]).join('和')}；每条规则带正例与反例，准入时运行，不过不发布`,
        '在 samples/positive/ 和 samples/negative/ 里各放至少一个这个检查的样例（C05 R[0]、T02 R[0]）',
        { field: `/checks/${k}` },
      ),
    );
  }
  return out;
}
