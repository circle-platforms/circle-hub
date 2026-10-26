// Generates the pack's samples with the real projection and subject builder, so a sample's subject is exactly what the
// checks receive in a run. Regenerate after changing the scheme: node packs/workflow/quality-board/testing/make-samples.ts
// (then pack-files.ts --write). The samples are static author samples; this tool is a test fixture, never published.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { projectItems } from '../functions/project.ts';
import { buildSubject } from '../functions/subject.ts';
import { placementFor, boundView, facetRow, facetViewOf } from '../functions/test-support.ts';
import type { GroupBoard } from '../functions/types.ts';

const PACK_DIR = fileURLToPath(new URL('../', import.meta.url));
const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };

function subjectOf(rows: Parameters<typeof facetViewOf>[0], options: { parameters?: Record<string, unknown>; overrides?: Parameters<typeof facetViewOf>[1] } = {}) {
  const parameters = options.parameters ?? {};
  const projected = projectItems({ inputs: [boundView('facets', facetViewOf(rows, options.overrides)), placementFor(facetViewOf(rows, options.overrides))], parameters, context: { ...CONTEXT, parameters } });
  if ('error' in projected) throw new Error(`projection refused: ${projected.error.code}`);
  const items = projected.items.map((it) => ({ id: it.id, label: it.label, location: `src:${it.location.source}/json@1/${it.location.selector}`, fields: it.fields }));
  return buildSubject({ applies: 'run', items, context: { ...CONTEXT, parameters, groups: projected.groups ?? [] } });
}

async function write(dir: string, name: string, sample: unknown): Promise<void> {
  await writeFile(join(PACK_DIR, 'samples', dir, `${name}.json`), `${JSON.stringify(sample, null, 2)}\n`);
}

async function main(): Promise<void> {
  // Positive of board and thresholds: one group within every threshold (20 cases: 1 missing, 1 vague, 1 negative).
  const within = subjectOf([
    facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: false }, 1),
    facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: true, negative: false }, 1),
    facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: true }, 1),
    facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 17),
  ]);
  const wf=within.items[0].fields as GroupBoard;wf.quality={judged:19,unjudged:1,conflicted:0,sources:[]};wf.counts.vague=0;wf.ratios.vague={num:0,den:19};wf.display.vague=0;
  await write('positive', 'board-with-metrics', {
    id: 'board_with_metrics',
    source: 'author',
    check: 'board',
    note: '合成样例：一个分组的指标按定义算出（20 个用例：无期望 1、含糊期望 1、负面 1），总是记支持，指标写在结论数据里',
    subject: within,
    expect: [{ verdict: 'support', item: '10.6.1/SSL', tier: 'advisory' }],
  });
  await write('positive', 'within-thresholds', {
    id: 'within_thresholds',
    source: 'author',
    check: 'thresholds',
    note: '合成样例：已判断 19 个、含糊 0 个；无期望和负面各 5.0%——等于上限不算越界，高于下限，记支持（提示档）',
    subject: within,
    expect: [{ verdict: 'support', item: '10.6.1/SSL', tier: 'advisory' }],
  });

  // Negative of board: the frozen counts contradict the definitions (more missing than cases).
  const inconsistent = subjectOf([facetRow({ line: '10.6.1', module: 'HA', has_expected: false, vague_expected: false, negative: false }, 3)]);
  (inconsistent.items[0].fields as GroupBoard).counts.missing = 5;
  await write('negative', 'counts-inconsistent', {
    id: 'counts_inconsistent',
    source: 'author',
    check: 'board',
    note: '合成样例：分组的无期望结果数（5）多于用例总数（3），被判对象自相矛盾，指标不可信，记不通过（提示档）',
    subject: inconsistent,
    expect: [{ verdict: 'refute', code: 'quality-board.counts_inconsistent', item: '10.6.1/HA', tier: 'advisory' }],
  });

  // Negative of thresholds: one group over the missing maximum and under the negative minimum at once.
  const exceeded = subjectOf([
    facetRow({ line: '10.6.1', module: 'WebUI', has_expected: false, vague_expected: false, negative: false }, 4),
    facetRow({ line: '10.6.1', module: 'WebUI', has_expected: true, vague_expected: true, negative: false }, 3),
    facetRow({ line: '10.6.1', module: 'WebUI', has_expected: true, vague_expected: false, negative: false }, 3),
  ]);
  const ef=exceeded.items[0].fields as GroupBoard;ef.quality={judged:6,unjudged:4,conflicted:0,sources:[]};ef.counts.vague=3;ef.ratios.vague={num:3,den:6};ef.display.vague=0.5;
  await write('negative', 'thresholds-exceeded', {
    id: 'thresholds_exceeded',
    source: 'author',
    check: 'thresholds',
    note: '合成样例：无期望结果占 40.0% 超过上限 5.0%，已判断 6 个中含糊 3 个占 50.0% 超过上限 5.0%，负面用例占 0.0% 低于下限 2.0%——一个分组三个提示档的不通过',
    subject: exceeded,
    expect: [
      { verdict: 'refute', code: 'quality-board.missing_expected', item: '10.6.1/WebUI', tier: 'advisory' },
      { verdict: 'refute', code: 'quality-board.vague_expected', item: '10.6.1/WebUI', tier: 'advisory' },
      { verdict: 'refute', code: 'quality-board.negative_share', item: '10.6.1/WebUI', tier: 'advisory' },
    ],
  });

  // Positive of totals: a consistent view.
  await write('positive', 'totals-consistent', {
    id: 'totals_consistent',
    source: 'author',
    check: 'totals',
    note: '合成样例：合计覆盖整个视图（用例 23 个：无期望 2、含糊期望 1、负面 1），并写明看板只覆盖用例索引收录的用例',
    subject: subjectOf([
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: true }, 2),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: true, negative: false }, 1),
      facetRow({ line: '10.6.1', module: 'HA', has_expected: true, vague_expected: false, negative: false }, 20),
    ]),
    expect: [{ verdict: 'support', tier: 'advisory' }],
  });

  // Negative of totals: an untruncated view whose rows cannot hold its stated total.
  const undercount = subjectOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 3)]);
  (undercount.context.groups[0] as { view: { total: number; truncated: boolean } }).view.total = 100;
  await write('negative', 'total-undercount', {
    id: 'total_undercount',
    source: 'author',
    check: 'totals',
    note: '合成样例：视图声明未截断，各行加起来 3 个用例而声明共 100 个，视图自相矛盾，合计记不通过（提示档）而不是照写',
    subject: undercount,
    expect: [{ verdict: 'refute', code: 'quality-board.total_undercount', tier: 'advisory' }],
  });
}

await main();
console.log('samples written');
