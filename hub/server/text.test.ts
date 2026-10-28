import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
// The text of every tool answer, through the real text functions: synthetic runs of 5, 62, 400 and 3000 items, every answer
// within TEXT_BUDGET and ending with the trace line, the facts first (counts, every requirement's state, every problem), the
// note exactly when something was left out or shortened, ways to read the rest that the server takes (page cursors when it
// pages, as the server does; byte ranges, text@1 lines and record pointers otherwise, followed through the real reference
// resolver and through the server itself), and example calls and skeletons that parse with the tool schemas. What the run
// engine answers start_run with is tested by the engine (hub/runs/engine/start-result.test.ts) and, rendered, through the
// real assembly (hub/server/assemble/testing-real.test.ts).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../contracts/src/claim.ts';
import type { ProtocolError } from '../../contracts/src/common.ts';
import { RunSummary, type ItemProjection, type PackSummary, type SlotSchema } from '../../contracts/src/run.ts';
import { Submission } from '../../contracts/src/submission.ts';
import {
  GetNodesInput,
  GetNodesOutput,
  ListTaskPacksOutput,
  ResolveReferenceOutput,
  StartRunInput,
  StartRunOutput,
  SubmitResultOutput,
  UploadFileOutput,
} from '../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult, type Partitions, type RequirementResult } from '../../contracts/src/validation.ts';
import type { LoadedWorkflow } from '../ports.ts';
import { canonicalJson, recordDigest, resolveReference, type RecordRead } from '../refs/api.ts';
import { slotSchemaOf } from '../runs/engine/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { TEXT_BUDGET } from './budget.ts';
import { cursorPosition, fallbackText, pageCursor, pageCursorProblem, startRunExample, submitExample, toolText, type TextContext } from './text.ts';

// ---------------------------------------------------------------- synthetic answers, checked against the contracts

const H = (c: string): string => c.repeat(64);
const RUN = 'run_0123456789abcdefghjkmnpqrs';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACE_2 = '0af7651916cd43dd8448eb211c80319c';
const SUBJECT = `src:${H('b')}`;
const RUN_RECORD = `rec:${H('f')}`;
const RESULT_RECORD = `rec:${H('9')}`;
const NOTE = /^部分：/;
const SIZES = [5, 62, 400, 3000];
const PAGING: TextContext = { paging: true };

/** A small seeded generator, so that a failing property run can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROBES = ['literal_issue', 'coverage_gap', 'differentiation_gap', 'edge_case_gap', 'negative_gap', 'block_structure_mismatch', 'self_contradiction'];
const RANKS = ['critical', 'major', 'minor'];

/** The slot schema the engine hands out for a toy review pack (slotSchemaOf reads only these parts of the workflow). */
function toySlots(): SlotSchema {
  const workflow = {
    slots: {
      schema: 'slots@1',
      item: { findings: { codes: PROBES.map((code) => ({ code, label: `${code}（合成）` })), ranks: RANKS.map((code) => ({ code, label: `${code}级` })), min: 0, evidence: true } },
      run: { level: { codes: [{ code: 'level', label: '等级' }], ranks: ['P0', 'P1', 'P2'].map((code) => ({ code, label: `等级 ${code}` })), min: 1, max: 1 } },
    },
    requirements: [
      { key: 'findings', name: '发现', description: '逐条用例的发现（合成）' },
      { key: 'level', name: '等级', description: '整份的等级（合成）' },
    ],
    manifest: { files: [{ path: 'slots.schema.json', sha256: H('a'), size: 10 }] },
  } as unknown as LoadedWorkflow;
  return slotSchemaOf(workflow)!;
}

const REQUIREMENTS: RunSummary['requirements'] = [
  { key: 'structure', name: '结构', description: '结构（合成）', layers: ['static'], done_rule: 'bookkeeping', accepted_producer: 'fact', repair_rounds: 0, rules: [], run_interpreters: [] },
  { key: 'catalog', name: '命令目录', description: '命令目录（合成）', layers: ['static', 'dynamic'], done_rule: 'gating', accepted_producer: 'fact', repair_rounds: 1, rules: [], run_interpreters: [] },
  { key: 'findings', name: '发现', description: '发现（合成）', layers: ['static'], done_rule: 'bookkeeping', accepted_producer: 'independent_judgment', repair_rounds: 2, rules: [], run_interpreters: [] },
];
const FACTS_ONLY = REQUIREMENTS.filter((r) => r.accepted_producer === 'fact');

function items(n: number, label: (i: number) => string = (i) => `合成用例 ${i}`): ItemProjection[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc7:n${i}`,
    label: label(i),
    summary: `优先级 ${i % 3}，期望结果 ${i % 4} 条`,
    location: `${SUBJECT}/kityminder@1/n/n${i}`,
    fields: { priority: i % 3, expected: ['期望'] },
  }));
}

function basisClaim(): Claim {
  return {
    statement: { text: '按包规则选定版本线最新的已发布构建', data: { field: 'build', value: 'b-2.1-7' } },
    qualifier: { nature: 'fact', provenance: 'projected', basis_rank: 'rule_over_observation', marks: [] },
    grounds: [SUBJECT],
    warrant: { producer: 'function', id: 'runs.newest_released@1' },
    validity: { status: 'valid', bound: [H('d')], premises: [] },
  };
}

function runOf(list: ItemProjection[], options: { production?: boolean; instructions?: string } = {}): RunSummary {
  return RunSummary.parse({
    run: RUN,
    pack: options.production ? 'toy-locate@1.0.0' : 'toy-review@1.0.0',
    pack_digest: H('c'),
    product: 'meadow',
    version: '2.1',
    build: 'b-2.1-7',
    target_basis: [basisClaim()],
    root: H('d'),
    sources: [
      { reference: SUBJECT, role: 'subject', slot: 'map', external: 'toy:mindmap:docq7@1', media_type: 'application/json', label: '分区浇灌用例' },
      { reference: `src:${H('e')}`, role: 'expected', external: 'toy:manual:zone@1', media_type: 'text/markdown', label: '分区命令手册' },
    ],
    requirements: options.production ? FACTS_ONLY : REQUIREMENTS,
    items: list,
    ...(options.production ? {} : { slots: toySlots() }),
    instructions: options.instructions ?? '# 规程（合成）\n\n1. 逐条读用例。\n2. 每条发现都要带位置和逐字引文。\n3. 提交前用 resolve_reference 预览。',
    instructions_digest: H('1'),
    started_at: '2026-10-22T08:00:00.000Z',
  });
}

const startAnswer = (run: RunSummary, extra: Record<string, unknown> = {}) => StartRunOutput.parse({ call_result: 'ok', errors: [], run, trace: TRACE, ...extra });

function claim(item: string, requirement: string, text: string, extra: Partial<Claim> = {}): Claim {
  return {
    item,
    requirement,
    pointer: '/items/0/slots/findings/0',
    statement: { text, code: 'literal_issue', rank: 'major' },
    qualifier: { nature: 'judgment', provenance: 'declared', basis_rank: 'judgment', source_role: 'subject', marks: ['semantics_unasserted'] },
    grounds: [`${SUBJECT}/kityminder@1/n/n0`],
    warrant: { producer: 'model', id: 'scripted-model@test' },
    resolution: 'resolved',
    validity: { status: 'valid', bound: [H('c'), H('d')], premises: [] },
    ...extra,
  };
}

const fact = (id: string, requirement: string, text: string, code?: string): Claim => ({
  item: id,
  requirement,
  statement: { text, verdict: code === undefined ? 'support' : 'refute', ...(code !== undefined ? { code } : {}) },
  qualifier: { nature: 'fact', provenance: 'projected', basis_rank: 'rule_over_observation', source_role: 'subject', marks: [] },
  grounds: [`${SUBJECT}/kityminder@1/n/${id.slice(5)}`],
  warrant: { producer: 'function', id: 'structure@1', independence: 'judge_not_author' },
  validity: { status: 'valid', bound: [H('c')], premises: [] },
});

/** A validation result over given partitions and errors, with one cross-item fact. */
function resultWith(partitions: Record<string, ItemResult[]>, errors: ProtocolError[] = [], cross: Claim[] | null = null): ValidationResult {
  partitions=structuredClone(partitions);
  // New synthetic results carry real-shaped recovery metadata; legacy reads have their own tests.
  for(const list of Object.values(partitions))for(const item of list)for(const requirement of item.requirements)for(const layer of requirement.layers){
    if(layer.terminal==='unchecked'||layer.terminal==='incomplete'||layer.terminal==='no_verdict'||layer.terminal==='not_run'){
      layer.missing??='合成条目缺少完整观察';
      layer.exit??={action:'request',request_kind:'clarification',audience:{user:'usr_00000000000000000000000001'},due:'2026-10-25T00:00:00.000Z'};
    }
  }
  const total = Object.values(partitions).reduce((n, list) => n + list.length, 0);
  return ValidationResult.parse({
    schema: 'validation@1',
    run: RUN,
    submission: H('5'),
    acceptance: 'accepted',
    errors,
    rounds: { used: 0, max: 2 },
    partitions: { delivered: [], rejected: [], quarantined: [], incomplete: [], ...partitions },
    cross_item: cross ?? [
      {
        requirement: 'overview',
        statement: { text: `共 ${total} 个用例`, verdict: 'support', data: { cases: total } },
        qualifier: { nature: 'fact', provenance: 'projected', basis_rank: 'rule_over_observation', marks: [] },
        grounds: [SUBJECT],
        warrant: { producer: 'function', id: 'toy-locate.overview@1.0.0' },
        validity: { status: 'valid', bound: [H('c')], premises: [] },
      },
    ],
    coverage: { complete: true, examined: total, total },
    locks: { pack: 'toy-review@1.0.0', pack_digest: H('c'), root: H('d') },
    trace: TRACE,
  });
}

/**
 * A validation result over the items: every tenth incomplete (not covered), every tenth (offset 7) delivered with an unknown
 * static terminal, every tenth (offset 3) delivered with a violation, every 23rd (offset 5) rejected, the rest delivered with
 * `claims` findings each.
 */
function resultOf(list: ItemProjection[], options: { claims?: number; claimText?: (i: number, k: number) => string; production?: boolean } = {}): ValidationResult {
  const claims = options.claims ?? 1;
  const partitions: Record<string, ItemResult[]> = { delivered: [], rejected: [], quarantined: [], incomplete: [] };
  list.forEach((item, i) => {
    const base = { item: item.id, label: item.label, location: item.location };
    const findings = (): RequirementResult => ({
      requirement: 'findings',
      layers: [{ layer: 'static', terminal: 'judgment' }],
      status: 'satisfied',
      claims: Array.from({ length: claims }, (_, k) => claim(item.id, 'findings', options.claimText?.(i, k) ?? `第 ${k} 条发现：期望结果缺失`)),
    });
    const judged = options.production ? [] : [findings()];
    if (i % 10 === 9) {
      partitions.incomplete.push({
        ...base,
        reason: 'not_covered',
        requirements: [
          { requirement: 'structure', layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', claims: [fact(item.id, 'structure', '结构完整')] },
          ...(options.production ? [] : [{ requirement: 'findings', layers: [{ layer: 'static', terminal: 'incomplete', reason: 'not_covered', missing: '未覆盖条目的合成产物；下一步：合成运行者补交后重核', exit: { action: 'request' as const, request_kind: 'repair' as const, audience: { user: 'usr_' + '1'.repeat(26) }, due: '2026-01-04T00:00:00.000Z' }, attribution: 'author_input' }], status: 'pending', claims: [] } satisfies RequirementResult]),
        ],
      });
    } else if (i % 10 === 7) {
      partitions.delivered.push({
        ...base,
        requirements: [{ requirement: 'structure', layers: [{ layer: 'static', terminal: 'unchecked', reason: 'check_error', missing: '合成结构检查的可用判定结果；下一步：修复合成检查后重核', exit: { action: 'request' as const, request_kind: 'repair' as const, audience: { user: 'usr_' + '1'.repeat(26) }, due: '2026-01-04T00:00:00.000Z' }, attribution: 'producer_error' }], status: 'pending', claims: [] }, ...judged],
      });
    } else if (i % 23 === 5) {
      partitions.rejected.push({
        ...base,
        code: 'core.structure.required_empty',
        requirements: [
          { requirement: 'structure', layers: [{ layer: 'static', terminal: 'violation', code: 'core.structure.required_empty', tier: 'blocking', attribution: 'author_input' }], status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch', claims: [fact(item.id, 'structure', '必填字段为空', 'core.structure.required_empty')] },
          ...judged,
        ],
      });
    } else if (i % 10 === 3) {
      partitions.delivered.push({
        ...base,
        requirements: [
          { requirement: 'structure', layers: [{ layer: 'static', terminal: 'violation', code: 'core.structure.duplicate_key', tier: 'advisory', attribution: 'author_input' }], status: 'satisfied', claims: [fact(item.id, 'structure', '用例重复', 'core.structure.duplicate_key')] },
          ...judged,
        ],
      });
    } else {
      partitions.delivered.push({ ...base, requirements: [{ requirement: 'structure', layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', claims: [fact(item.id, 'structure', '结构完整')] }, ...judged] });
    }
  });
  const uncovered = list.filter((_, i) => i % 10 === 9).length;
  return resultWith(partitions, uncovered > 0 ? [{ code: 'core.coverage.shortfall', message: `提交没有覆盖 ${uncovered} 个条目`, fix: '逐个处理或声明跳过', path: '/items', rounds_left: 1 }] : []);
}

const submitAnswer = (result: ValidationResult, trace = TRACE) =>
  SubmitResultOutput.parse(
    result.acceptance === 'accepted'
      ? { call_result: 'ok', acceptance: 'accepted', errors: result.errors, result, counts: partitionCountsOf(result.partitions), trace }
      : { call_result: 'error', acceptance: 'not_accepted', errors: result.errors, result, trace },
  );

const contentAnswer = (reference: string, text: string, readTier: 'model_readable' = 'model_readable') =>
  GetNodesOutput.parse({ call_result: 'ok', errors: [], content: { reference, read_tier: readTier, readable: true, text }, trace: TRACE });

const linesOf = (text: string): string[] => text.split('\n');
const indexOf = (lines: string[], test: (line: string) => boolean): number => lines.findIndex(test);
const itemIdsOf = (text: string): string[] => linesOf(text).flatMap((line) => /^- (doc7:n[0-9]+) \| /.exec(line)?.[1] ?? []);

/** The note of a text, checked: at most one, and then just before the trace line, which ends every text. */
function noteOf(text: string, trace = TRACE): string | null {
  const lines = linesOf(text);
  assert.equal(lines.at(-1), `追踪 ${trace}`, 'the trace line ends the text');
  const notes = lines.filter((l) => NOTE.test(l));
  assert.ok(notes.length <= 1, 'at most one note');
  if (notes.length === 0) return null;
  assert.equal(lines.at(-2), notes[0], 'the note comes just before the trace line');
  return notes[0];
}

/** The JSON object that starts at `at` in `text`. */
function jsonAt(text: string, at: number): unknown {
  for (let end = text.indexOf('}', at); end >= 0; end = text.indexOf('}', end + 1)) {
    try {
      return JSON.parse(text.slice(at, end + 1));
    } catch {
      // not the end of the object yet
    }
  }
  throw new Error(`no JSON object at ${at}: ${text.slice(at, at + 80)}`);
}

/** The get_nodes call the note gives after `marker`, parsed and checked against the tool's input schema; null without one. */
function nextCall(text: string, marker: string): z.infer<typeof GetNodesInput> | null {
  const note = noteOf(text);
  if (note === null) return null;
  const at = note.indexOf(`${marker}get_nodes `);
  if (at < 0) return null;
  return GetNodesInput.parse(jsonAt(note, at + marker.length + 'get_nodes '.length));
}

/** Every get_nodes call in a text. */
function callsIn(text: string): z.infer<typeof GetNodesInput>[] {
  const out: z.infer<typeof GetNodesInput>[] = [];
  for (let at = text.indexOf('get_nodes {'); at >= 0; at = text.indexOf('get_nodes {', at + 1)) {
    const value = jsonAt(text, at + 'get_nodes '.length) as Record<string, unknown>;
    // Calls with placeholders in angle brackets are templates for the reader to fill.
    if (JSON.stringify(value).includes('<')) continue;
    out.push(GetNodesInput.parse(value));
  }
  return out;
}

/** Every page of a reference's content, following the cursors the notes give (the server pages). */
function pages(reference: string, text: string, first: string | null = null): string[] {
  const out: string[] = [];
  let cursor = first;
  for (let i = 0; i < 3000; i++) {
    const page = toolText('get_nodes', contentAnswer(reference, text), { ...PAGING, cursor });
    out.push(page);
    const call = nextCall(page, '下一页：');
    if (call === null) return out;
    assert.equal(call.reference, reference);
    assert.ok(call.cursor !== undefined && cursorPosition(reference, call.cursor) !== null);
    cursor = call.cursor ?? null;
  }
  throw new Error('paging did not end');
}

/** The content lines a page of a source shows: between the 原文 line (and a 接上页 line) and the note or the trace. */
function shownSource(page: string): string[] {
  const lines = linesOf(page);
  let at = indexOf(lines, (l) => l.startsWith('原文（')) + 1;
  if (lines[at]?.startsWith('（接上页：')) at++;
  const end = lines.length - (NOTE.test(lines.at(-2) ?? '') ? 2 : 1);
  return lines.slice(at, end);
}

/** Checks that pages of a source show `text` verbatim, each continuing where the last stopped, and together all of it. */
function reassembles(all: readonly string[], text: string): void {
  let at = 0;
  for (const page of all) {
    const shown = shownSource(page).join('\n');
    assert.ok(text.startsWith(shown, at), `a page continues at ${at}: ${shown.slice(0, 60)}`);
    at += shown.length;
    if (text[at] === '\n') at++;
  }
  assert.equal(at, text.length, 'the pages read the text exactly once, to its end');
}

/** A reader of sources and records in memory, as hub/refs resolves them for the server. */
function memory(sources: Map<string, { bytes: Uint8Array; mediaType: string }>, records: Map<string, RecordRead> = new Map()) {
  return {
    reader: { user: 'usr_0123456789abcdefghjkmnpqrs', role: 'user' as const },
    parsers: createDefaultRegistry(),
    sources: { read: (sha: string) => (sources.has(sha) ? { bytes: sources.get(sha)!.bytes, mediaType: sources.get(sha)!.mediaType, size: sources.get(sha)!.bytes.length, readTier: 'model_readable' as const } : null) },
    records: { read: (digest: string) => records.get(digest) ?? null },
    consumer: 'model' as const,
  };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Reads a reference through the real resolver and follows the ways the notes give without page cursors (the server does
 * not page): every page within the budget, no cursor offered, the next reference resolves. Returns the pages.
 */
async function follow(context: ReturnType<typeof memory>, reference: string, marker: string): Promise<string[]> {
  const out: string[] = [];
  let next: string = reference;
  for (let i = 0; i < 3000; i++) {
    const resolved = await resolveReference(next, context);
    assert.ok(resolved.resolved, `${next.slice(0, 120)} resolves: ${resolved.resolved ? '' : resolved.message}`);
    const page = toolText('get_nodes', contentAnswer(resolved.reference, resolved.text!));
    withinBudget(page, 'a page');
    assert.ok(callsIn(page).every((call) => call.cursor === undefined), 'no page cursor without paging');
    out.push(page);
    const call = nextCall(page, marker);
    if (call === null) return out;
    next = call.reference!;
  }
  throw new Error('reading did not end');
}

function withinBudget(text: string, what: string): void {
  assert.ok(text.length <= TEXT_BUDGET, `${what}: ${text.length} characters, over the budget ${TEXT_BUDGET}`);
}

/** The example submission with its lists filled by a test double: one finding per slot list and the cross-item level. */
function filled(example: string, run: RunSummary): Submission {
  const value = JSON.parse(example) as { items: { slots?: Record<string, unknown[]> }[]; cross_item?: unknown[] };
  for (const item of value.items) {
    for (const key of Object.keys(item.slots ?? {})) {
      item.slots![key] = [{ text: '期望结果缺失', code: 'coverage_gap', rank: 'major', location: run.items[0].location, grounds: [run.items[0].location] }];
    }
  }
  if (value.cross_item !== undefined) value.cross_item.push({ nature: 'judgment', statement: '整份等级 P2', code: 'level', rank: 'P2', grounds: [SUBJECT] });
  return Submission.parse(value);
}

// ---------------------------------------------------------------- start_run

describe('start_run text', () => {
  for (const n of SIZES) {
    test(`a run of ${n} items: within the budget, the facts first, items as id | label | summary, the note exactly when items are left out`, () => {
      const run = runOf(items(n));
      const text = toolText('start_run', startAnswer(run), { ...PAGING, record: RUN_RECORD, unavailable: [{ external: 'toy:broken:offline', role: 'expected' }] });
      withinBudget(text, `start_run ${n}`);
      const lines = linesOf(text);
      assert.equal(lines[0], `运行 ${RUN}：任务包 toy-review@1.0.0，条目 ${n} 个，要求项 3 个`);
      assert.equal(lines[1], '产品 meadow，版本 2.1，构建 b-2.1-7');
      assert.equal(lines[2], `锁定的知识根 ${H('d')}`);
      const order = ['规程：', '要求项：', '来源：', '条目（', '槽位模式', '示例 submit_result'].map((head) => indexOf(lines, (l) => l.startsWith(head)));
      assert.ok(order.every((at, i) => at > 2 && (i === 0 || at > order[i - 1])), `the order of the parts: ${order.join(', ')}`);
      assert.equal(lines[order[0] + 1], '# 规程（合成）', 'the procedure as the pack wrote it');
      assert.ok(lines.includes('- catalog 命令目录：接受的生产者 事实；判定层 静态、动态；门禁型；修复轮数 1；规则 无；运行内表的已裁定解释器 无'));
      assert.ok(lines.includes('- findings 发现：接受的生产者 独立判断；判定层 静态（动态：本层不适用）；记账型；修复轮数 2；规则 无；运行内表的已裁定解释器 无'));
      assert.ok(lines.includes(`- 被判对象 ${SUBJECT}（输入 map，外部对象 toy:mindmap:docq7@1，application/json，分区浇灌用例）`));
      assert.ok(lines.includes('- 数据缺口：期望来源 toy:broken:offline：对你不可用'), 'a gap is named as a gap');
      const shown = itemIdsOf(text);
      assert.deepEqual(shown, items(n).slice(0, shown.length).map((it) => it.id), 'a prefix of the items in order');
      assert.ok(lines.includes('- doc7:n0 | 合成用例 0 | 优先级 0，期望结果 0 条'), 'id | label | summary');
      assert.ok(lines.includes(`位置：每个条目的位置是 ${SUBJECT}/kityminder@1/n/ 加上编号里第一个冒号后面的部分，例如 doc7:n0 的位置是 ${SUBJECT}/kityminder@1/n/n0`));
      assert.ok(!text.includes('"fields"') && !text.includes('expected'), 'the fields stay in structuredContent');
      const note = noteOf(text);
      const cut = shown.length < n;
      assert.equal(note !== null, cut, 'the note appears if and only if something was cut');
      if (n <= 62) assert.equal(shown.length, n, 'a short list is shown whole');
      if (cut) {
        assert.ok(note!.includes(`条目 ${n - shown.length} 个（第 ${shown.length + 1} 到第 ${n} 个）`));
        const call = nextCall(text, '条目：')!;
        assert.deepEqual(call, { reference: `${RUN_RECORD}#/items`, cursor: pageCursor(`${RUN_RECORD}#/items`, shown.length) });
      }
    });
  }

  test('the example skeleton parses with Submission once its lists are filled, and the slot records validate against the slot schema', () => {
    const run = runOf(items(62));
    const text = toolText('start_run', startAnswer(run));
    const lines = linesOf(text);
    const example = lines[indexOf(lines, (l) => l.startsWith('示例 submit_result')) + 1];
    assert.equal(example, submitExample(run));
    const raw = JSON.parse(example) as { run: string; items: { item: string; handling: string; slots: Record<string, unknown[]> }[]; cross_item: unknown[] };
    assert.equal(raw.run, RUN);
    assert.deepEqual(raw.items, [
      { item: 'doc7:n0', handling: 'handled', slots: { findings: [] } },
      { item: 'doc7:n1', handling: 'handled', slots: { findings: [] } },
    ]);
    assert.deepEqual(raw.cross_item, [], 'the slots declare a cross-item requirement');
    assert.ok(Submission.safeParse(raw).success, 'the skeleton itself parses');
    const submission = filled(example, run);
    const slotRecord = z.fromJSONSchema(run.slots!.schema as Parameters<typeof z.fromJSONSchema>[0]);
    for (const item of submission.items) assert.ok(item.handling === 'handled' && slotRecord.safeParse(item.slots).success, 'a filled slot record matches the slot schema');
    assert.ok(!slotRecord.safeParse({ findings: [{ text: 'x', code: 'nope', rank: 'major', grounds: [SUBJECT] }] }).success, 'and the schema still refuses a wrong code');
  });

  test('the slot schema is compact: every key, closed set, bound and rule, in a fraction of the JSON Schema', () => {
    const run = runOf(items(5));
    const text = toolText('start_run', startAnswer(run));
    const lines = linesOf(text);
    const at = indexOf(lines, (l) => l.startsWith('槽位模式'));
    assert.match(lines[at], /^槽位模式（sha256 a{64}）：/);
    const schema = lines.slice(at, indexOf(lines, (l) => l.startsWith('示例 submit_result'))).join('\n');
    for (const code of [...PROBES, ...RANKS, 'level', 'P0', 'P2']) assert.ok(schema.includes(code), `the closed set member ${code}`);
    for (const field of ['text（必填）', 'code（必填）', 'rank（必填）', 'location', 'grounds', 'quotes: [{reference: string, text: string}]', 'commands: [{command: string, present?: boolean}]', '至少给出 grounds、quotes 之一', '至少 0 条', '1 to 1 entries in one submission']) {
      assert.ok(schema.includes(field), `the compact schema says ${field}`);
    }
    assert.ok(schema.length * 3 < JSON.stringify(run.slots!.schema).length, `${schema.length} characters against ${JSON.stringify(run.slots!.schema).length}`);
  });

  test('items cut from start_run are read page by page from the run record when the server pages, each exactly once', () => {
    const list = items(3000, (i) => `合成用例 ${i}${i % 97 === 0 ? ' 长标题'.repeat(300) : ''}`);
    const run = runOf(list);
    const text = toolText('start_run', startAnswer(run), { ...PAGING, record: RUN_RECORD });
    const shown = itemIdsOf(text);
    const call = nextCall(text, '条目：')!;
    const reference = `${RUN_RECORD}#/items`;
    const rest = pages(reference, canonicalJson(run.items), call.cursor ?? null);
    for (const page of rest) withinBudget(page, 'a page of run items');
    const ids = [...shown, ...rest.flatMap(itemIdsOf)];
    assert.deepEqual(ids, list.map((it) => it.id), 'start_run and the pages show every item once, in order');
    assert.match(rest[0], new RegExp(`^内容 ${reference.replace(/[$^*+?.()|[\]{}]/g, '\\$&')}：模型可读`));
  });

  test('without paging the items left out are read one by one from the run record; without the record, on the console page', () => {
    const run = runOf(items(3000));
    const byPointer = toolText('start_run', startAnswer(run), { record: RUN_RECORD });
    const shown = itemIdsOf(byPointer).length;
    assert.deepEqual(nextCall(byPointer, '条目：逐个读 '), { reference: `${RUN_RECORD}#/items/${shown}` });
    assert.ok(callsIn(byPointer).every((call) => call.cursor === undefined), 'no cursor is offered to a server that does not page');
    const text = toolText('start_run', startAnswer(run));
    assert.match(noteOf(text)!, /条目：在控制台运行页 \/console\/runs\/run_0123456789abcdefghjkmnpqrs 查看/);
    assert.ok(!text.includes('提交时没有覆盖的条目'), 'no advice to submit just to learn the items (it would cost repair rounds)');
  });

  test('a procedure longer than the budget is cut by whole lines and continues from the run record', () => {
    const procedure = Array.from({ length: 2000 }, (_, i) => `第 ${i + 1} 步：逐条核对用例里的命令与参数。`).join('\n');
    const text = toolText('start_run', startAnswer(runOf(items(5), { instructions: procedure })), { ...PAGING, record: RUN_RECORD });
    withinBudget(text, 'long procedure');
    const lines = linesOf(text);
    assert.ok(lines.includes('- doc7:n4 | 合成用例 4 | 优先级 1，期望结果 0 条'), 'the items keep their place');
    const shownSteps = lines.filter((l) => /^第 \d+ 步：/.test(l)).length;
    assert.ok(shownSteps > 0 && shownSteps < 2000);
    const call = nextCall(text, '规程：')!;
    assert.deepEqual(call, { reference: `${RUN_RECORD}#/instructions`, cursor: pageCursor(`${RUN_RECORD}#/instructions`, shownSteps) }, 'the cursor names the first line left out');
    assert.ok(noteOf(text)!.includes(`规程 ${2000 - shownSteps} 行（第 ${shownSteps + 1} 到第 2000 行）`), 'the note counts on from the first part');
    const rest = pages(`${RUN_RECORD}#/instructions`, procedure, call.cursor ?? null);
    const continued = rest.flatMap((p) => linesOf(p).filter((l) => /^第 \d+ 步：/.test(l)));
    assert.equal(shownSteps + continued.length, 2000);
    assert.equal(continued[0], `第 ${shownSteps + 1} 步：逐条核对用例里的命令与参数。`);
  });

  test('an error answer names its codes and every fix within the budget, long messages shortened and named', () => {
    const errors: ProtocolError[] = Array.from({ length: 20 }, (_, i) => ({ code: 'SUBMISSION_SCHEMA_VIOLATION', message: `参数 ${i} 不对：${'很长的说明'.repeat(1000)}`, fix: '按输入模式改正', path: `/inputs/s${i}` }));
    const text = toolText('start_run', StartRunOutput.parse({ call_result: 'error', errors, trace: TRACE }));
    withinBudget(text, 'error answer');
    assert.equal(linesOf(text)[0], '出错：SUBMISSION_SCHEMA_VIOLATION');
    for (let i = 0; i < 20; i++) assert.ok(linesOf(text).some((l) => l.startsWith(`- SUBMISSION_SCHEMA_VIOLATION：参数 ${i} 不对：`) && l.endsWith(`修正：按输入模式改正；位置 /inputs/s${i}`)), `error ${i} keeps its fix and path`);
    assert.match(noteOf(text)!, /错误说明的超出部分（20 处）/);
    const short = toolText('start_run', StartRunOutput.parse({ call_result: 'error', errors: [{ code: 'SOURCE_UNAVAILABLE', message: '对你不可用', fix: '无' }], trace: TRACE }));
    assert.equal(short, ['出错：SOURCE_UNAVAILABLE', '错误与修正：', '- SOURCE_UNAVAILABLE：对你不可用；修正：无', `追踪 ${TRACE}`].join('\n'));
  });

  test('requirement facts say the accepted producer only: no producer kind the contracts do not give', () => {
    const text = toolText('start_run', startAnswer(runOf(items(5))));
    assert.ok(!text.includes('生产者种类'), 'a judgment may be made by a person; the summary says only what is accepted');
  });

  test('item locations: one rule when they follow the ids; per item for a short list without one; where to read them for a long one', () => {
    const odd = (n: number) => items(n).map((it, i) => ({ ...it, location: `${SUBJECT}/kityminder@1/n/x${i * 7}` }));
    const long = toolText('start_run', startAnswer(runOf(items(3000))), { record: RUN_RECORD });
    assert.ok(!long.includes('| 位置 '), 'no location column on a long list (ItemProjection.summary)');
    const short = toolText('start_run', startAnswer(runOf(odd(5))));
    assert.ok(linesOf(short).includes(`- doc7:n1 | 合成用例 1 | 优先级 1，期望结果 1 条 | 位置 ${SUBJECT}/kityminder@1/n/x7`), 'a short list without a rule gives each location');
    const noRule = toolText('start_run', startAnswer(runOf(odd(300))), { record: RUN_RECORD });
    assert.ok(!noRule.includes('| 位置 '));
    assert.ok(linesOf(noRule).includes(`位置：用 get_nodes {"reference":"${RUN_RECORD}#/items/0/location"} 读，把 0 换成条目在这个列表里的序号（从 0 起）`));
    const same = toolText('start_run', startAnswer(runOf(items(60).map((it) => ({ ...it, location: SUBJECT })))));
    assert.ok(linesOf(same).includes(`位置：每个条目的位置都是 ${SUBJECT}`), 'one location for all is said once');
    assert.ok(linesOf(same).includes('- doc7:n59 | 合成用例 59 | 优先级 2，期望结果 3 条'));
  });

  test('an item label too long for a line keeps the item: id, the start of the label, where the whole is, and the note says so', () => {
    const list = items(5, (i) => (i === 2 ? '超长的标题'.repeat(3200) : `合成用例 ${i}`));
    for (const context of [{ record: RUN_RECORD }, {}] as TextContext[]) {
      const text = toolText('start_run', startAnswer(runOf(list)), context);
      withinBudget(text, 'long label');
      assert.deepEqual(itemIdsOf(text), list.map((it) => it.id), 'every item, the long one included');
      const line = linesOf(text).find((l) => l.startsWith('- doc7:n2 | '))!;
      assert.ok(line.length < 1000);
      assert.match(line, new RegExp(`…（共 16000 个字符${context.record ? `，全文 ${RUN_RECORD}#/items/2` : ''}）`));
      assert.match(noteOf(text)!, /条目名称的超出部分/);
      if (!context.record) assert.match(noteOf(text)!, /在控制台运行页/);
    }
  });

  test('the evidence gaps the expected-sources function reported are listed as gaps', () => {
    const text = toolText('start_run', startAnswer(runOf(items(5))), { gaps: [{ code: 'runs.expected_sources_failed', message: '期望来源函数没有给出结果，本次运行没有绑定期望来源' }] });
    assert.ok(linesOf(text).includes('- 数据缺口：runs.expected_sources_failed：期望来源函数没有给出结果，本次运行没有绑定期望来源'));
  });
});

// ---------------------------------------------------------------- production runs

describe('a production run in the start_run text', () => {
  test('production explanations render only valid support facts produced by functions', () => {
    const list=items(1);const result=resultOf(list,{production:true});
    const good=fact(list[0].id,'structure','检查算出 2 个空组');
    const requirement=Object.values(result.partitions).flat()[0].requirements[0];
    requirement.claims=[good,
      {...good,statement:{text:'尚未取得的说明',verdict:'unknown',reason:'missing_input'},qualifier:{...good.qualifier,nature:'unknown',basis_rank:undefined}},
      {...good,statement:{text:'模型伪称的说明',verdict:'support'},warrant:{producer:'model',id:'synthetic-model'}},
      {...good,statement:{text:'被引片段已变的说明',verdict:'support'},validity:{...good.validity,status:'cited_fragment_changed'}},
    ];
    const text=toolText('start_run',startAnswer(runOf(list,{production:true}),{result:{reference:RESULT_RECORD,counts:partitionCountsOf(result.partitions)}}),{...PAGING,production:result,record:RUN_RECORD});
    const section=text.slice(text.indexOf('生产运行说明')).split('问题与未知')[0];
    assert.match(section,/支持事实，1 条/);assert.match(section,/检查算出 2 个空组/);
    for(const absent of ['尚未取得的说明','模型伪称的说明','被引片段已变的说明'])assert.ok(!section.includes(absent));
    withinBudget(text,'known production explanations');
  });
  for (const n of SIZES) {
    test(`${n} items: the result first (counts, every requirement, where the whole is), then every problem and unknown, then the rest`, () => {
      const list = items(n);
      const run = runOf(list, { production: true });
      const result = resultOf(list, { production: true });
      const counts = partitionCountsOf(result.partitions);
      const answer = startAnswer(run, { result: { reference: RESULT_RECORD, counts } });
      const text = toolText('start_run', answer, { ...PAGING, production: result, record: RUN_RECORD });
      withinBudget(text, `production ${n}`);
      const lines = linesOf(text);
      const at = (prefix: string): number => indexOf(lines, (l) => l.startsWith(prefix));
      assert.equal(lines[1], `结果（start_run 时由 Hub 算出）：分区：已交付 ${counts.delivered}，已拒收 ${counts.rejected}，已隔离 0，未完成 ${counts.incomplete}；未知 ${counts.unknown}`, 'the counts on the second line (D05 R[1])');
      assert.equal(lines[2], '要求项（满足状态与各层终态的条目数）：');
      const structure = lines[3];
      if (n >= 62) assert.match(structure, /^- structure 结构：满足 \d+，未满足 \d+（终态不符合期望 \d+），未决 \d+；静态：✓ 通过 \d+，✗ 不通过 \d+（阻断 \d+，提示 \d+），？ 未核对 \d+；动态：本层不适用$/);
      else assert.match(structure, /^- structure 结构：满足 \d+，未满足 0，未决 0；静态：✓ 通过 \d+，✗ 不通过 1（提示 1）；动态：本层不适用$/);
      assert.equal(lines[4], '- catalog 命令目录：没有条目结果', 'a requirement no item carries says so');
      const fullAt = at(`完整结果 ${RESULT_RECORD}：`);
      const problemsAt = at('问题与未知');
      const itemsAt = at('条目（');
      if(n===400){assert.ok(itemsAt>=0,'support facts cannot remove the item list');assert.equal(new Set(itemIdsOf(lines.slice(itemsAt+1).join('\n'))).size,400,'support facts cannot displace any of the 400 item rows');}
      assert.ok(fullAt > 3 && fullAt < problemsAt && problemsAt < at('规程：') && (itemsAt < 0 || problemsAt < itemsAt), `${fullAt} ${problemsAt} ${itemsAt}`);
      assert.ok(lines[fullAt].includes(`get_nodes {"reference":"${RESULT_RECORD}"}`), 'how to read the full result');
      const problems = lines.slice(problemsAt + 1).filter((l) => /^- doc7:n[0-9]+ \| .* \| (已交付|已拒收|未完成)/.test(l) && l.split(' | ').length >= 6);
      assert.ok(problems.length > 0);
      // n3: a violation with its code and message; n7: unknown (unchecked) with its reason; n5: rejected with its code.
      assert.ok(problems.includes('- doc7:n3 | 合成用例 3 | 已交付 | structure | ✗ 静态：不通过，core.structure.duplicate_key，提示，归责 作者输入 | 满足 | 用例重复'));
      assert.ok(!problems.some((l) => l.startsWith('- doc7:n0 |')), 'a pass is no problem');
      if (n > 7) assert.ok(problems.includes('- doc7:n7 | 合成用例 7 | 已交付 | structure | ？ 静态：未核对，检查出错，归责 生产者错误 | 未决'));
      if (n === 62) {
        assert.ok(problems.includes('- doc7:n5 | 合成用例 5 | 已拒收（core.structure.required_empty） | structure | ✗ 静态：不通过，core.structure.required_empty，阻断，归责 作者输入 | 未满足（终态不符合期望） | 必填字段为空'));
        assert.ok(lines.includes('- doc7:n9 | 合成用例 9 | 未完成（提交未覆盖）'), 'an item not delivered is listed even when its requirements need nothing');
      }
      const example = JSON.parse(lines[at('示例 submit_result') + 1]) as unknown;
      assert.ok(Submission.safeParse(example).success, 'the commentary example parses');
      assert.deepEqual((example as { items: unknown[] }).items, [], 'a production run has no item slots to fill');
    });
  }

  test('a long procedure does not push the result down; problems beyond the first part still come before any item', () => {
    const list = items(3000);
    const partitions: Record<string, ItemResult[]> = { delivered: [] };
    list.forEach((it, i) => {
      const advisory = i % 5 === 0;
      partitions.delivered.push({
        item: it.id,
        label: it.label,
        location: it.location,
        requirements: [
          {
            requirement: 'structure',
            layers: [advisory ? { layer: 'static', terminal: 'violation', code: 'core.structure.duplicate_key', tier: 'advisory', attribution: 'author_input' } : { layer: 'static', terminal: 'pass' }],
            status: 'satisfied',
            claims: [fact(it.id, 'structure', advisory ? '用例重复' : '结构完整', advisory ? 'core.structure.duplicate_key' : undefined)],
          },
        ],
      });
    });
    const result = resultWith(partitions);
    const procedure = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 步：按规则核对结构，记下每一个重复的键和它所在的位置。`).join('\n');
    const text = toolText('start_run', startAnswer(runOf(list, { production: true, instructions: procedure }), { result: { reference: RESULT_RECORD, counts: partitionCountsOf(result.partitions) } }), { ...PAGING, production: result, record: RUN_RECORD });
    withinBudget(text, 'production with a long procedure');
    const lines = linesOf(text);
    assert.match(lines[1], /^结果（start_run 时由 Hub 算出）：/);
    const problems = lines.filter((l) => / \| structure \| ✗ 静态：不通过，core\.structure\.duplicate_key/.test(l)).length;
    const shownItems = lines.filter((l) => /^- doc7:n[0-9]+ \| 合成用例 [0-9]+ \| 优先级/.test(l)).length;
    assert.ok(problems > 91, `${problems} problems shown, more than the first part of the list`);
    if (problems < 600) assert.equal(shownItems, 0, 'the items take only the room the problems leave');
    const note = noteOf(text)!;
    assert.ok(note.includes(`问题与未知 ${600 - problems} 条`), 'the problems left out are counted');
    const call = nextCall(text, '问题与未知：')!;
    // The result read by reference lists the problems in the same order, so the cursor continues the list.
    const rest = pages(RESULT_RECORD, canonicalJson(result), call.cursor ?? null);
    const continued = rest.flatMap((p) => linesOf(p).filter((l) => / \| structure \| ✗ 静态：不通过，core\.structure\.duplicate_key/.test(l)));
    assert.equal(problems + continued.length, 600, 'paging from the cursor gives exactly the problems left out');
  });

  test('without the whole result the text still gives the counts and where the problems are', () => {
    const list = items(62);
    const result = resultOf(list, { production: true });
    const text = toolText('start_run', startAnswer(runOf(list, { production: true }), { result: { reference: RESULT_RECORD, counts: partitionCountsOf(result.partitions) } }));
    assert.ok(text.includes('问题与未知的明细在完整结果里'));
    assert.ok(text.includes(`完整结果 ${RESULT_RECORD}：用 get_nodes {"reference":"${RESULT_RECORD}"} 读开头`));
  });
});

// ---------------------------------------------------------------- submit_result

describe('submit_result text', () => {
  for (const n of SIZES) {
    test(`${n} items: the receipt and counts first, each requirement's state, the errors, then every problem, then the details`, () => {
      const list = items(n);
      const result = resultOf(list, { claims: 2 });
      const text = toolText('submit_result', submitAnswer(result), { ...PAGING, record: RESULT_RECORD });
      withinBudget(text, `submit ${n}`);
      const lines = linesOf(text);
      const counts = partitionCountsOf(result.partitions);
      const why = counts.incomplete === 0 ? '' : `（提交未覆盖 ${counts.incomplete}）`; // the helper leaves these items out of the submission
      assert.equal(lines[0], `回执：已受理；分区：已交付 ${counts.delivered}，已拒收 ${counts.rejected}，已隔离 0，未完成 ${counts.incomplete}${why}；未知 ${counts.unknown}`);
      assert.ok(!lines.some((l) => l.startsWith('出错')), 'unknown is never an error');
      const at = (prefix: string): number => indexOf(lines, (l) => l.startsWith(prefix));
      const requirementsAt = at('要求项（满足状态与各层终态的条目数）：');
      assert.ok(requirementsAt > 0 && requirementsAt < 6);
      assert.match(lines[requirementsAt + 1], /^- structure：满足 \d+，未满足 \d+(（终态不符合期望 \d+）)?，未决 \d+；静态：/);
      assert.match(lines[requirementsAt + 2], /^- findings：满足 \d+，未满足 0，未决 \d+；静态：◇ 判断 \d+(，… 未完成 \d+)?；动态：本层不适用$/);
      const errorsAt = at('错误 ');
      const problemsAt = at('问题与未知');
      if (result.errors.length > 0) {
        assert.ok(errorsAt > requirementsAt && errorsAt < problemsAt, `${errorsAt} ${problemsAt}`);
        assert.equal(lines[errorsAt + 1], '  core.coverage.shortfall 1 个；修正：逐个处理或声明跳过', 'the count and the shared fix per code');
        assert.ok(lines.some((l) => l.startsWith('- core.coverage.shortfall：') && l.includes('剩余修复轮数 1') && !l.includes('修正：')), 'each error with its rounds left, the shared fix said once');
      } else assert.equal(errorsAt, -1, 'no problems, no problem list');
      const expected = [
        ...result.partitions.delivered.filter((it) => it.requirements.some((r) => r.status !== 'satisfied' || r.layers.some((l) => l.terminal !== 'pass' && l.terminal !== 'judgment'))).map((it) => it.item),
        ...result.partitions.rejected.map((it) => it.item),
        ...result.partitions.incomplete.map((it) => it.item),
      ];
      const ids = [...new Set(lines.slice(problemsAt + 1).filter((l) => l.split(' | ').length >= 3 && !l.startsWith('- 位置')).flatMap((l) => /^- (doc7:n[0-9]+) \| [^|]+ \| (已交付|已拒收|未完成)/.exec(l)?.[1] ?? []))];
      assert.deepEqual(ids.slice(0, Math.min(ids.length, expected.length)), expected.slice(0, Math.min(ids.length, expected.length)), 'the problems in partition order');
      if (n <= 62) assert.deepEqual(ids.slice(0, expected.length), expected, 'all of them when they fit');
      const note = noteOf(text);
      if (n === 5) assert.ok(note === null && text.includes('条目明细（每个条目下是它的要求项和主张）：'), 'a small result shows every item with its claims too');
      if (n >= 400) {
        assert.ok(note !== null, 'a large result is cut');
        assert.ok(note.includes(`get_nodes {"reference":"${RESULT_RECORD}","cursor":"`), 'and says how to read it');
      }
    });
  }

  test('a delivered item with a violation or an unsatisfied requirement is a problem: counted first, listed one line each', () => {
    const list = items(400);
    const delivered: ItemResult[] = list.map((it) => ({
      item: it.id,
      label: it.label,
      location: it.location,
      requirements: [
        { requirement: 'structure', layers: [{ layer: 'static', terminal: 'violation', code: 'core.structure.duplicate_key', tier: 'blocking', attribution: 'author_input' }], status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch', claims: [fact(it.id, 'structure', '用例重复', 'core.structure.duplicate_key')] },
        { requirement: 'findings', layers: [{ layer: 'static', terminal: 'judgment' }], status: 'unsatisfied', unsatisfied_reason: 'independence_unknown', claims: [claim(it.id, 'findings', '期望结果缺失')] },
      ],
    }));
    const result = resultWith({ delivered });
    for (const context of [{ ...PAGING, record: RESULT_RECORD }, {}] as TextContext[]) {
      const text = toolText('submit_result', submitAnswer(result), context);
      withinBudget(text, 'all delivered with problems');
      const lines = linesOf(text);
      assert.equal(lines[0], '回执：已受理；分区：已交付 400，已拒收 0，已隔离 0，未完成 0；未知 0');
      assert.ok(lines.includes('- structure：满足 0，未满足 400（终态不符合期望 400），未决 0；静态：✗ 不通过 400（阻断 400）；动态：本层不适用'));
      assert.ok(lines.includes('- findings：满足 0，未满足 400（独立性未知 400），未决 0；静态：◇ 判断 400；动态：本层不适用'));
      assert.ok(lines.includes('- doc7:n0 | 合成用例 0 | 已交付 | structure | ✗ 静态：不通过，core.structure.duplicate_key，阻断，归责 作者输入 | 未满足（终态不符合期望） | 用例重复'));
      assert.ok(lines.includes('- doc7:n0 | 合成用例 0 | 已交付 | findings | ◇ 静态：判断 | 未满足（独立性未知） | 期望结果缺失'));
      const note = noteOf(text)!;
      assert.match(note, /问题与未知 \d+ 条/, 'the problems left out are counted');
    }
    // Advisory violations on half of the items and unsatisfied requirements on a quarter: still named.
    const mixed = resultWith({
      delivered: list.map((it, i) => ({
        item: it.id,
        label: it.label,
        location: it.location,
        requirements: [
          i >= 200
            ? { requirement: 'catalog', layers: [{ layer: 'static', terminal: 'violation', code: 'core.catalog.param_out_of_range', tier: 'advisory', attribution: 'author_input' }], status: i >= 300 ? 'unsatisfied' : 'satisfied', ...(i >= 300 ? { unsatisfied_reason: 'outcome_mismatch' } : {}), claims: [fact(it.id, 'catalog', '参数超出范围', 'core.catalog.param_out_of_range')] }
            : { requirement: 'catalog', layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', claims: [] },
          { requirement: 'findings', layers: [{ layer: 'static', terminal: 'judgment' }], status: i >= 300 ? 'unsatisfied' : 'satisfied', ...(i >= 300 ? { unsatisfied_reason: 'independence_unknown' } : {}), claims: [] },
        ] as RequirementResult[],
      })),
    });
    const text = toolText('submit_result', submitAnswer(mixed));
    for (const word of ['不通过', '未满足', '独立性未知', 'core.catalog.param_out_of_range']) assert.ok(text.includes(word), word);
    assert.ok(linesOf(text).includes('- catalog：满足 300，未满足 100（终态不符合期望 100），未决 0；静态：✓ 通过 200，✗ 不通过 200（提示 200）；动态：本层不适用'));
  });

  test('cross-item claims (the verdict and level of the run) survive a large receipt', () => {
    const list = items(1000);
    const incomplete: ItemResult[] = list.map((it) => ({
      item: it.id,
      label: it.label,
      location: it.location,
      reason: 'not_covered',
      requirements: [{ requirement: 'findings', layers: [{ layer: 'static', terminal: 'incomplete', reason: 'not_covered', missing: '未覆盖条目的合成产物；下一步：合成运行者补交后重核', exit: { action: 'request' as const, request_kind: 'repair' as const, audience: { user: 'usr_' + '1'.repeat(26) }, due: '2026-01-04T00:00:00.000Z' }, attribution: 'author_input' }], status: 'pending', claims: [] }],
    }));
    const verdict: Claim = {
      requirement: 'final',
      statement: { text: '复核结论：PARTIAL，最终等级 P4', code: 'verdict', rank: 'PARTIAL' },
      qualifier: { nature: 'judgment', provenance: 'declared', basis_rank: 'judgment', marks: ['semantics_unasserted'] },
      grounds: [SUBJECT],
      warrant: { producer: 'model', id: 'scripted-model@test' },
      validity: { status: 'valid', bound: [H('c')], premises: [] },
    };
    const text = toolText('submit_result', submitAnswer(resultWith({ incomplete }, [], [verdict])), { record: RESULT_RECORD });
    withinBudget(text, 'large receipt with a verdict');
    assert.ok(text.includes('复核结论：PARTIAL，最终等级 P4'), 'the verdict is in the answer');
  });

  test('a repeat names this call’s trace last and the trace of the call that produced the stored result', () => {
    const result = resultOf(items(400), { claims: 2 });
    const first = toolText('submit_result', submitAnswer(result, TRACE), { record: RESULT_RECORD });
    const again = toolText('submit_result', submitAnswer(result, TRACE_2), { record: RESULT_RECORD });
    assert.equal(linesOf(again).at(-1), `追踪 ${TRACE_2}`);
    noteOf(again, TRACE_2);
    assert.ok(linesOf(again).includes(`结果出自追踪 ${TRACE} 的那次调用（同一提交的重复调用返回存下的结果）`));
    assert.ok(!first.includes('结果出自追踪'), 'the first call produced the result itself');
  });

  test('a submission that is not accepted: per-code counts first, every error with its rounds left, the stored result for the rest', () => {
    const errors: ProtocolError[] = Array.from({ length: 600 }, (_, i) => ({
      code: 'QUOTE_MISMATCH',
      message: `原文与引用对不上：${'引文'.repeat(i % 7 === 0 ? 3000 : 30)}`,
      fix: '按原文逐字引用，或先调用 resolve_reference',
      path: `/items/${i}/slots/findings/0/quotes/0`,
      item: `doc7:n${i}`,
      requirement: 'findings',
      rounds_left: 1,
    }));
    const empty = { delivered: [], rejected: [], quarantined: [], incomplete: [] } as unknown as Partitions;
    const result = ValidationResult.parse({ ...resultOf(items(1)), acceptance: 'not_accepted', errors, partitions: empty, cross_item: [] });
    const without = toolText('submit_result', submitAnswer(result));
    withinBudget(without, 'not accepted');
    const lines = linesOf(without);
    assert.equal(lines[0], '回执：未受理；没有分区（未受理的提交不分区）');
    assert.ok(lines.includes('错误 600 个，按代码：') && lines.includes('  QUOTE_MISMATCH 600 个；修正：按原文逐字引用，或先调用 resolve_reference'), 'the scale and the fix on the first screen');
    assert.ok(lines.some((l) => /^- QUOTE_MISMATCH：原文与引用对不上：.*；位置 \/items\/\d+\/slots\/findings\/0\/quotes\/0；条目 doc7:n\d+；要求项 findings；剩余修复轮数 1$/.test(l)));
    assert.match(noteOf(without)!, /错误 \d+ 个（第 \d+ 到第 600 个）.*那次提交也会让错误落在其陈述里的要求项用掉一轮修复/);
    const stored = toolText('submit_result', submitAnswer(result), { record: RESULT_RECORD });
    const shown = linesOf(stored).filter((l) => l.startsWith('- QUOTE_MISMATCH：')).length;
    assert.deepEqual(nextCall(stored, '其余错误：逐个读 '), { reference: `${RESULT_RECORD}#/errors/${shown}` }, 'the stored result names the next error');
    assert.ok(!noteOf(stored)!.includes('改正上面列出的问题再提交'), 'no advice to spend a round to see the rest');
    const paged = toolText('submit_result', submitAnswer(result), { ...PAGING, record: RESULT_RECORD });
    const call = nextCall(paged, '其余错误：')!;
    const rest = pages(RESULT_RECORD, canonicalJson(result), call.cursor ?? null);
    const continued = rest.flatMap((p) => linesOf(p).filter((l) => l.startsWith('- QUOTE_MISMATCH：')));
    assert.equal(linesOf(paged).filter((l) => l.startsWith('- QUOTE_MISMATCH：')).length + continued.length, 600, 'the cursor reads exactly the errors left out');
  });
});

// ---------------------------------------------------------------- get_nodes

describe('get_nodes text', () => {
  test('a 3000-item validation result read by reference: every page within the budget, every item exactly once', () => {
    const list = items(3000, (i) => (i % 501 === 0 ? `长标题 ${'很'.repeat(5000)}` : `合成用例 ${i}`));
    const result = resultOf(list, { claims: 3, claimText: (i, k) => (i % 733 === 0 && k === 0 ? '超长的发现'.repeat(9000) : `第 ${k} 条发现`) });
    const all = pages(RESULT_RECORD, canonicalJson(result));
    assert.ok(all.length > 10, `${all.length} pages`);
    for (const page of all) withinBudget(page, 'a result page');
    const detailsOf = (page: string): string[] => linesOf(page).flatMap((line) => /^- (doc7:n[0-9]+) \| [^|]+ \| (已交付|已拒收|已隔离|未完成)(（[^）]*）)?(；沿用 .*)?$/.exec(line)?.[1] ?? []);
    const seen = all.flatMap(detailsOf);
    const inPartitionOrder = (['delivered', 'rejected', 'quarantined', 'incomplete'] as const).flatMap((p) => result.partitions[p].map((it) => it.item));
    assert.deepEqual(seen, inPartitionOrder, 'every item once in the details, in partition order');
    assert.match(all[0], new RegExp(`^内容 ${RESULT_RECORD}：模型可读\n结果 ${RESULT_RECORD}（运行 ${RUN}）：回执：已受理；分区：`));
    assert.ok(all.slice(0, -1).every((page) => noteOf(page) !== null), 'a page that does not end the result says how to go on');
    assert.equal(noteOf(all.at(-1)!), null, 'the last page has no note');
    assert.ok(all.some((page) => page.includes('（接上页：条目 ')), 'a page that starts inside an item says whose lines follow');
    assert.ok(all.some((page) => page.includes('行的前 ') && page.includes('个字符在上一页')), 'a line longer than a page is shown in pieces');
    assert.ok(!all.some((page) => page.includes('超过一页的长度')), 'no line is replaced by a placeholder');
    const long = all.map((page) => linesOf(page).find((l) => l.includes('超长的发现')) ?? '').join('');
    assert.ok(long.length > 45_000, 'the 45,000-character finding is read in pieces');
  });

  for (const n of SIZES.slice(0, 3)) {
    test(`a ${n}-item result read by reference: within the budget, every item once, a note only while pages remain`, () => {
      const result = resultOf(items(n), { claims: 2 });
      const all = pages(RESULT_RECORD, canonicalJson(result));
      for (const page of all) withinBudget(page, `a page of ${n}`);
      assert.equal(all.length === 1, noteOf(all[0]) === null, 'one page exactly when nothing was cut');
      assert.ok(all[0].includes('要求项（满足状态与各层终态的条目数）：'));
    });
  }

  test('a partition or one item read by pointer is shown as items; a cursor of another reference starts over and says so', () => {
    const result = resultOf(items(30));
    const one = toolText('get_nodes', contentAnswer(`${RESULT_RECORD}#/partitions/incomplete/0`, canonicalJson(result.partitions.incomplete[0])));
    assert.ok(one.includes('- doc7:n9 | 合成用例 9 | 未完成（提交未覆盖）'));
    assert.ok(one.includes('  · findings：… 静态：未完成，提交未覆盖，归责 作者输入；动态：本层不适用；未决'));
    const partition = toolText('get_nodes', contentAnswer(`${RESULT_RECORD}#/partitions/delivered`, canonicalJson(result.partitions.delivered)));
    assert.deepEqual(itemIdsOf(partition), result.partitions.delivered.map((it) => it.item));
    const wrong = toolText('get_nodes', contentAnswer(RESULT_RECORD, canonicalJson(result)), { ...PAGING, cursor: pageCursor(`${RESULT_RECORD}#/x`, 5) });
    assert.ok(wrong.includes('不是这个引用的翻页位置，下面从第一页显示'));
    assert.equal(pageCursorProblem(RESULT_RECORD, pageCursor(RESULT_RECORD, 3)), null);
    assert.equal(pageCursorProblem(RESULT_RECORD, pageCursor(RESULT_RECORD, 3, 17)), null);
    assert.deepEqual(cursorPosition(RESULT_RECORD, pageCursor(RESULT_RECORD, 3, 17)), { line: 3, offset: 17 });
    assert.ok(pageCursorProblem(RESULT_RECORD, 'abc') !== null);
  });

  test('an empty partition, an empty item list and an empty array read by reference: the head says so, with and without paging', () => {
    // Every item delivered (the common case) leaves the other three partitions empty.
    const result = resultOf(items(4));
    for (const partition of ['rejected', 'quarantined', 'incomplete'] as const) {
      assert.deepEqual(result.partitions[partition], []);
      const reference = `${RESULT_RECORD}#/partitions/${partition}`;
      for (const context of [{}, PAGING, { ...PAGING, cursor: pageCursor(reference, 0) }]) {
        const text = toolText('get_nodes', contentAnswer(reference, canonicalJson(result.partitions[partition])), context);
        withinBudget(text, `the empty ${partition} partition`);
        assert.ok(linesOf(text).includes(`结果的${labelOf('partition', partition)}部分 ${reference}：条目 0 个`), text);
        assert.equal(noteOf(text), null, 'nothing was left out');
      }
    }
    const runItems = toolText('get_nodes', contentAnswer(`${RUN_RECORD}#/items`, '[]'), PAGING);
    assert.ok(linesOf(runItems).includes(`运行的条目 ${RUN_RECORD}#/items`), runItems);
    assert.ok(linesOf(runItems).some((line) => line.startsWith('条目（0 个；')), runItems);
    assert.equal(noteOf(runItems), null);
    const other = toolText('get_nodes', contentAnswer(`${RUN_RECORD}#/sources`, '[]'), PAGING);
    assert.ok(linesOf(other).includes('[]'), 'another empty array is shown as JSON');
  });

  test('a cursor whose offset falls inside a surrogate pair is not a page position: the page starts over and says so, never with half a character', () => {
    const reference = `src:${H('a')}`;
    const first = `第 0 行 😀${'字'.repeat(20)}`;
    const text = `${first}\n第 1 行`;
    assert.equal(first.charCodeAt(6) >= 0xd800 && first.charCodeAt(6) <= 0xdbff, true, 'the emoji starts at offset 6');
    const inside = toolText('get_nodes', contentAnswer(reference, text), { ...PAGING, cursor: pageCursor(reference, 0, 7) });
    assert.ok(inside.isWellFormed(), 'no lone surrogate in the text');
    const [said, ...shown] = shownSource(inside);
    assert.match(said, /^cursor \S+ 不是这个引用的翻页位置，下面从第一页显示$/);
    assert.deepEqual(shown, [first, '第 1 行'], 'the first page, whole');
    for (const offset of [6, 8]) {
      const page = toolText('get_nodes', contentAnswer(reference, text), { ...PAGING, cursor: pageCursor(reference, 0, offset) });
      assert.ok(page.isWellFormed());
      assert.ok(page.includes(`（接上页：第 1 行的前 ${offset} 个字符在上一页）`), `offset ${offset} is a page position`);
      assert.equal(shownSource(page)[0], first.slice(offset));
    }
  });

  test('a text that cannot be laid out gives a minimal text: the outcome, the receipt, the run, the stored result, the trace', () => {
    const result = resultOf(items(5));
    const answer = submitAnswer(result);
    const text = fallbackText('submit_result', answer, { record: RESULT_RECORD });
    const lines = linesOf(text);
    assert.equal(lines[0], '调用结果：正常');
    assert.ok(lines.includes('回执：已受理；分区：已交付 5，已拒收 0，已隔离 0，未完成 0；未知 0'), text);
    assert.ok(lines.includes(`运行 ${RUN}`));
    assert.ok(lines.includes(`存下的结果 ${RESULT_RECORD}（用 get_nodes 按引用读）`));
    assert.equal(lines.at(-2), `这次回答的文字没能排出（原因已记入管理员日志）；回答本身有效；完整内容在控制台运行页 /console/runs/${RUN} 查看`);
    assert.equal(lines.at(-1), `追踪 ${TRACE}`);
    const refused = fallbackText('start_run', { call_result: 'error', errors: [{ code: 'SOURCE_UNAVAILABLE', message: 'x' }, { code: 'SOURCE_UNAVAILABLE', message: 'y' }], trace: TRACE }, {});
    assert.deepEqual(linesOf(refused), ['调用结果：出错', '错误代码：SOURCE_UNAVAILABLE', '这次回答的文字没能排出（原因已记入管理员日志）；回答本身有效', `追踪 ${TRACE}`]);
    const started = fallbackText('start_run', startAnswer(runOf(items(3), { production: true }), { result: { reference: RESULT_RECORD, counts: partitionCountsOf(result.partitions) } }), {});
    assert.ok(linesOf(started).includes(`运行 ${RUN}：任务包 toy-locate@1.0.0`), started);
    assert.ok(linesOf(started).includes(`完整结果 ${RESULT_RECORD}（用 get_nodes 按引用读）`), started);
    // Whatever it is handed, it gives at least the trace line.
    assert.equal(fallbackText('get_nodes', null, {}), '这次回答的文字没能排出（原因已记入管理员日志）\n追踪 （未知）');
  });

  test('without paging a source fragment is read on by byte ranges that the resolver reads exactly, long lines in pieces, to its end', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `第 ${i + 1} 行：分区 ${i % 8} 浇灌 ${i % 120} 分钟。`);
    lines[1500] = '超长的一行'.repeat(4000);
    lines[2200] = `${'甲'.repeat(20_000)}${'😀'.repeat(15_000)}`;
    const text = lines.join('\n');
    const bytes = new TextEncoder().encode(text);
    const sha = sha256(bytes);
    const context = memory(new Map([[sha, { bytes, mediaType: 'text/plain' }]]));
    const all = await follow(context, `src:${sha}/text@1/l/1-3000`, '接着读：');
    reassembles(all, text);
    assert.ok(all.some((page) => /第 1 行的其余 \d+ 个字符/.test(noteOf(page) ?? '')), 'the 50,000-character line is read in pieces');
    assert.ok(!all.some((page) => page.includes('超过一页的长度')), 'no placeholder');
    // With paging the same source pages by cursor, pieces of long lines included.
    reassembles(pages(`src:${sha}/text@1/l/1-3000`, text), text);
  });

  test('without paging a whole source is read on by text@1 lines; a 17,272-character line that fits is shown whole', async () => {
    const markdown = Array.from({ length: 4000 }, (_, i) => `- 第 ${i + 1} 条：分区 ${i % 8} 的说明文字，${'很'.repeat(i % 13)}。`).join('\n');
    const json = JSON.stringify({ root: { data: { id: 'r', text: '根'.repeat(17_200) } } });
    const files = new Map([
      [sha256(new TextEncoder().encode(markdown)), { bytes: new TextEncoder().encode(markdown), mediaType: 'text/markdown' }],
      [sha256(new TextEncoder().encode(json)), { bytes: new TextEncoder().encode(json), mediaType: 'application/json' }],
    ]);
    const context = memory(files);
    const all = await follow(context, `src:${sha256(new TextEncoder().encode(markdown))}`, '接着读：');
    assert.ok(all.length > 1);
    assert.match(noteOf(all[0])!, /接着读：get_nodes \{"reference":"src:[0-9a-f]{64}\/text@1\/l\/\d+-4000"\}/);
    const seen = all.flatMap(shownSource);
    assert.deepEqual(seen, markdown.split('\n'), 'every line once, in order');
    const one = await follow(context, `src:${sha256(new TextEncoder().encode(json))}`, '接着读：');
    assert.equal(one.length, 1);
    assert.deepEqual(shownSource(one[0]), [json], 'shown whole');
    assert.equal(noteOf(one[0]), null);
  });

  test('a long string of a record (a 40,000-character statement) is paged in pieces by cursor; without paging the note names the console', () => {
    const statement = `${'一'.repeat(20_000)}${'二'.repeat(20_000)}`;
    const reference = `${RESULT_RECORD}#/partitions/delivered/0/requirements/0/claims/0/statement/text`;
    const all = pages(reference, statement);
    assert.equal(all.length, 2);
    assert.equal(all.map((p) => shownSource(p).join('')).join(''), statement, 'the pieces add up to the statement');
    const alone = toolText('get_nodes', contentAnswer(reference, statement));
    assert.match(noteOf(alone)!, /第 1 行的其余 \d+ 个字符.*在控制台运行页/);
    const fits = toolText('get_nodes', contentAnswer(reference, '三'.repeat(16_000)));
    assert.equal(noteOf(fits), null, 'a 16,000-character string fits a page and is shown whole');
  });

  test('other record JSON is laid out one member a line: the full slot schema reads without placeholders', () => {
    const schema = toySlots().schema;
    const extra = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`extra${i}`, { type: 'array', description: `说明 ${i}：${'说明'.repeat(100)}` }]));
    const bigger = { ...schema, properties: { ...(schema.properties as object), ...extra } };
    const text = canonicalJson(bigger);
    assert.ok(text.length > 60_000 && !text.includes('\n'), 'one line of canonical JSON, as hub/refs returns it');
    const reference = `${RUN_RECORD}#/slots/schema`;
    const all = pages(reference, text);
    assert.ok(all.length > 1);
    const body = (page: string): string[] => {
      const lines = linesOf(page);
      return lines.slice(lines.findIndex((l) => l.startsWith('共 ')) + 1, NOTE.test(lines.at(-2) ?? '') ? -2 : -1);
    };
    assert.equal(all.flatMap(body).join('\n'), JSON.stringify(JSON.parse(text), null, 1), 'the pages are the schema pretty-printed (canonical key order), each line once');
    assert.ok(!all.some((p) => p.includes('超过一页的长度')));
    const unpaged = toolText('get_nodes', contentAnswer(reference, text));
    assert.deepEqual(nextCall(unpaged, '逐个读：'), { reference: `${reference}/properties` }, 'without paging: the member the page stopped in');
  });

  test('a page of many nodes keeps whole nodes and names the nodes it left out as get_nodes calls of their paths', () => {
    const root = H('d');
    const nodes = Array.from({ length: 100 }, (_, i) => {
      const path = `/catalog/menu${i}`;
      const address = `tree:${root}${path}`;
      return {
        path,
        reference: address,
        name: `menu${i}`,
        level: 'branch',
        digest: H('3'),
        children: Array.from({ length: 30 }, (_, k) => ({ name: `item${k}`, path: `${path}/item${k}`, digest: H('4') })),
        entries: Array.from({ length: 4 }, (_, k) => ({
          entry: H(String(k + 5)),
          kind: 'definition',
          statement: `menu${i} 的第 ${k} 个签名`,
          reference: `${address}@${H(String(k + 5))}`,
          applicability: '全部构建',
          data: { params: [{ name: 'zone', type: 'integer', limit: '1-8' }] },
        })),
      };
    });
    const answer = GetNodesOutput.parse({ call_result: 'ok', errors: [], root, nodes, coverage: { complete: false, examined: 100 }, next: 'cursor-of-the-service', trace: TRACE });
    const text = toolText('get_nodes', answer);
    withinBudget(text, 'tree page');
    const lines = linesOf(text);
    assert.equal(lines[0], `知识根 ${root}：节点 100 个`);
    assert.ok(lines.includes('还有下一页：用同样的 root、paths 和 depth，再加 cursor cursor-of-the-service'));
    const head = lines.indexOf(`- /catalog/menu0（枝）menu0：子节点 30 个，条目 4 个；引用 tree:${root}/catalog/menu0`);
    assert.ok(head > 0);
    assert.ok(lines[head + 1].startsWith('  · [定义] menu0 的第 0 个签名（适用 全部构建）；引用 ') && lines[head + 1].endsWith('；数据 {"params":[{"name":"zone","type":"integer","limit":"1-8"}]}'), 'the entries right after the node');
    assert.equal(lines[head + 5], '  子节点 /catalog/menu0/item0 item0', 'then the children');
    const shown = lines.filter((l) => /^- \/catalog\/menu\d+（/.test(l)).length;
    assert.ok(shown > 0 && shown < 100);
    const call = nextCall(text, `这一页其余 ${100 - shown} 个节点：`)!;
    assert.deepEqual(call, { root, paths: nodes.slice(shown).map((n) => n.path), depth: 0 });
  });

  test('left-out nodes with long paths: as many paths as fit in the call, and how many more', () => {
    const root = H('d');
    const nodes = Array.from({ length: 100 }, (_, i) => {
      const path = `/命令/${'很长的菜单名称'.repeat(12)}${i}`;
      return { path, reference: `tree:${root}${path}`, name: `m${i}`, level: 'leaf', digest: H('3'), children: [], entries: [{ entry: H('5'), kind: 'definition', statement: '签'.repeat(1400), reference: `tree:${root}${path}@${H('5')}`, applicability: '全部构建' }] };
    });
    const text = toolText('get_nodes', GetNodesOutput.parse({ call_result: 'ok', errors: [], root, nodes, trace: TRACE }));
    withinBudget(text, 'long paths');
    const shown = linesOf(text).filter((l) => l.startsWith('- /命令/')).length;
    const note = noteOf(text)!;
    const call = nextCall(text, `这一页其余 ${100 - shown} 个节点：`)!;
    assert.ok(call.paths!.length > 1 && call.paths!.length < 100 - shown, `${call.paths!.length} paths in the call`);
    assert.deepEqual(call.paths, nodes.slice(shown, shown + call.paths!.length).map((n) => n.path));
    assert.ok(note.includes(`其后的 ${100 - shown - call.paths!.length} 个节点（从 ${nodes[shown + call.paths!.length].path} 起）`));
  });

  test('a node too long for a page: its entries first, then children as fit, and a note with a call for the children left out', () => {
    const root = H('d');
    const path = '/commands/show';
    const node = {
      path,
      reference: `tree:${root}${path}`,
      name: 'show',
      level: 'branch',
      digest: H('3'),
      children: Array.from({ length: 2000 }, (_, k) => ({ name: `option${k}`, path: `${path}/option${k}`, digest: H('4') })),
      entries: Array.from({ length: 3 }, (_, k) => ({ entry: H(String(k + 5)), kind: 'definition', statement: `show 的第 ${k} 个签名`, reference: `tree:${root}${path}@${H(String(k + 5))}`, applicability: '全部构建' })),
    };
    const text = toolText('get_nodes', GetNodesOutput.parse({ call_result: 'ok', errors: [], root, nodes: [node], trace: TRACE }));
    withinBudget(text, 'one big node');
    const lines = linesOf(text);
    assert.equal(lines.filter((l) => l.startsWith('  · [定义] show 的第 ')).length, 3, 'every entry is shown');
    const children = lines.filter((l) => l.startsWith('  子节点 ')).length;
    assert.ok(children > 300 && children < 2000);
    const note = noteOf(text)!;
    assert.ok(note.includes(`节点 ${path} 的子节点 ${2000 - children} 个`));
    const call = nextCall(text, `节点 ${path} 的其余子节点：`)!;
    assert.equal(call.paths![0], `${path}/option${children}`);
  });

  test('a source fragment cut by lines gives a byte range that reads exactly the rest; a whole-file reference gives text@1 lines', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `第 ${i + 1} 行：分区 ${i % 8} 浇灌 ${i % 120} 分钟。`);
    const text = lines.join('\n');
    const reference = `src:${H('e')}/text@1/l/1-3000`;
    const first = toolText('get_nodes', contentAnswer(reference, text));
    withinBudget(first, 'source page');
    assert.match(first, /^内容 src:e{64}\/text@1\/l\/1-3000：模型可读\n原文（\d+ 个字符）：\n第 1 行：/);
    const shown = linesOf(first).filter((l) => /^第 \d+ 行：/.test(l)).length;
    const range = nextCall(first, '接着读：')!;
    const [, from, to] = /:([0-9]+)-([0-9]+)$/.exec(range.reference!)!.map(Number);
    assert.equal(Buffer.from(text, 'utf8').subarray(from, to).toString('utf8'), lines.slice(shown).join('\n'), 'the range is exactly the rest of the fragment');
    const whole = toolText('get_nodes', contentAnswer(`src:${H('e')}`, text));
    const shownWhole = linesOf(whole).filter((l) => /^第 \d+ 行：/.test(l)).length;
    assert.equal(nextCall(whole, '接着读：')!.reference, `src:${H('e')}/text@1/l/${shownWhole + 1}-3000`);
  });

  test('the text of a small source is given whole, verbatim', () => {
    const text = '# 标题\r\n\r\n正文第一行\n正文第二行';
    assert.equal(toolText('get_nodes', contentAnswer(`src:${H('e')}`, text)), [`内容 src:${H('e')}：模型可读`, `原文（${text.length} 个字符）：`, text, `追踪 ${TRACE}`].join('\n'));
  });
});

// ---------------------------------------------------------------- list_task_packs, upload_file, resolve_reference

function packOf(i: number): PackSummary {
  return {
    pack: `toy-pack-${i}@1.0.${i}`,
    id: `toy-pack-${i}`,
    version: `1.0.${i}`,
    kind: 'workflow',
    title: `合成任务包 ${i}`,
    description: '评审合成的思维导图（合成）',
    products: ['Meadow', 'Lawn'],
    inputs: [
      { slot: 'map', role: 'subject', description: '被评审的思维导图', accepts: ['application/json', 'toy:mindmap'], required: true, many: false },
      { slot: 'story', role: 'expected', description: '关联的需求', accepts: ['toy:story'], required: false, many: true },
      { slot: 'notes', role: 'hint', description: '历史用例清单', accepts: ['text/markdown'], required: true, many: true },
    ],
    parameters: [
      { name: 'depth', description: '评审深度（合成）', required: true },
      { name: 'strict', description: '严格模式（合成）', required: false, schema: { type: 'boolean' } },
    ],
    requirements: REQUIREMENTS,
  };
}

describe('list_task_packs, upload_file and resolve_reference texts', () => {
  test('a truncated task-pack list names an advancing offset with the same filters', () => {
    const answer = ListTaskPacksOutput.parse({ call_result: 'ok', errors: [], packs: Array.from({ length: 300 }, (_, i) => packOf(i)), trace: TRACE });
    const text = toolText('list_task_packs', answer, { packList: { offset: 7, kind: 'workflow' } });
    withinBudget(text, 'task-pack continuation');
    const match = noteOf(text)?.match(/list_task_packs (\{[^}]+\})/);
    assert.ok(match, 'the omitted packs have a tool-based continuation');
    const next = JSON.parse(match[1]!) as { kind: string; offset: number };
    assert.equal(next.kind, 'workflow');
    assert.ok(next.offset > 7 && next.offset < 307);
    assert.match(noteOf(text)!, /\/console\/packs/);
  });

  test('an oversized single pack does not suggest the same exact query in a loop', () => {
    const pack = packOf(1);
    const oversized = { ...pack, inputs: Array.from({ length: 300 }, (_, i) => ({ ...pack.inputs[0]!, slot: `input_${i}` })) };
    const answer = ListTaskPacksOutput.parse({ call_result: 'ok', errors: [], packs: [oversized], trace: TRACE });
    const text = toolText('list_task_packs', answer, { packList: { offset: 0, packId: pack.id } });
    withinBudget(text, 'oversized task pack');
    assert.match(noteOf(text)!, /单个任务包详情超出回答预算/);
    assert.doesNotMatch(noteOf(text)!, /list_task_packs/);
  });

  test('every pack with its inputs, parameters and an example start_run call that parses with StartRunInput and names a product', () => {
    const answer = ListTaskPacksOutput.parse({ call_result: 'ok', errors: [], packs: [packOf(1), packOf(2)], trace: TRACE });
    const text = toolText('list_task_packs', answer);
    const lines = linesOf(text);
    assert.equal(lines[0], '可用的任务包 2 个');
    assert.match(lines[1], /product 换成被判对象所属产品线的名字（“产品”里列出的任一个）$/);
    assert.ok(lines.includes('- toy-pack-1@1.0.1 合成任务包 1（工作流包）：评审合成的思维导图（合成）'));
    assert.ok(lines.includes('  产品：Meadow、Lawn'));
    assert.ok(lines.includes(`  输入 map（被判对象，必填）：被评审的思维导图；接受 application/json、toy:mindmap；写法 {"reference":"src:${'0'.repeat(64)}"} 或 {"external":"toy:mindmap:<编号>"}`));
    assert.ok(lines.includes('  输入 story（期望来源，可选，可多个）：关联的需求；接受 toy:story；写法 {"external":"toy:story:<编号>"}'));
    assert.ok(lines.includes('  参数 depth（必填）：评审深度（合成）'));
    assert.ok(lines.includes('  参数 strict（可选）：严格模式（合成）；模式 {"type":"boolean"}'), 'a declared value schema is shown');
    assert.ok(!text.includes('生产者种类'));
    const examples = lines.filter((l) => l.startsWith('  示例 start_run：')).map((l) => l.slice('  示例 start_run：'.length));
    assert.equal(examples.length, 2);
    for (const example of examples) {
      const call = StartRunInput.parse(JSON.parse(example));
      assert.equal(call.product, 'Meadow', 'a name of the first bound line');
      assert.deepEqual(Object.keys(call.inputs), ['map', 'notes'], 'only the required inputs');
      assert.deepEqual(call.parameters, { depth: '<depth>' }, 'only the required parameters, with a placeholder');
    }
    assert.equal(startRunExample({ ...packOf(3), inputs: [{ slot: 'map', role: 'subject', description: 'x', accepts: ['toy:mindmap'], required: true, many: false }], parameters: [] }), '{"pack":"toy-pack-3@1.0.3","product":"Meadow","inputs":{"map":{"external":"toy:mindmap:<编号>"}}}');
    assert.equal(startRunExample({ ...packOf(4), products: [], parameters: [], inputs: [] }), '{"pack":"toy-pack-4@1.0.4","inputs":{}}', 'no product without bound lines');
    const many = toolText('list_task_packs', ListTaskPacksOutput.parse({ call_result: 'ok', errors: [], packs: Array.from({ length: 300 }, (_, i) => packOf(i)), trace: TRACE }));
    withinBudget(many, '300 packs');
    assert.match(noteOf(many)!, /\/console\/packs/);
  });

  test('an upload with a large structure summary stays within the budget and points at the source', () => {
    const summary = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`element${i}`, i]));
    const answer = UploadFileOutput.parse({ call_result: 'ok', errors: [], acceptance: 'accepted', reference: `src:${H('e')}`, sha256: H('e'), size: 12, media_type: 'application/xml', structure: { parser: 'xml@1', summary }, trace: TRACE });
    const text = toolText('upload_file', answer);
    withinBudget(text, 'upload');
    const lines = linesOf(text);
    assert.deepEqual(lines.slice(0, 5), [`回执：已受理，引用 src:${H('e')}`, '大小 12 字节，媒体类型 application/xml', `sha256 ${H('e')}`, '解析器 xml@1 认出了这份文件', '结构摘要：']);
    assert.match(noteOf(text)!, new RegExp(`读原文：get_nodes \\{"reference":"src:${H('e')}"\\}`));
  });

  test('resolve_reference with many long candidates stays within the budget', () => {
    const references = Array.from({ length: 2000 }, (_, i) => ({ reference: `src:${H('e')}/text@1/l/${i + 1}`, text: `候选 ${i}：${'原文'.repeat(i % 50 === 0 ? 3000 : 20)}`, role: 'expected' as const }));
    const answer = ResolveReferenceOutput.parse({ call_result: 'ok', errors: [], resolution: 'ambiguous', references, diagnostics: ['这是预览，不是证据'], trace: TRACE });
    const text = toolText('resolve_reference', answer);
    withinBudget(text, 'resolve');
    assert.equal(linesOf(text)[0], '解析状态：有歧义，可能所指 2000 个（预览，不作凭据）');
    assert.match(noteOf(text)!, /可能所指 \d+ 个/);
  });
});

// ---------------------------------------------------------------- property

test('property: random item counts, labels up to 5,000 characters and claim counts: within the budget, trace last, no cursor unless paging', () => {
  for (let run = 0; run < 24; run++) {
    const seed = 7000 + run;
    const next = random(seed);
    const n = 1 + Math.floor(next() ** 2 * 3000);
    const list = items(n, (i) => (next() < 0.05 ? '标'.repeat(5000) : `用例 ${i} ${'题'.repeat(Math.floor(next() * 80))}`));
    const claims = Math.floor(next() * 6);
    const result = resultOf(list, { claims, claimText: () => '发现'.repeat(Math.floor(next() * (next() < 0.1 ? 4000 : 60)) + 1) });
    const paging = next() < 0.5;
    const context: TextContext = next() < 0.5 ? { record: RUN_RECORD, paging } : { paging };
    const texts: [string, string][] = [
      ['start', toolText('start_run', startAnswer(runOf(list)), context)],
      ['production', toolText('start_run', startAnswer(runOf(list, { production: true }), { result: { reference: RESULT_RECORD, counts: partitionCountsOf(result.partitions) } }), { production: result, paging })],
      ['submit', toolText('submit_result', submitAnswer(result), { record: RESULT_RECORD, paging })],
      ['result page', toolText('get_nodes', contentAnswer(RESULT_RECORD, canonicalJson(result)), { paging })],
    ];
    for (const [what, text] of texts) {
      withinBudget(text, `seed ${seed} ${what}`);
      noteOf(text);
      if (!paging) assert.ok(callsIn(text).every((call) => call.cursor === undefined), `seed ${seed} ${what}: no cursor without paging`);
      assert.ok(!text.includes('超过一页的长度'), `seed ${seed} ${what}: no placeholder line`);
    }
  }
});

// ---------------------------------------------------------------- the server as it is wired: every way it is offered works

describe('through the MCP server: the ways to read the rest that the notes give are taken by the server', async () => {
  const { createTestServer } = await import('./testing.ts');
  let postgres: TemporaryPostgres;
  let server: Awaited<ReturnType<typeof createTestServer>>;

  before(async () => {
    postgres = await startPostgres();
    server = await createTestServer({ postgres });
  });
  after(async () => {
    await server?.close();
    await postgres?.stop();
  });

  test('a 4,000-line upload read by reference: the page cursors the server offers and the ranges a text without paging gives both read every line once', async () => {
    const user = await server.createUser('读者');
    const client = await server.client(user.token);
    const markdown = Array.from({ length: 4000 }, (_, i) => `- 第 ${i + 1} 条：分区 ${i % 8} 的合成说明，${'长'.repeat(i % 17)}。`).join('\n');
    const uploaded = await client.call('upload_file', { file_path: Buffer.from(markdown).toString('base64'), media_type: 'text/markdown' });
    const reference = String(uploaded.structuredContent.reference);
    // The server pages (TextContext.paging): its notes give get_nodes {reference, cursor}.
    let args: Record<string, unknown> = { reference };
    const seen: string[] = [];
    for (let i = 0; i < 100; i++) {
      const page = await client.call('get_nodes', args);
      assert.equal(page.isError, false, `${JSON.stringify(args).slice(0, 160)}: ${page.content[0].text?.slice(0, 300)}`);
      const text = page.content[0].text ?? '';
      withinBudget(text, 'a page through the server');
      seen.push(...shownSource(text));
      const note = linesOf(text).find((l) => NOTE.test(l));
      if (note === undefined) break;
      const at = note.indexOf('下一页：get_nodes ');
      assert.ok(at >= 0, `the note offers the next page: ${note.slice(0, 300)}`);
      args = jsonAt(note, at + '下一页：get_nodes '.length) as Record<string, unknown>;
      assert.deepEqual([args.reference, typeof args.cursor], [reference, 'string'], 'the same reference with a cursor');
    }
    assert.deepEqual(seen, markdown.split('\n'));
    // A text made without paging names text@1 lines and byte ranges instead: the server takes those references too.
    args = { reference };
    const ranged: string[] = [];
    for (let i = 0; i < 100; i++) {
      const page = await client.call('get_nodes', args);
      assert.equal(page.isError, false, `${JSON.stringify(args).slice(0, 160)}: ${page.content[0].text?.slice(0, 300)}`);
      const text = toolText('get_nodes', page.structuredContent);
      withinBudget(text, 'a page without paging');
      ranged.push(...shownSource(text));
      const note = linesOf(text).find((l) => NOTE.test(l));
      if (note === undefined) break;
      const at = note.indexOf('接着读：get_nodes ');
      assert.ok(at >= 0, `without paging the note offers a reference to read on: ${note.slice(0, 300)}`);
      args = jsonAt(note, at + '接着读：get_nodes '.length) as Record<string, unknown>;
      assert.equal(args.cursor, undefined, 'no cursor without paging');
    }
    assert.deepEqual(ranged, markdown.split('\n'));
    await client.close();
  });
});

test('recordDigest gives the digest hub/refs checks a record against (the in-memory reader of these tests is faithful)', async () => {
  const result = resultOf(items(30));
  const read: RecordRead = { kind: 'validation_result', schema: 'validation@1', provenance: 'projected', created_at: '2026-10-22T08:00:00.000Z', body: result };
  const digest = recordDigest(read);
  const context = memory(new Map(), new Map([[digest, read]]));
  const pages = await follow(context, `rec:${digest}#/partitions/delivered/0`, '逐个读：');
  assert.equal(pages.length, 1);
  assert.ok(pages[0].includes(`- ${result.partitions.delivered[0].item} | `));
});

test('get_nodes renders only relation references and one-line summaries, retaining the full backlink count',()=>{
  const root='a'.repeat(64),composition='b'.repeat(64),source=`tree:${root}/notes/one@${'c'.repeat(64)}`;
  const answer=GetNodesOutput.parse({call_result:'ok',errors:[],trace:TRACE,root,nodes:[{path:'/terms/alpha',reference:`tree:${root}/terms/alpha`,name:'alpha',level:'leaf',digest:'d'.repeat(64),children:[],entries:[],backlinks:{composition,configured:true,total:75,entries:[{reference:source,path:'/notes/one',summary:'一行合成摘要'}],truncated:true,notes:['还有 74 个反向引用']} }]});
  const text=toolText('get_nodes',answer);
  assert.match(text,/反向关联共 75 个条目/);assert.ok(text.includes(source));assert.ok(text.includes('一行合成摘要'));assert.match(text,/反向关联条目 74 个/);
});


test('node definitions and children precede relation hints and the omitted hint names an exact view',()=>{
  const root='a'.repeat(64),composition='b'.repeat(64),view='knowledge:links:widget:Rel_WIDGET_10_6_1_1?target=%2Fterms%2Falpha&composition='+composition;
  const ref='tree:'+root+'/terms/alpha';
  const answer={call_result:'ok',errors:[],trace:TRACE,root,nodes:[{path:'/terms/alpha',reference:ref,name:'alpha',level:'branch',digest:'d'.repeat(64),children:[{path:'/terms/alpha/child',name:'Own child',digest:'e'.repeat(64)}],entries:[{entry:'f'.repeat(64),kind:'definition',statement:'Own definition',applicability:'all',reference:ref+'@'+'f'.repeat(64)}],backlinks:{composition,configured:true,total:75,view_id:view,entries:[{reference:'tree:'+root+'/notes/one@'+'c'.repeat(64),path:'/notes/one',summary:'Related source'}],truncated:true,notes:[]}}]};
  const text=toolText('get_nodes',answer);
  assert.ok(text.indexOf('Own definition')<text.indexOf('Related source'));
  assert.ok(text.indexOf('Own child')<text.indexOf('Related source'));
  assert.ok(text.includes(view));
});

test('start_run prints the locked product-wide root beside the build root', () => {
  const run = {...runOf(items(1)),version:'10.6',unversioned_root:H('b')};
  const text = toolText('start_run',startAnswer(run));
  assert.match(text,new RegExp(`不分版本的知识根 ${H('b')}`));
});

test('large function-only structure summaries have real cursor continuation without inventing source text',()=>{
 const reference=`src:${H('e')}`;
 const summary=Object.fromEntries(Array.from({length:5000},(_,i)=>['field'+i,'value'+i]));
 const answer={call_result:'ok',errors:[],trace:TRACE,content:{reference,read_tier:'function_bytes_only',readable:false,structure:{parser:'xml@1',summary}}};
 const seen=new Set<number>();let cursor:string|undefined;
 for(let page=0;page<20;page++){
   const text=toolText('get_nodes',answer,{paging:true,...(cursor?{cursor}:{})});withinBudget(text,'structure summary');assert.ok(!text.includes('原文（'));
   for(const match of text.matchAll(/field(\d+) value\d+/g))seen.add(Number(match[1]));
   const next=/get_nodes (\{[^\n]*"cursor"[^\n]*?\})/.exec(text);
   if(!next)break;
   const parsed=JSON.parse(next[1]);assert.equal(parsed.reference,reference);assert.notEqual(parsed.cursor,cursor);cursor=parsed.cursor;
 }
 assert.equal(seen.size,5000);
});

test('start_run states the rules and ledger interpreters that judge each requirement',()=>{
 const run=runOf(items(1));
 run.requirements[0].rules=['range@1'];run.requirements[0].run_interpreters=['structure@1'];
 const text=toolText('start_run',startAnswer(run));
 assert.match(text,/规则 range@1/);assert.match(text,/运行内表的已裁定解释器 structure@1/);
});

test('criterion start notices distinguish pending expired and rejected requests with explicit next actions',()=>{
 const run=runOf(items(1)),base={item:run.items[0].id,criterion:SUBJECT,assertion:'合成变更',old:'旧判据',new:'新判据',grounds:[{reference:SUBJECT,quote:'合成引文'}],request:'rec:'+H('7'),declaration:'rec:'+H('8')+'#/criterion_changes/0',audience:'usr_'+'1'.repeat(26),due:'2026-10-25T08:00:00.000Z',answered:false,expired:false,next_action:'非作者绑定声明和 evidence 开复核'};
 for(const change of [base,{...base,expired:true},{...base,answered:true,accepted:false,reviewer:base.audience,reason:'合成不同意'}]){run.criterion_changes=[change];const text=toolText('start_run',startAnswer(run));assert.ok(text.includes(change.request));assert.ok(text.includes(change.due));assert.ok(text.includes(change.next_action));if(change.expired)assert.match(text,/已过期.*新修订不带/);if(change.answered)assert.ok(text.includes('合成不同意'));else assert.match(text,/还没有回答|仍等作者以外/);withinBudget(text,'criterion notices');}
});
test('criterion result text shows all replacement values and review attribution',()=>{
 const result=resultOf(items(1)),row=result.partitions.delivered[0];row.replaced_criteria=[{criterion:SUBJECT,old:'合成旧值',new:'合成新值',declaration:'rec:'+H('8')+'#/criterion_changes/0',review:'rec:'+H('7'),reviewer:'usr_'+'1'.repeat(26)}];const text=toolText('submit_result',submitAnswer(result));for(const value of Object.values(row.replaced_criteria[0]))assert.ok(text.includes(value));assert.match(text,/被取代的判据/);
});
test('superseded criterion declarations are displayed as replaced rather than unanswered',()=>{
 const run=runOf(items(1));run.criterion_changes=[{item:run.items[0].id,criterion:SUBJECT,assertion:'旧声明',old:'旧判据',new:'先前提议',grounds:[{reference:SUBJECT,quote:'合成'}],request:'rec:'+H('7'),declaration:'rec:'+H('8')+'#/criterion_changes/0',audience:'usr_'+'1'.repeat(26),due:'2026-10-25T08:00:00.000Z',answered:true,expired:false,superseded_by:'rec:'+H('6'),next_action:'按后一份提交的新请求复核'}] as any;
 const text=toolText('start_run',startAnswer(run));assert.match(text,/由后一份提交的同名声明取代/);assert.ok(text.includes('rec:'+H('6')));assert.ok(!text.includes('还没有回答'));
});
