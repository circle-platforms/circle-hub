import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
// Synthetic answers retain their structured data while reader-facing text uses the agreed vocabulary.
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
import { cursorPosition, fallbackText, modelReferencesText, pageCursor, pageCursorProblem, startRunExample, submitExample, toolText, type TextContext } from './text.ts';

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
    fields: { autoid: `CASE-${i}`, priority: i % 3, expected: ['期望'] },
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
const itemIdsOf = (text: string): string[] => linesOf(text).flatMap(line => /^原始用例 CASE-(\d+) /.exec(line)?.[1]).filter((value): value is string => value !== undefined).map(value => `doc7:n${value}`);

function noteOf(text: string, _trace = TRACE): string | null {
  assert.doesNotMatch(text, /^追踪 /m);
  const notes = linesOf(text).filter(line => NOTE.test(line));
  assert.ok(notes.length <= 1);
  return notes[0] ?? null;
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
  const end = lines.length - (NOTE.test(lines.at(-1) ?? '') ? 1 : 0);
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

/** No answer is cut to a length (decisions 157 and 158): nothing is left out for want of room. */
function withinBudget(text: string, what: string): void {
  assert.doesNotMatch(text, /个字符为限/, `${what}: nothing is left out for a budget`);
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
const run=runOf(items(n));const answer=startAnswer(run);const text=toolText('start_run',answer,{record:RUN_RECORD});withinBudget(text,'all original cases');assert.deepEqual(itemIdsOf(text),run.items.map(item=>item.id));assert.match(text,/本次核对采用构建 b-2.1-7/);assert.match(text,/原始用例 CASE-0 合成用例 0.*状态未知/);assert.doesNotMatch(text,/rec:|src:|知识根|本层不适用|追踪|槽位模式/);assert.equal(answer.run?.root,H('d'));
});
  }

  test('the inputs that accept the type of a read source follow the sources (decision 113)', () => {
const accepted_by=[{type:'toy:mindmap',inputs:[{pack:'toy-review@1.0.0',slot:'map',role:'subject'}]}];const answer=startAnswer(runOf(items(3)),{accepted_by});const text=toolText('start_run',answer);assert.equal(answer.accepted_by?.[0].type,'toy:mindmap');assert.doesNotMatch(text,/toy:mindmap|输入 map/);assert.equal(itemIdsOf(text).length,3);
});

  test('a run of a pack that ships tools/ names the local tools and the install command once, after the facts of the run', () => {
const install='circle-hub local-tools install toy-review@1.0.0 --digest '+H('a')+' --into <目录>';const local_tools={count:1,files:[{path:'tools/fetch-run.ts',sha256:H('b'),size:81}],install};const answer=startAnswer(runOf(items(3)),{local_tools});const text=toolText('start_run',answer);assert.equal(answer.local_tools?.install,install);assert.doesNotMatch(text,/--digest|fetch-run|a{64}/);assert.equal(itemIdsOf(text).length,3);
});

  test('the example skeleton parses with Submission once its lists are filled, and the slot records validate against the slot schema', () => {
const run=runOf(items(62));const submission=filled(submitExample(run),run);const slots=z.fromJSONSchema(run.slots!.schema as Parameters<typeof z.fromJSONSchema>[0]);for(const item of submission.items)assert.ok(item.handling==='handled'&&slots.safeParse(item.slots).success);assert.ok(!slots.safeParse({findings:[{text:'x',code:'nope',rank:'major',grounds:[SUBJECT]}]}).success);const text=toolText('start_run',startAnswer(run));assert.doesNotMatch(text,/示例 submit_result|"slots"/);
});

  test('the slot schema is compact: every key, closed set, bound and rule, in a fraction of the JSON Schema', () => {
const run=runOf(items(5));const answer=startAnswer(run);assert.ok(answer.run?.slots);const schema=JSON.stringify(answer.run.slots.schema);for(const code of [...PROBES,...RANKS,'level','P0','P2'])assert.ok(schema.includes(code),code);const text=toolText('start_run',answer);assert.doesNotMatch(text,/slots|literal_issue|sha256/);
});

  test('a run of 3000 items, some with long labels, lists every item once in order (decision 158: no length budget)', () => {
const list=items(3000,i=>'合成用例 '+i+(i%97===0?' 长标题'.repeat(300):''));for(const context of [{paging:true,record:RUN_RECORD},{record:RUN_RECORD},{}]){const text=toolText('start_run',startAnswer(runOf(list)),context);assert.deepEqual(itemIdsOf(text),list.map(item=>item.id));assert.ok(text.includes(list[0].label));withinBudget(text,'3000 cases');}
});

  test('a long procedure stays whole in machine data and does not enter reader prose', () => {
const steps=Array.from({length:2000},(_,i)=>'第 '+(i+1)+' 步：逐条核对用例里的命令与参数。');const answer=startAnswer(runOf(items(5),{instructions:steps.join('\n')}));const text=toolText('start_run',answer);assert.equal(answer.run?.instructions,steps.join('\n'));assert.doesNotMatch(text,/第 \d+ 步/);assert.equal(itemIdsOf(text).length,5);
});

  test('an error answer names its codes and every fix within the budget, long messages shortened and named', () => {
const errors:ProtocolError[]=Array.from({length:20},(_,i)=>({code:'SUBMISSION_SCHEMA_VIOLATION',message:'参数 '+i+' 不对：'+'很长的说明'.repeat(1000),fix:'使用者补齐资料',path:'/inputs/s'+i}));const answer=StartRunOutput.parse({call_result:'error',errors,trace:TRACE});const text=toolText('start_run',answer);assert.equal(linesOf(text).filter(line=>line.startsWith('参数无效：')).length,20);for(let i=0;i<20;i++)assert.ok(text.includes('参数 '+i+' 不对：'));assert.doesNotMatch(text,/^这次核对有错误。|状态已确认|判断错误|决定者程序|原因还没查清|原因缺资料|SUBMISSION_SCHEMA_VIOLATION|\/inputs\/|追踪/);assert.equal(answer.errors.length,20);const unknown=toolText('start_run',StartRunOutput.parse({call_result:'error',errors:[{code:'SOURCE_UNAVAILABLE',message:'对你不可用',fix:'使用者请管理员核对权限'}],trace:TRACE}));assert.match(unknown,/^资料尚未取得。/);assert.match(unknown,/当前账户读不到这份资料；状态未知；原因缺资料；下一步由使用者联系管理员核对；决定者程序/);assert.doesNotMatch(unknown,/对你不可用|判断错误|这次核对有错误|参数无效|无权限/);
});

  test('D1: call refusals use the five-category sentence form without a status string', () => {
const absent=toolText('start_run',StartRunOutput.parse({call_result:'error',errors:[{code:'SOURCE_ABSENT',message:'Hub 里没有名为「toy-missing」的工作流或技能',fix:'请核对名称',path:'/pack'}],trace:TRACE}));assert.equal(absent,'不存在：Hub 里没有名为「toy-missing」的工作流或技能。请核对名称。');assert.doesNotMatch(absent,/这次核对有错误|资料尚未取得|状态已确认|判断错误|决定者程序|原因|任务包/);
const denied=toolText('start_run',StartRunOutput.parse({call_result:'error',errors:[{code:'SOURCE_NOT_PERMITTED',message:'当前账户未获授权使用工作流「recompose」',fix:'请联系管理员为该账户或所在团队分配此工作流',path:'/pack'}],trace:TRACE}));assert.equal(denied,'无权限：当前账户未获授权使用工作流「recompose」。请联系管理员为该账户或所在团队分配此工作流。当前账户可用的工作流和技能用 list_task_packs 查看。');assert.doesNotMatch(denied,/这次核对有错误|资料尚未取得|状态已确认|判断错误|决定者程序|原因|任务包/);

const schema=toolText('start_run',StartRunOutput.parse({call_result:'error',errors:[{code:'SUBMISSION_SCHEMA_VIOLATION',message:'/pack 是必填的字符串，这次没有给出',fix:'请在 /pack 写 list_task_packs 返回的编号',path:'/pack'}],trace:TRACE}));assert.equal(schema,'参数无效：/pack 是必填的字符串，这次没有给出。请在 /pack 写 list_task_packs 返回的编号。');
const retryable=toolText('start_run',StartRunOutput.parse({call_result:'error',errors:[{code:'SOURCE_RETRYABLE',message:'来源暂时读不到',fix:'按给出的下次时刻重读'}],trace:TRACE}));assert.equal(retryable,'暂时不可用：来源暂时读不到。按给出的下次时刻重读。');assert.doesNotMatch(retryable,/这次核对有错误|状态已确认|判断错误|决定者程序|原因/);
});

  test('requirement facts say the accepted producer only: no producer kind the contracts do not give', () => {
const text=toolText('start_run',startAnswer(runOf(items(5))));assert.doesNotMatch(text,/生产者|接受的生产者|记账型|门禁型/);assert.match(text,/决定者程序/);const run=runOf(items(1));delete run.items[0].fields.autoid;run.items[0].fields.case_id='CASE-0';run.items[0].label='CASE-0';const recomposed=toolText('start_run',startAnswer(run));assert.match(recomposed,/原始用例 CASE-0 标题未知/);assert.doesNotMatch(recomposed,/原始用例 CASE-0 CASE-0/);
});

  test('item locations: one rule when they follow the ids; per item for a short list without one; where to read them for a long one', () => {
for(const count of [5,300,3000]){const list=items(count).map((item,i)=>({...item,location:SUBJECT+'/kityminder@1/n/x'+i*7}));const answer=startAnswer(runOf(list));const text=toolText('start_run',answer);assert.equal(itemIdsOf(text).length,count);assert.doesNotMatch(text,/src:|doc7:n|位置：/);assert.equal(answer.run?.items[1].location,list[1].location);}
});

  test('an item label too long for a line keeps the item: id, the start of the label, where the whole is, and the note says so', () => {
const list=items(5,i=>i===2?'超长的标题'.repeat(3200):'合成用例 '+i);for(const context of [{record:RUN_RECORD},{}]){const text=toolText('start_run',startAnswer(runOf(list)),context);assert.ok(text.includes(list[2].label));assert.equal(itemIdsOf(text).length,5);assert.equal(noteOf(text),null);}
});

  test('reported source metadata stays in model context rather than reader conclusions', () => {
const answer=startAnswer(runOf(items(5)));const gaps=[{code:'runs.expected_sources_failed',message:'手册尚未读出'}];const text=toolText('start_run',answer,{gaps});assert.doesNotMatch(text,/手册尚未读出|runs.expected_sources_failed/);const model=JSON.parse(modelReferencesText(answer,{gaps}).slice('供模型引用\n'.length));assert.deepEqual(model.source_context.gaps,gaps);
});
});

// ---------------------------------------------------------------- production runs

describe('a production run in the start_run text', () => {
  test('production explanations render only valid support facts produced by functions', () => {
const list=items(1),result=resultOf(list,{production:true});const original=result.partitions.delivered[0].requirements[0].claims[0];original.statement.text='检查算出 2 个空组';const answer=startAnswer(runOf(list,{production:true}),{result:{reference:RESULT_RECORD,counts:partitionCountsOf(result.partitions)}});const text=toolText('start_run',answer,{production:result});assert.match(text,/检查算出 2 个空组；状态已确认；判断正确/);original.warrant={producer:'model',id:'scripted-model@test'};assert.match(toolText('start_run',answer,{production:result}),/状态未确认；判断正确/);original.validity.status='cited_fragment_changed';assert.match(toolText('start_run',answer,{production:result}),/状态未知/);const helpRun=runOf(list);helpRun.device_help=[{...original,statement:{text:'合成设备的命令说明',data:{help:'show test\nvalue\u001b'}},qualifier:{...original.qualifier,nature:'fact'},warrant:{producer:'function',id:'scripted-help@1'},validity:{status:'valid',bound:[],premises:[]}}];const help=toolText('start_run',startAnswer(helpRun));assert.match(help,/设备输出/);assert.ok(help.includes('show test\nvalue\\x1b'));assert.ok(!help.includes('\u001b'));
});
  for (const n of SIZES) {
    test(`${n} items: the result first (counts, every requirement, where the whole is), then every problem and unknown, then the rest`, () => {
const list=items(n),run=runOf(list,{production:true}),result=resultOf(list,{production:true});const answer=startAnswer(run,{result:{reference:RESULT_RECORD,counts:partitionCountsOf(result.partitions)}});const text=toolText('start_run',answer,{production:result});assert.equal(itemIdsOf(text).length,n);assert.match(text,/原始用例 CASE-0 合成用例 0.*状态已确认；判断正确/);assert.doesNotMatch(text,/分区：|静态：|动态：|本层不适用|rec:/);if(n>7)assert.match(text,/原始用例 CASE-7 合成用例 7.*状态未知/);
});
  }

  test('a long procedure remains in machine data without displacing any reader conclusion', () => {
const list=items(3000),result=resultOf(list,{production:true});const procedure=Array.from({length:120},(_,i)=>'第 '+i+' 步：核对原始用例。').join('\n');const answer=startAnswer(runOf(list,{production:true,instructions:procedure}),{result:{reference:RESULT_RECORD,counts:partitionCountsOf(result.partitions)}});const text=toolText('start_run',answer,{production:result});assert.equal(itemIdsOf(text).length,3000);assert.equal(answer.run?.instructions,procedure);assert.doesNotMatch(text,/核对说明|第 \d+ 步/);
});

  test('without the whole result the text still gives the counts and where the problems are', () => {
const list=items(62),result=resultOf(list,{production:true});const answer=startAnswer(runOf(list,{production:true}),{result:{reference:RESULT_RECORD,counts:partitionCountsOf(result.partitions)}});const text=toolText('start_run',answer);assert.equal(itemIdsOf(text).length,62);assert.match(text,/状态未知/);assert.equal(answer.result?.reference,RESULT_RECORD);assert.doesNotMatch(text,/rec:/);
});
});

// ---------------------------------------------------------------- submit_result

describe('submit_result text', () => {
  // Lead-form cases: c257ec306a briefly dropped the surrounding text-next submit tests; c155957c4a restored them with neutral-lead asserts.
  test('lead sentence uses step_name when present, else the neutral form (CHANGELOG Unreleased: submit_result lead / step_name)', () => {
    const accepted = submitAnswer(resultOf(items(1)));
    assert.equal(toolText('submit_result', accepted).split('\n')[0], '核对已完成。');
    assert.equal(toolText('submit_result', SubmitResultOutput.parse({ ...accepted, step_name: '用例重组' })).split('\n')[0], '用例重组已核对。');
    assert.equal(toolText('submit_result', SubmitResultOutput.parse({ ...accepted, step_name: ' 用例重组 \n' })).split('\n')[0], '用例重组已核对。');
    const refused = submitAnswer(ValidationResult.parse({
      ...resultOf(items(1)),
      acceptance: 'not_accepted',
      errors: [{ code: 'QUOTE_MISMATCH', message: '原句对不上', fix: '使用者按原文逐字引用', path: '/items/0', rounds_left: 1 }],
      partitions: { delivered: [], rejected: [], quarantined: [], incomplete: [] },
      cross_item: [],
    }));
    assert.equal(toolText('submit_result', refused).split('\n')[0], '核对有错误。');
    assert.equal(toolText('submit_result', SubmitResultOutput.parse({ ...refused, step_name: '脚本编写' })).split('\n')[0], '脚本编写有错误。');
    assert.equal(SubmitResultOutput.safeParse({ ...accepted, step_name: '   ' }).success, false);
  });

  test('recompose acceptance: title from fields, no repeated slot judgment or quote lines, no evidence restating quotes', () => {
const list=[{...items(1)[0],fields:{case_id:'253651793153361064',title:'253 字符域名 DNS 解析正常'},label:'253651793153361064'}];
const quoteA='引文 “253 字符域名 DNS 解析正常” 与所引片段逐字一致';
const quoteB='引文 “解析正确返回地址” 与所引片段逐字一致';
const check='重组结构和原文全集已核对；原文、改写、具体取值、重新绑定四类记录已核对；来源状态与缺口是模型判断，交给脚本编写';
const result=resultWith({delivered:[{item:list[0].id,label:list[0].label,location:list[0].location,requirements:[{requirement:'record',layers:[{layer:'static',terminal:'judgment'}],status:'satisfied',claims:[
 claim(list[0].id,'record','模型的重组判断'),
 claim(list[0].id,'record','模型的重组判断'),
 {...fact(list[0].id,'record',check),warrant:{producer:'function',id:'recompose-check@1'}},
 fact(list[0].id,'record',quoteA),
 fact(list[0].id,'record',quoteB),
 fact(list[0].id,'record',quoteA),
]}]}]});
const text=toolText('submit_result',submitAnswer(result),{items:list});
assert.match(text,/原始用例 253651793153361064 253 字符域名 DNS 解析正常：重组结构和原文全集已核对；原文、改写、具体取值、重新绑定四类记录已核对；来源状态与缺口是模型判断，交给脚本编写；引文 “253 字符域名 DNS 解析正常” 与所引片段逐字一致；引文 “解析正确返回地址” 与所引片段逐字一致；状态未确认；判断正确；决定者/);
assert.equal(text.split('模型的重组判断').length-1,0);
assert.equal(text.split(quoteA).length-1,1);
assert.doesNotMatch(text,/证据|标题未知|四账|编写阶段/);
});

  for (const n of SIZES) {
    test(`${n} items: the receipt and counts first, each requirement's state, the errors, then every problem, then the details`, () => {
const list=items(n),result=resultOf(list,{claims:2});const answer=submitAnswer(result);const text=toolText('submit_result',answer,{record:RESULT_RECORD,items:list});withinBudget(text,'all conclusions');assert.equal(itemIdsOf(text).length,n);assert.match(text,/原始用例 CASE-0 合成用例 0.*状态未确认；判断正确/);if(n>9)assert.match(text,/原始用例 CASE-9 合成用例 9.*状态未知/);assert.doesNotMatch(text,/回执：|分区：|本层不适用|追踪|doc7:n|rec:/);assert.equal(answer.result?.run,RUN);
});
  }

  test('a delivered item with a violation or an unsatisfied requirement is a problem: counted first, listed one line each', () => {
const list=items(400);const result=resultWith({delivered:list.map(item=>({item:item.id,label:item.label,location:item.location,requirements:[{requirement:'structure',layers:[{layer:'static',terminal:'violation',code:'core.structure.duplicate_key',tier:'blocking',attribution:'author_input'}],status:'unsatisfied',unsatisfied_reason:'outcome_mismatch',claims:[fact(item.id,'structure','用例重复')]}]}))});const text=toolText('submit_result',submitAnswer(result),{items:list});assert.equal(itemIdsOf(text).length,400);assert.equal(linesOf(text).filter(line=>line.includes('判断错误；原因原始用例的问题')).length,400);assert.doesNotMatch(text,/core.structure|structure|静态/);
});

  test('cross-item claims (the verdict and level of the run) survive a large receipt', () => {
const result=resultOf(items(1000));result.cross_item=[{statement:{text:'脚本合并仍有问题',verdict:'refute'},qualifier:{nature:'judgment',provenance:'declared',marks:[]},grounds:[SUBJECT],warrant:{producer:'model',id:'scripted-model@test'},validity:{status:'valid',bound:[],premises:[]}}];const text=toolText('submit_result',submitAnswer(result));assert.match(text,/脚本合并仍有问题；状态未确认；判断错误；原因还没查清/);assert.doesNotMatch(text,/scripted-model|src:/);
});

  test('a repeat names this call’s trace last and the trace of the call that produced the stored result', () => {
const result=resultOf(items(400));const first=toolText('submit_result',submitAnswer(result,TRACE),{items:items(400)});const again=toolText('submit_result',submitAnswer(result,TRACE_2),{items:items(400)});assert.equal(first,again);assert.doesNotMatch(again,/追踪/);assert.equal(result.trace,TRACE);
});

  test('a submission that is not accepted: per-code counts first, every error with its rounds left, the stored result for the rest', () => {
const errors:ProtocolError[]=Array.from({length:600},(_,i)=>({code:'QUOTE_MISMATCH',message:'原句 '+i+' 与资料对不上',fix:'使用者按原文逐字引用',path:'/items/'+i,rounds_left:1}));const result=ValidationResult.parse({...resultOf(items(1)),acceptance:'not_accepted',errors,partitions:{delivered:[],rejected:[],quarantined:[],incomplete:[]},cross_item:[]});const answer=submitAnswer(result);const text=toolText('submit_result',answer,{record:RESULT_RECORD});assert.equal(linesOf(text).filter(line=>line.includes('还可以重交 1 次')).length,600);assert.match(text,/参数无效：原句 0 与资料对不上。使用者按原文逐字引用。还可以重交 1 次。/);assert.doesNotMatch(text,/状态已确认|判断错误|决定者程序|原因还没查清|QUOTE_MISMATCH|\/items\/|rec:/);assert.equal(answer.errors.length,600);
});
});

// ---------------------------------------------------------------- get_nodes

describe('get_nodes text', () => {
  test('a 3000-item validation result read by reference: every page within the budget, every item exactly once', () => {
const list=items(3000,i=>i%501===0?'长标题 '+'很'.repeat(5000):'合成用例 '+i);const result=resultOf(list,{claims:3,claimText:(i,k)=>i%733===0&&k===0?'超长的发现'.repeat(9000):'第 '+k+' 条发现'});const answer=contentAnswer(RESULT_RECORD,canonicalJson(result));const text=toolText('get_nodes',answer,{items:list});assert.equal(itemIdsOf(text).length,3000);assert.ok(text.includes('超长的发现'.repeat(9000)));assert.doesNotMatch(text,/rec:|追踪/);
});

  for (const n of SIZES.slice(0, 3)) {
    test(`a ${n}-item result read by reference: within the budget, every item once, a note only while pages remain`, () => {
const result=resultOf(items(n),{claims:2});const text=toolText('get_nodes',contentAnswer(RESULT_RECORD,canonicalJson(result)),{items:items(n)});assert.equal(itemIdsOf(text).length,n);assert.equal(noteOf(text),null);withinBudget(text,'stored conclusions');
});
  }

  test('a partition or one item read by pointer is shown as items; a cursor of another reference starts over and says so', () => {
const list=items(30),result=resultOf(list);const item=result.partitions.incomplete[0];const text=toolText('get_nodes',contentAnswer(RESULT_RECORD+'#/partitions/incomplete/0',canonicalJson(item)),{items:list});assert.match(text,/原始用例 CASE-9 合成用例 9.*状态未知/);assert.doesNotMatch(text,/doc7:n|本层不适用/);assert.equal(pageCursorProblem(RESULT_RECORD,pageCursor(RESULT_RECORD,3)),null);assert.equal(pageCursorProblem(RESULT_RECORD,pageCursor(RESULT_RECORD+'#/x',3))===null,false);
});

  test('an empty partition, an empty item list and an empty array read by reference: the head says so, with and without paging', () => {
for(const context of [{},PAGING,{...PAGING,cursor:pageCursor(RESULT_RECORD,0)}]){for(const suffix of ['#/partitions/rejected','#/items','']){const text=toolText('get_nodes',contentAnswer(RESULT_RECORD+suffix,'[]'),context);assert.equal(text,'没有原始用例。');}}
});

  test('a cursor whose offset falls inside a surrogate pair is not a page position: the page starts over and says so, never with half a character', () => {
const value='甲😀乙';const reference='src:'+H('b');const text=toolText('get_nodes',contentAnswer(reference,value),{cursor:pageCursor(reference,0,2)});assert.ok(text.endsWith(value));assert.match(text,/读取位置无效/);assert.doesNotMatch(text,/�/);
});

  test('a text that cannot be laid out gives a minimal text: the outcome, the receipt, the run, the stored result, the trace', () => {
const text=fallbackText('submit_result',submitAnswer(resultOf(items(5))),{record:RESULT_RECORD});assert.match(text,/状态未知；原因临时故障；下一步/);assert.doesNotMatch(text,/rec:|run_|追踪/);assert.doesNotThrow(()=>fallbackText('get_nodes',null));
});

  test('a source goes out whole in one answer, its long lines and astral characters untouched, and a cursor reads on from its place', () => {
const text='甲😀'.repeat(14000)+'\n下一行\n';const reference='src:'+sha256(Buffer.from(text));const first=toolText('get_nodes',contentAnswer(reference,text));assert.equal(shownSource(first).join('\n'),text);const later=toolText('get_nodes',contentAnswer(reference,text),{cursor:pageCursor(reference,1,0)});assert.equal(shownSource(later).join('\n'),'下一行\n');
});

  test('a long string of a record (a 40,000-character statement) goes out whole', () => {
const statement='一份很长的结论'.repeat(8000);const text=toolText('get_nodes',contentAnswer(RESULT_RECORD+'#/statement/text',JSON.stringify(statement)));assert.equal(text,statement);
});

  test('other record JSON is laid out one member a line: the full slot schema reads without placeholders', () => {
const value={slots:{schema:{properties:{findings:{type:'array',items:{type:'string'}}}}}};const answer=contentAnswer(RESULT_RECORD,canonicalJson(value));const text=toolText('get_nodes',answer);assert.equal(text,'资料已读取，完整内容在机器可读答复中。');assert.deepEqual(JSON.parse(answer.content!.text!),value);assert.doesNotMatch(text,/slots|properties/);
});

  test('a page of many nodes shows every node with all its entries and children (decision 158)', () => {
const root=H('d');const nodes=Array.from({length:100},(_,i)=>({path:'/catalog/menu'+i,reference:'tree:'+root+'/catalog/menu'+i,name:'menu'+i,level:'branch',digest:H('3'),children:Array.from({length:30},(_,k)=>({name:'item'+k,path:'/catalog/menu'+i+'/item'+k,digest:H('4')})),entries:Array.from({length:4},(_,k)=>({entry:H('5'),kind:'definition',statement:'menu'+i+' 的第 '+k+' 个签名',reference:'tree:'+root+'/catalog/menu'+i+'@'+H('5')}))}));const answer=GetNodesOutput.parse({call_result:'ok',errors:[],root,nodes,trace:TRACE});const text=toolText('get_nodes',answer);assert.equal(linesOf(text).filter(line=>/^menu\d+$/.test(line)).length,100);assert.equal(linesOf(text).filter(line=>/个签名$/.test(line)).length,400);assert.equal(linesOf(text).filter(line=>/^item\d+$/.test(line)).length,3000);assert.doesNotMatch(text,/tree:|枝|sha256/);const contribution={layer:'contribution',product:'synthetic',root,path:'/catalog/menu0',cited_fragment:H('6'),kind:'assertion',statement:'保留的原句',source:{reference:'src:'+H('b'),quote:'原句',fragment:H('7'),provenance:'observed',records:[H('8')],sources:[H('b')]},relation:{kind:'contradicts',other:{reference:'src:'+H('c'),quote:'另一原句',fragment:H('8'),provenance:'observed',records:[H('9')],sources:[H('c')]}},submitted_by:'usr_0123456789abcdefghjkmnpqrs',session:null,submitted_at:'2026-01-01T00:00:00.000Z',model:'scripted-model@test',basis_rank:'judgment',applicability:null};const withdrawn=toolText('get_nodes',{...answer,nodes:[{...answer.nodes![0],contributions:[{record:H('9'),contribution,status:'grounds_withdrawn',note:'旧内部提示'}]}]});assert.match(withdrawn,/资料或证据已撤回/);assert.match(withdrawn,/两份资料的说法有冲突；状态未知/);assert.doesNotMatch(withdrawn,/旧内部提示|rec:|usr_/);
});

  test('a manual section of 137 entries shows all of them: run 9 got 23 and untitled references for the rest', () => {
const root=H('d'),path='/manual/cli/合成命令';const entries=Array.from({length:137},(_,i)=>({entry:H('5'),kind:'behaviour',statement:'合成命令 '+i+' '+'说明'.repeat(300),reference:'tree:'+root+path+'@'+H('5')}));const answer=GetNodesOutput.parse({call_result:'ok',errors:[],root,nodes:[{path,reference:'tree:'+root+path,name:'合成命令',level:'leaf',digest:H('3'),children:[],entries}],trace:TRACE});const text=toolText('get_nodes',answer);for(const entry of entries)assert.ok(text.includes(entry.statement));assert.equal(linesOf(text).filter(line=>/^合成命令 \d+ /.test(line)).length,137);assert.doesNotMatch(text,/tree:|适用/);
});

  test('a node with 2000 children shows its entries first, then every child', () => {
const root=H('d'),path='/commands/show';const node={path,reference:'tree:'+root+path,name:'show',level:'branch',digest:H('3'),children:Array.from({length:2000},(_,i)=>({name:'option'+i,path:path+'/option'+i,digest:H('4')})),entries:Array.from({length:3},(_,i)=>({entry:H('5'),kind:'definition',statement:'show 的第 '+i+' 个签名',reference:'tree:'+root+path+'@'+H('5')}))};const text=toolText('get_nodes',GetNodesOutput.parse({call_result:'ok',errors:[],root,nodes:[node],trace:TRACE}));assert.equal(linesOf(text).filter(line=>/^option/.test(line)).length,2000);assert.ok(text.indexOf('show 的第 2 个签名')<text.indexOf('option0'));
});

  test('the text of a small source is given whole, verbatim', () => {
const text='# 标题\r\n\r\n正文第一行\n正文第二行';assert.equal(toolText('get_nodes',contentAnswer('src:'+H('e'),text)),'原文（'+text.length+' 个字符）：\n'+text);
});
});

// ---------------------------------------------------------------- list_task_packs, upload_file, resolve_reference

function packOf(i: number): PackSummary {
  return {
    pack: `toy-pack-${i}@1.0.${i}`,
    id: `toy-pack-${i}`,
    version: `1.0.${i}`,
    kind: 'workflow',
    title: `合成工作流 ${i}`,
    description: '评审合成的思维导图（合成）',
    digest: `${String(i)}${'0'.repeat(64)}`.slice(0, 64),
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
  test('member list names usable count and unassigned remainder without listing names (Boss 03:45 #4)', () => {
    const base = ListTaskPacksOutput.parse({ call_result: 'ok', errors: [], packs: [], index: [], trace: TRACE });
    const text = toolText('list_task_packs', { ...base, member_capabilities: { unassigned_workflows_count: 5 } } as typeof base);
    assert.match(text, /^当前账户可用的工作流和技能共 0 个。另有 5 个未分配给当前账户，名称不列出。请联系管理员把该账户加入团队或分配工作流。/);
    assert.doesNotMatch(text, /toy-pack|没有这个包/);
  });

  test('list_task_packs prose carries the environment-assignment preview while enforcement is off', () => {
    const base = ListTaskPacksOutput.parse({ call_result: 'ok', errors: [], packs: [], index: [], trace: TRACE });
    const preview = '测试环境的分配还没有启用，现在谁能预订仍按工作流的分配和预订规则判断。下面列出的测试环境分配只是预览，不代表现在的许可。';
    const off = toolText('list_task_packs', {
      ...base,
      member_capabilities: { unassigned_workflows_count: 0, environmentAccess: { enforced: false } },
    } as typeof base);
    assert.ok(off.includes(preview));
    const on = toolText('list_task_packs', {
      ...base,
      member_capabilities: { unassigned_workflows_count: 0, environmentAccess: { enforced: true } },
    } as typeof base);
    assert.equal(on.includes(preview), false);
  });

  test('a long task-pack list and an oversized pack are given whole, every detail of every pack (decision 158)', () => {
const packs=Array.from({length:300},(_,i)=>packOf(i));const answer=ListTaskPacksOutput.parse({call_result:'ok',errors:[],packs,trace:TRACE});const text=toolText('list_task_packs',answer);for(const pack of packs)assert.ok(text.includes(pack.title+'，'+pack.description));assert.doesNotMatch(text,/toy-pack-|start_run|sha256/);const oversized={...packOf(1),inputs:Array.from({length:300},(_,i)=>({...packOf(1).inputs[0],slot:'input_'+i,description:'说明'+i}))};const large=toolText('list_task_packs',ListTaskPacksOutput.parse({call_result:'ok',errors:[],packs:[oversized],trace:TRACE}));assert.equal(linesOf(large).filter(line=>/^说明\d+，/.test(line)).length,300);
});

  test('every pack is in the index whatever the offset, then the declared run context, then the details (decision 113)', () => {
const index=[0,1,2].map(i=>({pack:packOf(i).pack,title:packOf(i).title,kind:'workflow' as const}));const context={leases:[],observations:[{label:'合成设备',build:'Toy_1_0_7',base:'Toy_1_0_7',observed_at:'2026-01-02T00:00:00.000Z',packs:['toy-pack-1@1.0.1']}]};const answer=ListTaskPacksOutput.parse({call_result:'ok',errors:[],packs:[packOf(2)],index,context,trace:TRACE});const text=toolText('list_task_packs',answer,{packList:{offset:2}});assert.deepEqual(linesOf(text).slice(1,4),index.map(row=>row.title));assert.match(text,/测试环境 合成设备，构建 Toy_1_0_7；读取时间 \d{2}-\d{2} \d{2}:\d{2}（UTC[+-]\d+(?::\d{2})?）/);assert.doesNotMatch(text,/2026-01-02T|run_|租约/);
});

  test('a knowledge view input is shown in the form its parser requires, not as a bare number', () => {
const pack={...packOf(1),inputs:[{slot:'facets',role:'subject' as const,description:'结构计数资料',accepts:['knowledge:facets'],required:true,many:false}]};const answer=ListTaskPacksOutput.parse({call_result:'ok',errors:[],packs:[pack],trace:TRACE});const text=toolText('list_task_packs',answer);assert.match(text,/结构计数资料，必填/);assert.equal(answer.packs[0].inputs[0].accepts[0],'knowledge:facets');assert.doesNotMatch(text,/knowledge:facets|facets/);
});

  test('every pack with its inputs, parameters and an example start_run call that parses with StartRunInput and names a product', () => {
const packs=[packOf(1),packOf(2)];const answer=ListTaskPacksOutput.parse({call_result:'ok',errors:[],packs,trace:TRACE});const text=toolText('list_task_packs',answer);for(const pack of packs){for(const input of pack.inputs)assert.ok(text.includes(input.description));for(const parameter of pack.parameters)assert.ok(text.includes(parameter.description));const call=StartRunInput.parse(JSON.parse(startRunExample(pack)));assert.equal(call.product,'Meadow');assert.deepEqual(Object.keys(call.inputs),['map','notes']);assert.deepEqual(call.parameters,{depth:'<depth>'});}assert.doesNotMatch(text,/"inputs"|示例 start_run/);
});

  test('a pack that ships tools/ shows one local-tools line with the digest-pinned install command; a pack without none', () => {
const install='circle-hub local-tools install toy-pack-1@1.0.1 --digest '+H('a')+' --into <目录>';const tools={count:2,files:[{path:'tools/fetch-run.ts',sha256:H('b'),size:81},{path:'tools/generate-workbook.ts',sha256:H('c'),size:97}],install};const answer=ListTaskPacksOutput.parse({call_result:'ok',errors:[],packs:[{...packOf(1),local_tools:tools},packOf(2)],trace:TRACE});const text=toolText('list_task_packs',answer);assert.equal(linesOf(text).filter(line=>line==='已提供 2 个本地工具。').length,1);assert.equal(answer.packs[0].local_tools?.install,install);assert.doesNotMatch(text,/--digest|a{64}/);
});

  test('an upload with a large structure summary gives it whole', () => {
const summary=Object.fromEntries(Array.from({length:5000},(_,i)=>['element'+i,i]));const answer=UploadFileOutput.parse({call_result:'ok',errors:[],acceptance:'accepted',reference:'src:'+H('e'),sha256:H('e'),size:12,media_type:'application/xml',structure:{parser:'xml@1',summary},trace:TRACE});const text=toolText('upload_file',answer);assert.equal(text,'资料已上传，共 12 字节。');assert.equal(Object.keys(answer.structure!.summary as object).length,5000);assert.doesNotMatch(text,/src:|sha256|element0/);
});

  test('resolve_reference with many long candidates lists every one, long texts shortened by field', () => {
const references=Array.from({length:2000},(_,i)=>({reference:'src:'+H('e')+'/text@1/l/'+(i+1),text:'候选 '+i+'：'+'原文'.repeat(i%50===0?3000:20),role:'expected' as const}));const answer=ResolveReferenceOutput.parse({call_result:'ok',errors:[],resolution:'ambiguous',references,diagnostics:['这是预览，不是证据'],trace:TRACE});const text=toolText('resolve_reference',answer);assert.equal(linesOf(text).filter(line=>/^候选 \d+：/.test(line)).length,2000);assert.match(text,/原句核对状态未知/);assert.ok(text.includes(references[0].text));assert.doesNotMatch(text,/src:|解析状态/);
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

  test('a 4,000-line upload read by reference comes whole through the server, with its disclosure, and a cursor reads on', async () => {
    const client = await server.client(server.admin.token);
    const text = Array.from({length:4000}, (_, index) => `第 ${index} 行 😀`).join('\n');
    const uploaded = await client.call('upload_file', {file_path:Buffer.from(text).toString('base64')});
    const reference = String(uploaded.structuredContent.reference);
    assert.equal(uploaded.content.length, 2);
    assert.equal(uploaded.content[1].text?.split('\n')[0], '供模型引用');
    assert.deepEqual(JSON.parse(uploaded.content[1].text!.slice('供模型引用\n'.length)), uploaded.structuredContent);
    assert.doesNotMatch(uploaded.content[0].text!, /src:/);
    const read = await client.call('get_nodes', {reference});
    const shown = read.content[0].text!;
    assert.ok(shown.includes(text));
    assert.doesNotMatch(shown, /^追踪 /m);
    assert.equal((read.structuredContent.content as {text:string}).text, text);
    assert.equal(read.content.length, 2);
    assert.deepEqual(JSON.parse(read.content[1].text!.slice('供模型引用\n'.length)), read.structuredContent);
    await server.assign(server.admin.principal, 'review');
    server.fakes.runs.items = subject => [{id:'synthetic:n1',label:'合成原始用例',location:subject+'/kityminder@1/n/n1',fields:{autoid:'CASE-SYNTHETIC-1',title:'合成原始用例'}}];
    const started = await client.call('start_run', {pack:'review',inputs:{subject:{reference}}});
    const run = started.structuredContent.run as {run:string};
    const original_cases = [{id:'synthetic:n1',autoid:'CASE-SYNTHETIC-1',title:'合成原始用例'}];
    assert.match(String(started.structuredContent.record), /^rec:[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(started.content[1].text!.slice('供模型引用\n'.length)), {...started.structuredContent,original_cases,source_context:{unavailable:[],gaps:[]}});
    assert.doesNotMatch(started.content[0].text!, /rec:|run_/);
    const refused = await client.call('submit_result', {run:run.run,model:'scripted-model@test',items:[{item:'synthetic:n1',handling:'handled',slots:{findings:[]}}],notes:'quote-mismatch'});
    const references = JSON.parse(refused.content[1].text!.slice('供模型引用\n'.length));
    assert.match(references.record, /^rec:[0-9a-f]{64}$/);
    assert.equal(references.errors[0].item, 'synthetic:n1');
    assert.equal(references.errors[0].path, '/items/0/slots');
    assert.equal(references.original_cases[0].autoid, 'CASE-SYNTHETIC-1');
    assert.deepEqual(references, {...refused.structuredContent,original_cases});
    assert.doesNotMatch(refused.content[0].text!, /rec:|synthetic:n1|\/items\/0\/slots/);
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
  assert.ok(pages[0].includes(result.partitions.delivered[0].label));
});

test('get_nodes renders only relation references and one-line summaries, retaining the full backlink count',()=>{
const root=H('d'),path='/manual/test';const node={path,name:'合成手册',reference:'tree:'+root+path,level:'leaf',digest:H('3'),children:[],entries:[],backlinks:{composition:H('b'),truncated:true,configured:true,total:9,view_id:'view-hidden',notes:[],entries:[{reference:'tree:'+root+'/notes/one@'+H('5'),path:'/notes/one',summary:'相关原始用例说明'}]}};const answer=GetNodesOutput.parse({call_result:'ok',errors:[],root,nodes:[node],trace:TRACE});const text=toolText('get_nodes',answer);assert.match(text,/相关资料共 9 份/);assert.match(text,/相关原始用例说明/);assert.doesNotMatch(text,/rec:|view-hidden/);assert.equal(answer.nodes?.[0].backlinks?.entries[0].reference,'tree:'+root+'/notes/one@'+H('5'));
});


test('node definitions and children precede relation hints and the omitted hint names an exact view',()=>{
const root=H('d'),path='/manual/test';const node={path,name:'合成手册',reference:'tree:'+root+path,level:'leaf',digest:H('3'),children:[{path:path+'/child',name:'合成章节',digest:H('4')}],entries:[{entry:H('5'),kind:'definition',statement:'手册原句',reference:'tree:'+root+path+'@'+H('5')}],backlinks:{composition:H('b'),truncated:true,configured:true,total:3,view_id:'exact-view',notes:[],entries:[{reference:'tree:'+root+'/notes/one@'+H('6'),path:'/notes/one',summary:'相关资料说明'}]}};const text=toolText('get_nodes',GetNodesOutput.parse({call_result:'ok',errors:[],root,nodes:[node],trace:TRACE}));assert.ok(text.indexOf('手册原句')<text.indexOf('合成章节'));assert.ok(text.indexOf('合成章节')<text.indexOf('相关资料说明'));assert.match(text,/还有相关资料未列出；状态未知/);assert.doesNotMatch(text,/exact-view|rec:/);
});

test('start_run prints the locked product-wide root beside the build root', () => {
const run={...runOf(items(1)),version:'10.6',unversioned_root:H('b')};const answer=startAnswer(run);const text=toolText('start_run',answer);assert.equal(answer.run?.unversioned_root,H('b'));assert.match(text,/构建 b-2.1-7/);assert.doesNotMatch(text,/知识根|b{64}|d{64}/);
});

test('large function-only structure summaries have real cursor continuation without inventing source text',()=>{
const summary=Object.fromEntries(Array.from({length:5000},(_,i)=>['field'+i,'value'+i]));const answer=GetNodesOutput.parse({call_result:'ok',errors:[],trace:TRACE,content:{reference:'src:'+H('e'),read_tier:'function_bytes_only',readable:false,structure:{parser:'xml@1',summary}}});const text=toolText('get_nodes',answer);assert.match(text,/原文尚未读出；状态未知；原因缺资料/);assert.doesNotMatch(text,/原文（|field0|xml@1/);assert.equal(Object.keys(answer.content!.structure!.summary as object).length,5000);
});

test('start_run states the rules and ledger interpreters that judge each requirement',()=>{
const run=runOf(items(1));run.requirements[0].rules=['range@1'];run.requirements[0].run_interpreters=['structure@1'];const answer=startAnswer(run);const text=toolText('start_run',answer);assert.deepEqual(answer.run?.requirements[0].rules,['range@1']);assert.deepEqual(answer.run?.requirements[0].run_interpreters,['structure@1']);assert.doesNotMatch(text,/range@1|structure@1|运行内表/);
});

test('criterion start notices distinguish pending expired and rejected requests with explicit next actions',()=>{
const run=runOf(items(1));const base={item:run.items[0].id,criterion:SUBJECT,assertion:'合成修改意见',old:'旧要求',new:'新要求',grounds:[{reference:SUBJECT,quote:'合成引文'}],request:'rec:'+H('7'),declaration:'rec:'+H('8')+'#/criterion_changes/0',audience:'usr_'+'1'.repeat(26),due:'2026-10-25T08:00:00.000Z',answered:false,expired:false,next_action:'使用者重新核对修改意见'};for(const change of [base,{...base,expired:true},{...base,answered:true,accepted:false,reviewer:base.audience,reason:'合成不同意'}]){run.criterion_changes=[change];const text=toolText('start_run',startAnswer(run));assert.ok(text.includes(change.next_action));assert.doesNotMatch(text,/rec:|usr_|T08:00/);if(change.expired)assert.match(text,/修改意见已过期/);if(change.answered)assert.match(text,/合成不同意/);}
});
test('criterion result text shows all replacement values and review attribution',()=>{
const result=resultOf(items(1));const row=result.partitions.delivered[0];row.replaced_criteria=[{criterion:SUBJECT,old:'合成旧值',new:'合成新值',declaration:'rec:'+H('8')+'#/criterion_changes/0',review:'rec:'+H('7'),reviewer:'usr_'+'1'.repeat(26)}];const text=toolText('submit_result',submitAnswer(result),{items:items(1)});assert.match(text,/原始用例的要求由合成旧值改为合成新值/);assert.doesNotMatch(text,/rec:|usr_|src:/);assert.equal(row.replaced_criteria[0].review,'rec:'+H('7'));
});
test('superseded criterion declarations are displayed as replaced rather than unanswered',()=>{
const run=runOf(items(1));run.criterion_changes=[{item:run.items[0].id,criterion:SUBJECT,assertion:'旧修改意见',old:'旧要求',new:'先前提议',grounds:[{reference:SUBJECT,quote:'合成'}],request:'rec:'+H('7'),declaration:'rec:'+H('8')+'#/criterion_changes/0',audience:'usr_'+'1'.repeat(26),due:'2026-10-25T08:00:00.000Z',answered:true,expired:false,superseded_by:'rec:'+H('6'),next_action:'使用者核对新的修改意见'}] as any;const text=toolText('start_run',startAnswer(run));assert.match(text,/已有新的修改意见/);assert.doesNotMatch(text,/rec:|尚未确认/);
});

test('submit_result keeps the three dispatch outcomes distinct under reader wording', () => {
  // Non-call-error dispatch notes keep the conclusion chain; five-category prose must not (Boss 15:02).
  const result = resultOf(items(1));
  const base = submitAnswer(result);
  const notSent = toolText('submit_result', SubmitResultOutput.parse({
    ...base,
    dispatch: [{ text: '上机验证没有发出：目标没有给出租约；下一步：什么都没有发到目标；原因消除后原样重交，Hub 会再试一次' }],
  }), { items: items(1) });
  assert.match(notSent, /上机验证没有发出：目标没有给出租约/);
  assert.match(notSent, /什么都没有发到目标/);
  assert.match(notSent, /状态已确认；判断错误；原因还没查清/);

  const diagnosed = toolText('submit_result', SubmitResultOutput.parse({
    ...base,
    dispatch: [{ text: '上机验证没有发出：放行条件里有 1 条错误。「核验目标与清单等于执行器声明」判定为错误。这次脚本合并核对的是：测试环境 bed-a，清单 eeeeeeeeeeee，和执行器声明的不一样。另有 2 条因为上面的错误还没有核对。现在可以做：先确认预订的是哪个测试环境' }],
  }), { items: items(1) });
  assert.match(diagnosed, /放行条件里有 1 条错误/);
  assert.match(diagnosed, /先确认预订的是哪个测试环境/);
  assert.match(diagnosed, /状态已确认；判断错误；决定者程序/);
  assert.doesNotMatch(diagnosed, /原因还没查清/);

  const rejected = toolText('submit_result', SubmitResultOutput.parse({
    ...base,
    dispatch: [{ text: '已结束；目标在“admission”阶段拒绝；下一步：目标没有接收，也没有执行；按拒绝的原因修正后原样重交，Hub 会再试一次' }],
  }), { items: items(1) });
  assert.match(rejected, /目标在“admission”阶段拒绝/);
  assert.match(rejected, /目标没有接收，也没有执行/);
  assert.match(rejected, /状态已确认；判断错误；原因还没查清/);

  const unanswered = toolText('submit_result', SubmitResultOutput.parse({
    ...base,
    dispatch: [{ text: '上机验证结果未知：不要重交，也不要另开运行重发，目标可能已经执行过一次；已交给管理员处置；之后原样重交读进展' }],
  }), { items: items(1) });
  assert.match(unanswered, /上机验证结果未知：不要重交，也不要另开运行重发/);
  assert.match(unanswered, /状态未知；原因还没查清/);

  const withResult = toolText('submit_result', SubmitResultOutput.parse({
    ...base,
    dispatch: [{ job: H('1'), executor: 'synthetic-executor', result: `src:${H('2')}`, text: '已结束；结果引用 src:合成' }],
  }), { items: items(1) });
  assert.match(withResult, /设备输出已取回；状态未知；原因还没查清；下一步由模型核对设备输出/);
  assert.doesNotMatch(withResult, /结果引用 src:/);

  const many = toolText('submit_result', SubmitResultOutput.parse({
    ...base,
    dispatch: [
      { text: '上机验证没有发出：预检条件不满足；下一步：什么都没有发到目标；原因消除后原样重交，Hub 会再试一次' },
      { job: H('3'), executor: 'synthetic-executor', text: 'Hub 已再次按工作流的规定自动开始上机验证（执行器 synthetic-executor）；下一步由模型稍后把这次脚本合并原样再交一次，读取进展；上机验证结束后，同样的答复里带设备输出的引用' },
    ],
  }), { items: items(1) });
  assert.match(many, /上机验证没有发出：预检条件不满足/);
  assert.match(many, /Hub 已再次按工作流的规定自动开始上机验证（执行器 synthetic-executor）/);
  assert.doesNotMatch(many, /任务包|下一步由使用者继续读取设备输出/);
  assert.equal(linesOf(many).filter(line => line.includes('上机验证')).length >= 2, true);
});

test('dispatch call-error prose keeps category form and restores member release next steps', () => {
  // Extra DispatchNote fields survive production extensibleOutput; unit calls pass them without SubmitResultOutput.parse.
  const base = submitAnswer(resultOf(items(1)));
  const occupied = toolText('submit_result', {
    ...base,
    dispatch: [{
      text: '已被占用：自动化测试环境正被作业占用，这次上机验证没有发出。等占用结束后原样重交。',
      outcome: 'not_dispatched',
      error_code: 'LEASE_UNAVAILABLE',
    }],
  }, { items: items(1) });
  const occupiedLine = linesOf(occupied).find((line) => line.startsWith('已被占用：')) ?? '';
  assert.equal(occupiedLine, '已被占用：自动化测试环境正被作业占用，这次上机验证没有发出。等占用结束后原样重交。');
  assert.doesNotMatch(occupiedLine, /状态已确认|判断错误|决定者程序|原因还没查清/);

  const memberRelease = toolText('submit_result', {
    ...base,
    dispatch: [{
      text: '不存在：核对项目“核验目标与清单等于执行器声明”：本次核验的目标或清单摘要与当前执行器声明不一致。联系管理员核对当前环境的清单绑定，再使用一致的清单重新核验。',
      outcome: 'not_dispatched',
      error_code: 'EFFECT_RELEASE_UNMET',
      missing_facts: [{ fact: '核对项目“核验目标与清单等于执行器声明”：本次核验的目标或清单摘要与当前执行器声明不一致', next_action: '联系管理员核对当前环境的清单绑定，再使用一致的清单重新核验' }],
    }],
  }, { items: items(1), caller: { role: 'user' } });
  const memberLine = linesOf(memberRelease).find((line) => line.startsWith('不存在：')) ?? '';
  assert.equal(
    memberLine,
    '不存在：核对项目“核验目标与清单等于执行器声明”：本次核验的目标或清单摘要与当前执行器声明不一致。先确认预订的是哪个测试环境，用它对应的运行环境配置重新做脚本编写和脚本合并，再发起上机验证；预订和配置都没错时，请管理员核对执行器的声明。',
  );
  assert.doesNotMatch(memberLine, /联系管理员核对当前环境的清单绑定|状态已确认|判断错误|决定者程序/);

  const adminRelease = toolText('submit_result', {
    ...base,
    dispatch: [{
      text: '不存在：核对项目“核验目标与清单等于执行器声明”：本次核验的目标或清单摘要与当前执行器声明不一致。联系管理员核对当前环境的清单绑定，再使用一致的清单重新核验。',
      outcome: 'not_dispatched',
      error_code: 'EFFECT_RELEASE_UNMET',
      executor: 'exe_01syntheticrefusal0000000001',
      missing_facts: [{ fact: '核对项目“核验目标与清单等于执行器声明”：本次核验的目标或清单摘要与当前执行器声明不一致', next_action: '联系管理员核对当前环境的清单绑定，再使用一致的清单重新核验' }],
    }],
  }, { items: items(1), caller: { role: 'admin', name: '合成管理员' } });
  const adminLine = linesOf(adminRelease).find((line) => line.startsWith('不存在：')) ?? '';
  assert.match(adminLine, /按执行器声明的测试环境和清单重新做脚本编写和脚本合并/);
  assert.match(adminLine, /circle-hub job explain-release --executor exe_01syntheticrefusal0000000001/);
  assert.doesNotMatch(adminLine, /先确认预订|状态已确认|判断错误|决定者程序/);

  const legacyIdentity = toolText('submit_result', {
    ...base,
    dispatch: [{
      text: '上机验证没有发出：本次核验的目标或清单摘要与当前执行器声明不一致',
      outcome: 'not_dispatched',
      missing_facts: [{ fact: '本次核验的目标或清单摘要与当前执行器声明不一致', next_action: '联系管理员核对当前环境的清单绑定，再使用一致的清单重新核验' }],
    }],
  }, { items: items(1), caller: { role: 'user' } });
  const legacyLine = linesOf(legacyIdentity).find((line) => line.includes('上机验证没有发出')) ?? '';
  assert.match(legacyLine, /现在可以做：先确认预订的是哪个测试环境/);
  assert.match(legacyLine, /状态已确认；判断错误/);
});

test('known missing booking keeps a verified merge separate from an unsent job', () => {
  const base = submitAnswer(resultOf(items(1)));
  const text = toolText('submit_result', { ...base, dispatch: [{ text: 'diagnostic with private keys', outcome: 'not_dispatched', frozen: false, submission_verified: true, booking: { target: '合成实验室', coverage_complete: false, required_resources: 11, missing_resources: 11, declared_device_count: 11 } }] }, { items: items(1) });
  assert.match(text, /脚本合并正确（已确认）/);
  assert.match(text, /这次运行没有带着测试环境的预订/);
  assert.match(text, /合成实验室（共 11 台设备）/);
  assert.match(text, /先预订整个测试环境，再从脚本编写重开/);
  assert.doesNotMatch(text, /原因还没查清|diagnostic with private keys/);
});

test('booking rewrite does not wipe occupied or expired call-error categories', () => {
  const base = submitAnswer(resultOf(items(1)));
  const occupied = toolText('submit_result', {
    ...base,
    dispatch: [{
      text: '已被占用：上机验证已结束；未发出；测试环境由另一运行持有。等该运行释放后原样重试。',
      outcome: 'not_dispatched',
      frozen: false,
      submission_verified: true,
      error_code: 'LEASE_UNAVAILABLE',
      booking: { target: '合成环境', coverage_complete: false, required_resources: 2, missing_resources: 2, declared_device_count: 2 },
    }],
  }, { items: items(1) });
  const occupiedLine = linesOf(occupied).find((line) => line.startsWith('已被占用：')) ?? '';
  assert.equal(occupiedLine, '已被占用：上机验证已结束；未发出；测试环境由另一运行持有。等该运行释放后原样重试。');
  assert.doesNotMatch(occupiedLine, /脚本合并正确|没有带着测试环境的预订|状态已确认|判断错误|决定者程序/);

  const expired = toolText('submit_result', {
    ...base,
    dispatch: [{
      text: '不存在：当前账户的原预订已过期；本运行没有覆盖测试环境 合成环境 的完整预订。先预订整个测试环境后重新核验。',
      outcome: 'not_dispatched',
      frozen: false,
      submission_verified: true,
      error_code: 'LEASE_EXPIRED',
      booking: { target: '合成环境', coverage_complete: false, required_resources: 2, missing_resources: 2, declared_device_count: 2 },
    }],
  }, { items: items(1) });
  const expiredLine = linesOf(expired).find((line) => line.startsWith('不存在：')) ?? '';
  assert.equal(expiredLine, '不存在：当前账户的原预订已过期；本运行没有覆盖测试环境 合成环境 的完整预订。先预订整个测试环境后重新核验。');
  assert.doesNotMatch(expiredLine, /脚本合并正确|没有带着测试环境的预订|状态已确认|判断错误|决定者程序/);
});

test('booking no-command devices stay one plain line; in-flight and Excel rows skip reason words (Boss 20:53)', () => {
  const at = '2026-11-14T09:35:00.000Z';
  const list = [{ ...items(1)[0], fields: { case_id: '253651793153361064', title: '253 字符域名 DNS 解析正常' } }];
  const run = runOf(list);
  run.device_observations = [
    {
      statement: { text: 'apv0 装的是 Toy', data: { label: 'apv0', build: 'Toy', inventory: H('e'), device: '/d/0' } },
      qualifier: { nature: 'fact', provenance: 'observed', marks: [], collected_at: at },
      grounds: [`src:${H('d')}`],
      warrant: { producer: 'function', id: 'dispatch.version_probe@1' },
      validity: { status: 'valid', bound: [H('e')], premises: [] },
    },
    {
      statement: {
        text: 'clientc、clientd、cliente、console、routera、routerb、server213、server231、server232 共 9 台不接收命令，未读取构建版本',
        data: { missing: 'x', kind: 'no_command_devices' },
      },
      qualifier: { nature: 'fact', provenance: 'projected', marks: [], collected_at: at },
      grounds: [],
      warrant: { producer: 'function', id: 'runs.observe_devices@1' },
      validity: { status: 'valid', bound: [], premises: [] },
    },
  ];
  const booking = toolText('start_run', startAnswer(run));
  assert.match(booking, /测试环境 apv0，构建 Toy，读取时间 \d{2}-\d{2} \d{2}:\d{2}（UTC[+-]\d+(?::\d{2})?）；状态已确认；决定者程序/);
  assert.match(booking, /^clientc、clientd、cliente、console、routera、routerb、server213、server231、server232 共 9 台不接收命令，未读取构建版本$/m);
  assert.doesNotMatch(booking, /不接收命令.*状态未知|没有绑定同一份清单/);

  const inFlightItem: ItemResult = {
    item: list[0].id,
    label: list[0].label,
    location: list[0].location,
    reason: 'awaiting_step',
    requirements: [{
      requirement: 'structure',
      status: 'pending',
      layers: [{ layer: 'dynamic', terminal: 'incomplete', reason: 'awaiting_step' }],
      claims: [],
    }],
  };
  const inFlight = toolText('submit_result', submitAnswer(resultWith({ delivered: [], rejected: [], quarantined: [], incomplete: [inFlightItem] })), { items: list });
  assert.match(inFlight, /^原始用例 253651793153361064 253 字符域名 DNS 解析正常：上机验证还在进行，还没有设备输出；状态未知；下一步由模型在上机验证结束后读取设备输出；决定者程序$/m);
  assert.doesNotMatch(inFlight, /原因缺资料|原因还没查清|下一步使用者/);

  const excelItem: ItemResult = {
    item: list[0].id,
    label: list[0].label,
    location: list[0].location,
    reason: 'missing_input',
    requirements: [{
      requirement: 'workbook_verified',
      status: 'pending',
      layers: [{ layer: 'static', terminal: 'unchecked', reason: 'missing_input', attribution: 'data_gap' }],
      claims: [{
        statement: { text: '缺自动化用例 Excel', verdict: 'unknown', reason: 'missing_input' },
        qualifier: { nature: 'unknown', provenance: 'projected', marks: [] },
        grounds: [],
        warrant: { producer: 'function', id: 'case-compile.workbook@1' },
        validity: { status: 'valid', bound: [], premises: [] },
      }],
    }],
  };
  const excel = toolText('submit_result', submitAnswer(resultWith({ delivered: [], rejected: [], quarantined: [], incomplete: [excelItem] })), { items: list });
  assert.match(excel, /^原始用例 253651793153361064 253 字符域名 DNS 解析正常：还没有确认结论；状态未知；下一步由模型生成并上传自动化用例 Excel 后重新交给 Hub 检查；决定者程序$/m);
  assert.doesNotMatch(excel, /原因缺资料|下一步使用者补齐资料/);

  const started = toolText('submit_result', SubmitResultOutput.parse({
    ...submitAnswer(resultOf(items(1))),
    dispatch: [{ text: 'Hub 已按工作流的规定自动开始上机验证；下一步由模型稍后把这次脚本合并原样再交一次，读取进展；上机验证结束后，同样的答复里带设备输出的引用' }],
  }), { items: items(1) });
  assert.match(started, /^Hub 已按工作流的规定自动开始上机验证；下一步由模型稍后把这次脚本合并原样再交一次，读取进展；上机验证结束后，同样的答复里带设备输出的引用$/m);
  assert.doesNotMatch(started, /任务包|状态未知；原因还没查清；下一步由使用者继续读取设备输出/);
});

test('recompose refusal: one next actor, verbatim（×N）, determined-error branch (Boss 06:48)', () => {
  const list = [{ ...items(1)[0], fields: { case_id: '253651793153361064', title: '标题未知' }, label: '标题未知' }];
  const fact = '改写后的命令没有锁定目录的完整语法身份；等待产品包作者在重新提交之前补事实并重产';
  const identical = Array.from({ length: 5 }, () => ({
    code: 'missing_input',
    message: fact,
    fix: '补齐点名的事实后重交；不能补齐的按具名请求处理；运行者用 upload_file 补齐点名的运行输入',
    path: '/items/0',
    item: list[0].id,
    requirement: 'record',
    rounds_left: 2,
  }));
  const shape = {
    code: 'SUBMISSION_SCHEMA_VIOLATION',
    message: '来源状态缺完整 action/object/owner/due 出口；写明缺的事实、由谁在何时补，再重交',
    fix: '写明缺的事实、由谁在何时补，再重交',
    path: '/items/0',
    item: list[0].id,
    requirement: 'record',
    rounds_left: 2,
  };
  const refused = ValidationResult.parse({
    ...resultOf(items(1)),
    acceptance: 'not_accepted',
    errors: [...identical, shape],
    partitions: { delivered: [], rejected: [], quarantined: [], incomplete: [] },
    cross_item: [],
  });
  const text = toolText('submit_result', submitAnswer(refused), { items: list });
  assert.match(text, /^核对有错误。$/m);
  assert.match(text, /^原始用例 253651793153361064 标题未知：$/m);
  assert.match(text, /^- 改写后的命令没有锁定目录的完整语法身份（×5）$/m);
  assert.equal(linesOf(text).filter((line) => line.includes('改写后的命令没有锁定目录的完整语法身份')).length, 1);
  assert.equal(linesOf(text).filter((line) => line.includes('还可以重交 2 次')).length, 1);
  assert.equal(linesOf(text).filter((line) => line.includes('决定者程序')).length, 1);
  assert.match(text, /下一步由模型改正重组记录后重交/);
  assert.doesNotMatch(text, /产品包作者|下一步使用者补齐资料|运行者用 upload_file/);
  assert.match(text, /参数无效：来源状态缺完整 action\/object\/owner\/due 出口；写明缺的事实、由谁在何时补，再重交/);
  assert.doesNotMatch(text, /再重交。写明缺的事实/);

  // Near-identical facts must NOT merge (only verbatim equality).
  const near = toolText('submit_result', submitAnswer(ValidationResult.parse({
    ...refused,
    errors: [
      { ...identical[0], message: '改写后的命令没有锁定目录的完整语法身份；等待产品包作者在重新提交之前补事实并重产' },
      { ...identical[0], message: '改写后的命令没有锁定目录的完整语法身份（命令 sdns listener）；等待产品包作者在重新提交之前补事实并重产' },
    ],
  })), { items: list });
  assert.doesNotMatch(near, /（×/);
  assert.equal(linesOf(near).filter((line) => line.startsWith('- ')).length, 2);

  // Accepted unknown record gap: name the missing fact; next actor is the model.
  const unknownItem: ItemResult = {
    item: list[0].id,
    label: list[0].label,
    location: list[0].location,
    reason: 'missing_input',
    requirements: [{
      requirement: 'record',
      status: 'pending',
      layers: [{
        layer: 'static',
        terminal: 'unchecked',
        reason: 'missing_input',
        missing: '改写后的命令没有锁定目录的完整语法身份；等待产品包作者在重新提交之前补事实并重产',
        attribution: 'data_gap',
        exit: { action: 'request', request_kind: 'clarification', audience: { user: 'usr_' + '1'.repeat(26) }, due: '2026-01-04T00:00:00.000Z' },
      }],
      claims: [{
        statement: { text: '改写后的命令没有锁定目录的完整语法身份；等待产品包作者在重新提交之前补事实并重产', verdict: 'unknown', reason: 'missing_input' },
        qualifier: { nature: 'unknown', provenance: 'projected', marks: [] },
        grounds: [],
        warrant: { producer: 'function', id: 'recompose-check@1' },
        validity: { status: 'valid', bound: [], premises: [] },
      }],
    }],
  };
  const acceptedUnknown = toolText('submit_result', submitAnswer(resultWith({ delivered: [], rejected: [], quarantined: [], incomplete: [unknownItem] })), { items: list });
  assert.match(acceptedUnknown, /改写后的命令没有锁定目录的完整语法身份；状态未知；原因缺资料；下一步由模型改正重组记录后重交/);
  assert.doesNotMatch(acceptedUnknown, /产品包作者|下一步使用者补齐资料|还没有确认结论/);

  // Pack-marked determined error (data.determination === 'error'): render as 判断错误, not 状态未知 (Boss 06:48 b).
  const determinedItem: ItemResult = {
    item: list[0].id,
    label: list[0].label,
    location: list[0].location,
    reason: 'check_error',
    requirements: [{
      requirement: 'record',
      status: 'pending',
      layers: [{ layer: 'static', terminal: 'unchecked', reason: 'check_error', attribution: 'producer_error' }],
      claims: [{
        statement: {
          text: '改写后的命令没有锁定目录的完整语法身份',
          verdict: 'unknown',
          reason: 'check_error',
          data: { determination: 'error' },
        },
        qualifier: { nature: 'unknown', provenance: 'projected', marks: [] },
        grounds: [],
        warrant: { producer: 'function', id: 'recompose-check@1' },
        validity: { status: 'valid', bound: [], premises: [] },
      }],
    }],
  };
  const determined = toolText('submit_result', submitAnswer(resultWith({ delivered: [], rejected: [], quarantined: [], incomplete: [determinedItem] })), { items: list });
  assert.match(determined, /改写后的命令没有锁定目录的完整语法身份；状态已确认；判断错误；原因编写模型的问题；下一步由模型改正重组记录后重交/);
  assert.doesNotMatch(determined, /状态未知；原因缺资料/);
});
