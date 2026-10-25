import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { TABLE_SCHEMAS } from '../../../../contracts/src/tables.ts';
import { callPackFunction, getInterpreter, osIsolationAvailable } from '../../../../hub/rules/api.ts';
import expectedSourcesFn from './expected-sources.ts';
import projectFn from './project.ts';
import subjectFn from './subject.ts';
import tagsFn from './tags.ts';
import templateCoverageFn from './template-coverage.ts';
import projectionFn from './projection.ts';
import expectedFn from './expected.ts';
import { negativeCommands, findingSources, tagSpelling } from './checks.ts';
import { toStructureSubjects } from './subject.ts';
import { parseFixture, parseLarge, parseText, table } from '../testing/test-support.ts';
import type { Failure, Warning } from './types.ts';

const TABLES_DIR = new URL('../tables/', import.meta.url);
const PACK_DIR = fileURLToPath(new URL('../', import.meta.url));
const tableFiles = readdirSync(TABLES_DIR).filter((name) => name.endsWith('.json'));
type Codes = {
  refusals: Array<{ code: string; when: string; fix: string }>;
  warnings: Array<{ code: string; when: string; fix: string }>;
  checks: Array<{ code: string; when: string; fix: string }>;
  findings: Array<{ code: string; label: string; when: string }>;
  ranks: Array<{ rank: string; label: string; levels: string[] }>;
  levels: Array<{ level: string; label: string; when: string }>;
};
const codes = table('codes.json') as Codes;
const HAN = /\p{Script=Han}/u;

// docs/hub-r4-architecture.md section 6, written out: the probe names, the severity bands and the levels.
const PROBES = ['literal_issue', 'coverage_gap', 'differentiation_gap', 'edge_case_gap', 'negative_gap', 'block_structure_mismatch', 'self_contradiction'];
const BANDS: Array<[string, string[]]> = [
  ['critical', ['P6', 'P7']],
  ['major', ['P3', 'P4', 'P5']],
  ['minor', ['P0', 'P1', 'P2']],
];
const LEVELS = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];

describe('the core tables', () => {
  const core = tableFiles.map((name) => ({ name, value: table(name) as { schema?: string } })).filter((entry) => entry.value.schema !== undefined && entry.value.schema in TABLE_SCHEMAS);

  it('cover structure@1, catalog@1, coverage@1 and quote@1 (the closed sets of codes and ranks are in the slot schema)', () => {
    assert.deepEqual([...new Set(core.map((entry) => entry.value.schema))].sort(), ['catalog@1', 'coverage@1', 'quote@1', 'structure@1']);
    assert.deepEqual(
      core.map((entry) => entry.name),
      ['catalog.json', 'cited-commands.json', 'command-claims.json', 'findings-quotes.json', 'structure-node-ids.json', 'structure.json', 'template-v3-coverage.json'],
    );
    assert.deepEqual(
      tableFiles.filter((name) => !core.some((entry) => entry.name === name)),
      ['codes.json', 'resource-tags.json', 'template-v3.json'],
    );
  });

  it('match the contract shapes and pass the interpreters’ admission', () => {
    for (const { name, value } of core) {
      const schema = TABLE_SCHEMAS[value.schema as keyof typeof TABLE_SCHEMAS];
      const parsed = schema.safeParse(value);
      assert.ok(parsed.success, `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
      const interpreter = getInterpreter(value.schema as string);
      assert.ok(interpreter, String(value.schema));
      assert.deepEqual(interpreter.validateTable(value), [], name);
    }
  });

  it('name their origin and, when blocking, the requirement clause they rest on, by the brief’s requirement names', () => {
    const requirements = new Set(['literal', 'catalog', 'findings', 'level']);
    for (const { name, value } of core) {
      const t = value as { origin: string; tier?: string; basis?: string; description?: string };
      assert.ok(HAN.test(t.origin), name);
      assert.ok(t.description !== undefined && HAN.test(t.description), name);
      if ((t.tier ?? 'blocking') !== 'blocking') continue;
      assert.ok(t.basis !== undefined && HAN.test(t.basis), `${name} is blocking without a basis`);
      const named = /^要求项 ([a-z_]+)：/.exec(t.basis);
      assert.ok(named && requirements.has(named[1]), `${name}: the basis names a requirement of the brief (${t.basis.slice(0, 20)})`);
    }
    assert.match((table('structure.json') as { basis: string }).basis, /^要求项 literal：/);
  });

  it('keep the scan of the case texts advisory and the catalog requirement on the commands the findings cite', () => {
    const scan = table('catalog.json') as { tier: string; basis?: string; negative: { tier: string } };
    assert.equal(scan.tier, 'advisory');
    assert.equal(scan.basis, undefined);
    assert.equal(scan.negative.tier, 'advisory');
    const claims = table('command-claims.json') as { tier: string; basis: string; claims: { select: string }; commands?: unknown };
    assert.equal(claims.tier, 'blocking');
    assert.match(claims.basis, /^要求项 catalog：/);
    assert.equal(claims.claims.select, '$.claims[*]');
    assert.equal(claims.commands, undefined);
    const cited = table('cited-commands.json') as { tier: string; required: boolean; commands: string[]; claims?: unknown; negative: { tier: string; expect: string[] } };
    assert.deepEqual([cited.tier, cited.required, cited.commands, cited.claims, cited.negative.tier], ['blocking', true, ['$.phrases'], undefined, 'advisory']);
    assert.deepEqual(cited.negative.expect, ['core.catalog.param_out_of_range', 'core.catalog.param_type_mismatch', 'core.catalog.arity_mismatch']);
  });

  it('agree with the closed sets of slots.schema.json, which are the brief’s', () => {
    const slots = JSON.parse(readFileSync(new URL('../slots.schema.json', import.meta.url), 'utf8')) as {
      item: { findings: { codes: Array<{ code: string }>; ranks: Array<{ code: string }> } };
      run: { level: { codes: Array<{ code: string }>; ranks: Array<{ code: string }> } };
    };
    assert.deepEqual(slots.item.findings.codes.map((c) => c.code), PROBES);
    assert.deepEqual(slots.item.findings.ranks.map((r) => r.code), BANDS.map(([band]) => band));
    assert.deepEqual(slots.run.level.codes.map((c) => c.code), ['level']);
    assert.deepEqual(slots.run.level.ranks.map((r) => r.code), LEVELS);
    assert.deepEqual(
      codes.findings.map((finding) => finding.code),
      PROBES,
    );
    assert.deepEqual(
      codes.ranks.map((rank) => [rank.rank, rank.levels]),
      BANDS,
    );
    assert.deepEqual(
      codes.levels.map((level) => level.level),
      LEVELS,
    );
    assert.deepEqual(codes.ranks.flatMap((rank) => rank.levels).sort(), LEVELS, 'the bands split the levels');
  });

  it('require only the six test types of the template; the other categories are reported, not counted missing', () => {
    const template = table('template-v3.json') as { categories: Array<{ id: string; group: string; required?: boolean }> };
    assert.deepEqual(
      (table('template-v3-coverage.json') as {required:{values:string[]}}).required.values,
      ['functional', 'configuration', 'integration', 'compatibility', 'negative', 'stress'],
    );
    assert.ok(template.categories.filter((category) => category.required === false).every((category) => category.group !== 'test_type'));
  });
});

describe('codes.json', () => {
  const declared = new Set([...codes.refusals, ...codes.warnings, ...codes.checks].map((entry) => entry.code));

  it('declares each code once, under the pack name, in Chinese', () => {
    const all = [...codes.refusals, ...codes.warnings, ...codes.checks];
    assert.equal(declared.size, all.length);
    for (const entry of all) {
      assert.match(entry.code, /^case-review\.[a-z][a-z_]*$/);
      assert.ok(HAN.test(entry.when) && HAN.test(entry.fix), entry.code);
    }
    for (const finding of codes.findings) assert.ok(/^[a-z][a-z_]*$/.test(finding.code) && HAN.test(finding.label) && HAN.test(finding.when), finding.code);
    for (const rank of codes.ranks) assert.ok(HAN.test(rank.label), rank.rank);
    for (const level of codes.levels) assert.ok(HAN.test(level.when), level.level);
  });

  it('covers every code the functions emit, and every declared code is reachable', () => {
    const emitted = new Set<string>();
    const collect = (out: unknown): void => {
      const value = out as Partial<Failure> & { warnings?: Warning[] };
      if (value.error) emitted.add(value.error.code);
      for (const warning of value.warnings ?? []) emitted.add(warning.code);
    };
    const review = parseFixture('review-150.km.json').model;
    const outline = parseFixture('outline.km.json').model;
    const noIds = { doubleEncoded: false, meta: {}, duplicateIds: [], missingIds: 0, nulRemoved: 0, nodes: [{ data: { text: 'r' }, children: [1] }, { data: { text: 'c', priority: 2, resource: ['x'] }, children: [] }] };
    const nested = { ...noIds, nodes: [{ data: { id: 'r', text: 'r' }, children: [1] }, { data: { id: 'o', text: 'o', priority: 2, resource: ['x'] }, children: Array.from({ length: 120 }, (_, i) => i + 2) }, ...Array.from({ length: 120 }, (_, i) => ({ data: { id: `n${i}`, text: 'n', priority: 2, resource: ['x'] }, children: [] }))] };
    const deep = { ...noIds, nodes: Array.from({ length: 260 }, (_, i) => ({ data: { id: `n${i}`, text: 'x'.repeat(i === 3 ? 5000 : 1), ...(i === 2 ? { priority: 2, resource: ['a', null] } : {}) }, children: i < 259 ? [i + 1, 999] : [] })) };
    const wide = { ...noIds, nodes: [{ data: { id: 'r', text: 'r' }, children: [1] }, { data: { id: 'c', text: 'c', priority: 2, resource: ['a'] }, children: Array.from({ length: 120 }, (_, i) => i + 2) }, ...Array.from({ length: 120 }, (_, i) => ({ data: { id: `e${i}`, text: 'e' }, children: [] }))] };
    const longId = { ...noIds, nodes: [{ data: { id: 'r', text: 'r' }, children: [1, 2] }, { data: { id: 'x'.repeat(300), text: 'c', priority: 2, resource: ['a'] }, children: [] }, { data: { id: 'x'.repeat(300), text: 'c', priority: 2, resource: ['a'] }, children: [] }] };
    collect(projectFn(null));
    collect(projectFn({ documents: [{ documentId: 'o', model: outline }] }));
    collect(projectFn({ documents: [{ documentId: 'r', model: review }], parameters: { preconditionPriority: 'x' } }));
    collect(projectFn({ documents: [{ documentId: 'r', model: review }], limits: { outputBytes: 2048 } }));
    collect(projectFn({ documents: [{ documentId: 'n', model: noIds }] }));
    collect(projectFn({ documents: [{ documentId: 'm', model: nested }] }));
    collect(projectFn({ documents: [{ documentId: 'd', model: deep }] }));
    collect(projectFn({ documents: [{ documentId: 'w', model: wide }] }));
    collect(projectFn({ documents: [{ documentId: 'l', model: longId }] }));
    collect(projectFn({ documents: [{ documentId: 'a', get model(): never { throw new Error('x'); } }] }));
    collect(expectedSourcesFn({ documents: [{}, { documentId: 't', title: '31057-示例' }], parameters: { bareIds: 'x' } }));
    collect(templateCoverageFn({ items: [] }));
    collect(templateCoverageFn({ items: [null], template: table('template-v3.json'), skipped: ['x'] }));
    collect(subjectFn(null));
    collect(tagsFn(null));
    // The workflow adapters: refusals of the block parameter and of a target that is too large, and the check codes.
    const bound = (model: unknown) => ({ inputs: [{ slot: 'subject', external: 'agile:mindmap:880001', sha256: 'a'.repeat(64), media_type: 'application/json', parser: 'kityminder@1', model, meta: null }], parameters: {}, context: { product: null, names: [], line: null, build: null, root: null, parameters: {}, groups: [] } });
    const reviewInput = bound(review);
    collect(projectionFn({ ...reviewInput, parameters: { block: 'no-such-node' } }));
    collect(projectionFn({ ...reviewInput, parameters: { block: ['示例', '没有这个分组'] } }));
    collect(projectionFn(bound(parseLarge().model)));
    collect(projectionFn({ ...reviewInput, parameters: { slice: { from: 9, to: 1 } } }));
    const group = (id: string, cases: string[]) => ({ data: { id, text: '组', priority: 1 }, children: cases.map((c) => ({ data: { id: c, text: 'c', priority: 2, resource: ['x'] }, children: [] })) });
    const twins = parseText(JSON.stringify({ root: { data: { id: 'r', text: 'r' }, children: [group('g1', ['c1']), group('g2', ['c2'])] } })).model;
    collect(projectionFn({ ...bound(twins), parameters: { block: ['组'] } }));
    collect(expectedFn(null));
    const tagged = (id: string, tags: string[]) => ({ id, location: 'src:x', fields: { document: 'd', title: id, tags, expected: ['e'], path: [] } });
    for (const outcome of [
      ...negativeCommands({subject:{item:'i',negative:true,phrases:[]},catalog:[]}),
      ...findingSources({ subject: { item: 'i', slots: { findings: [{ text: 't', quotes: [{ reference: 'src:x', text: 'q' }], commands: [{ command: 'widget x 1' }] }, { text: 'u' }] }, evidence: [{ reference: 'src:x', resolved: true, role: 'hint' }] } }),
      ...tagSpelling({ subject: { subjects: toStructureSubjects([tagged('a', ['Functional']), tagged('b', ['Functional']), tagged('c', ['功能'])]) } }),
    ]) {
      if (outcome.code !== undefined) emitted.add(outcome.code);
    }
    for (const code of emitted) assert.ok(declared.has(code), `${code} is not declared in tables/codes.json`);
    for (const code of declared) assert.ok(emitted.has(code), `${code} is declared but no scenario emits it`);
  });
});

describe('the pack functions', () => {
  const sources = readdirSync(new URL('./', import.meta.url)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'test-support.ts');

  it('import only modules inside the pack at run time and use no clock, randomness or I/O', () => {
    for (const name of sources) {
      const code = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/**'))
        .join('\n')
        // `export type X = import('./x.ts').X` 是类型查询，编译后没有运行时 import()。
        .replace(/^export type .*import\([^)]*\).*$/gm, '');
      for (const match of code.matchAll(/^\s*import\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)) {
        if (match[1] === undefined && !(name === 'template-coverage.ts' && match[2] === '../tables/template-v3-coverage.json')) assert.match(match[2], /^\.\/(?:[a-z-]+\.ts|generated\/vocabulary\.ts)$/, `${name} imports ${match[2]} at run time`);
      }
      for (const forbidden of [/\bDate\b/, /Math\.random/, /\bprocess\b/, /\brequire\(/, /\bfetch\(/, /\bsetTimeout\b/, /\bperformance\b/, /\beval\(/, /new Function/, /\bimport\(/, /\bglobalThis\b/, /from 'node:/, /\bBuffer\b/]) {
        assert.ok(!forbidden.test(code), `${name} uses ${forbidden}`);
      }
      const namedEntry = /export default [A-Za-z][A-Za-z0-9]*\s*;?\s*$/m.test(code) && /function [A-Za-z][A-Za-z0-9]*\(input:unknown\)/.test(code);
      // expected-quality 用具名函数再默认导出，参数仍是 unknown。沙箱调用的是这个默认导出。
      if (name !== 'types.ts' && name !== 'common.ts' && name !== 'text.ts') assert.ok(/export default function \(input: unknown\): unknown/.test(code) || namedEntry, name);
    }
  });

  it('run in the Hub sandbox with the same results as in process', async (t) => {
    if (!(await osIsolationAvailable())) return t.skip('sandbox-exec is not available on this machine');
    const tiny = parseFixture('tiny.km.json').model;
    const review = parseFixture('review-150.km.json').model;
    const projected = projectFn({ documents: [{ slot: 'mindmap', documentId: 'tiny', model: tiny }] }) as { items: unknown[] };
    const calls: Array<[string, unknown, (input: unknown) => unknown]> = [
      ['functions/project.ts', { documents: [{ slot: 'mindmap', documentId: 'tiny', model: tiny }] }, projectFn],
      ['functions/project.ts', { documents: [{ slot: 'mindmap', documentId: '880001', model: review }], parameters: { caseRule: 'marked' } }, projectFn],
      ['functions/tags.ts', { tags: ['[Functional', '负向', 'R2ADD'] }, tagsFn],
      ['functions/subject.ts', { items: projected.items, parameters: { scanCaseCommands: true } }, subjectFn],
      ['functions/expected-sources.ts', { documents: [{ documentId: 'tiny', model: tiny }] }, expectedSourcesFn],
      ['functions/template-coverage.ts', { items: projected.items, template: table('template-v3.json') }, templateCoverageFn],
    ];
    for (const [module, input, fn] of calls) {
      const result = await callPackFunction({ packDir: PACK_DIR, module }, input);
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, fn(input), module);
    }
  });

  it('refuse in the sandbox with a declared code instead of exceeding the sandbox output limit', async (t) => {
    if (!(await osIsolationAvailable())) return t.skip('sandbox-exec is not available on this machine');
    // 16,000 cases of about 520 bytes each: more than the sandbox's default 8 MiB output.
    const nodes: unknown[] = [{ data: { id: 'r', text: '根' }, children: Array.from({ length: 16 }, (_, g) => g + 1) }];
    const groups = 16;
    const per = 1000;
    for (let g = 0; g < groups; g++) nodes.push({ data: { id: `g${g}`, text: `组 ${g}`, priority: 1 }, children: Array.from({ length: per }, (_, i) => groups + 1 + (g * per + i) * 2) });
    for (let k = 0; k < groups * per; k++) {
      nodes.push({ data: { id: `c${k}`, text: `用例 ${k} widget health interval pool1 5`, priority: 2, resource: ['Function'] }, children: [nodes.length + 1] });
      nodes.push({ data: { id: `e${k}`, text: `show health 显示 pool1 的探测间隔为 5 秒 ${k}` }, children: [] });
    }
    const model = { doubleEncoded: false, meta: {}, duplicateIds: [], missingIds: 0, nulRemoved: 0, nodes };
    const result = await callPackFunction({ packDir: PACK_DIR, module: 'functions/project.ts' }, { documents: [{ documentId: 'big', model }] });
    const output = result.output as Failure;
    assert.equal(output.error.code, 'case-review.too_large');
  });
});
