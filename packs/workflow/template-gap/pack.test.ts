import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';
import { ChecksFile, PackManifest, PackSample, RequirementsFile, SlotsFile, WorkflowFile } from '../../../contracts/src/pack.ts';
import { TABLE_SCHEMAS } from '../../../contracts/src/tables.ts';
import { callPackFunction, getInterpreter, osIsolationAvailable } from '../../../hub/rules/api.ts';
import { readPackDirectory, refusalsOf, runPublishCheck, temporaryDirectory, validatePack } from '../../../hub/runs/api.ts';
import { PACK_DIR, isPackFile, manifestProblems, packFiles, readManifest, stagePack } from './api.ts';
import projectDefault, { projectDocuments } from './functions/project.ts';
import { commandOutcomes } from './functions/command-check.ts';
import { coverageOutcomes } from './functions/coverage-check.ts';
import { classificationSubject } from './functions/classification-subject.ts';
import subjectDefault from './functions/subject.ts';
import tagDeclarations from './functions/tag-declarations.ts';
import { isFailure } from './functions/common.ts';
import { commandSampleSubjects, commandTransitionalExamples } from './testing/command-samples.ts';
import { bindIndex, indexView, LOCK } from './testing/index.ts';
import type { PackWarning } from './functions/types.ts';
import { EXAMPLE_INPUT, EXAMPLE_RESULT, exampleBytes, exampleResult } from './testing/examples.ts';
import { baseDocument, outlineDocument, renamed } from './testing/mindmap.ts';
import { bind, projectionInput } from './testing/support.ts';

const json = (path: string): any => JSON.parse(readFileSync(join(PACK_DIR, path), 'utf8'));
const HAN = /\p{Script=Han}/u;
const TEMPLATE = json('tables/template-v3.json') as { categories: Array<{ id: string; label: string; required?: boolean }> };

let staged: { path: string; remove: () => Promise<void> };
before(async () => {
  staged = await temporaryDirectory('circle-hub-template-gap-pack-');
  await stagePack(staged.path);
});
after(() => staged?.remove());

describe('the pack directory', () => {
  it('pack.json lists every pack file with its SHA-256 and size, and nothing else', async () => {
    assert.deepEqual(await manifestProblems(), []);
    const manifest = await readManifest();
    assert.deepEqual([manifest.id, manifest.version, manifest.kind], ['template-gap', '1.2.12', 'workflow']);
    assert.deepEqual(manifest.files, await packFiles());
    for (const own of ['README.md', 'api.ts', 'pack.test.ts', 'engine.test.ts', 'testing/bed.ts', 'functions/project.test.ts']) assert.equal(isPackFile(own), false, own);
    const paths = manifest.files.map((f) => f.path);
    assert.ok(paths.every((p) => !p.endsWith('.test.ts') && !p.startsWith('testing/')));
    for (const required of ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'SKILL.md', 'functions/project.ts', 'functions/subject.ts', 'tables/template-v3.json', 'tables/template-v3-coverage.json', EXAMPLE_INPUT, EXAMPLE_RESULT]) {
      assert.ok(paths.includes(required), required);
    }
    assert.ok(paths.some((p) => p.startsWith('samples/positive/')) && paths.some((p) => p.startsWith('samples/negative/')));
  });

  it('the staged copy reads back as a pack whose digest is bound to its manifest', async () => {
    const read = await readPackDirectory(staged.path);
    assert.ok(read.ok, JSON.stringify(!read.ok && read.problems));
    assert.equal(read.pack.files.length, (await readManifest()).files.length);
  });

  it('validates and passes the publish check: every check has positive and negative samples, all of them pass', async () => {
    const read = await readPackDirectory(staged.path);
    assert.ok(read.ok);
    const validation = await validatePack(read.pack);
    assert.ok(validation.ok, JSON.stringify(!validation.ok && validation.problems, null, 1));
    assert.deepEqual(validation.pack.warnings, []);
    const report = await runPublishCheck({ pack: validation.pack, packDir: staged.path, sandbox: { requireOsIsolation: await osIsolationAvailable() } });
    assert.deepEqual(refusalsOf(report, validation.pack), []);
    // 标签声明检查多了正负各一份样例，一共 15 份，仍都是作者样例。
    assert.deepEqual(report.samples, { total: 15, passed: 15, failed: 0, sources: { author: 15, returned_counterexample: 0, retained_delivery: 0 } });
    assert.deepEqual(report.checks, [{ check: 'coverage', tier: 'advisory', positive: 2, negative: 4, sources: { author: 6, returned_counterexample: 0, retained_delivery: 0 }, marks: ['author_samples_only'] }, { check: 'command_coverage', tier: 'advisory', positive: 2, negative: 5, sources: { author: 7, returned_counterexample: 0, retained_delivery: 0 }, marks: ['author_samples_only'] }, { check: 'tag_declarations', tier: 'advisory', positive: 1, negative: 1, sources: { author: 2, returned_counterexample: 0, retained_delivery: 0 }, marks: ['author_samples_only'] }]);
    assert.deepEqual(report.unsampled, []);
    // Honest about the samples: all written by the author, so what the check supports is marked author_samples_only.
    assert.deepEqual(report.warnings.map((w) => w.rule), ['publish.author_samples_only', 'publish.author_samples_only', 'publish.author_samples_only']);
  });
});

describe('the declaration files', () => {
  it('workflow.json: one required subject slot taking many agile mind maps or JSON uploads, a scoped case index and command-catalog product binding', () => {
    const workflow = WorkflowFile.parse(json('workflow.json'));
    assert.deepEqual(workflow.inputs.map((i) => [i.slot, i.role, i.accepts, i.required, i.many]), [['documents', 'subject', ['agile:mindmap', 'application/json'], true, true], ['case_index', 'expected', ['knowledge:index'], false, false]]);
    assert.equal(workflow.subject, 'documents');
    assert.deepEqual(workflow.product, { catalogs: ['commands@1'] });
    assert.deepEqual(workflow.projection, { module: 'functions/project.ts' });
    assert.equal(workflow.expected_sources, undefined);
    assert.deepEqual(workflow.parameters.map((p) => [p.name, p.required]), [['skipped', false], ['case_rule', false]]);
    assert.ok(HAN.test(workflow.parameters[0].description) && HAN.test(workflow.inputs[0].description));
    // A skip is the user's declaration, never the model's judgment; an input batch is bounded (the sandbox input, the text).
    // 槽位说明要求跳过只认用户原话理由，并且 command 必须是完整身份对象。
    assert.match(workflow.parameters[0].description, /仅用户明确声明的不适用类别及原话理由/);
    assert.match(workflow.parameters[0].description, /原话理由/);
    assert.match(workflow.inputs[0].description, /一次最多约 30 份/);
  });

  it('the skipped parameter takes the template categories with a reason, optionally for one document', () => {
    const schema = json('workflow.json').parameters[0].schema;
    assert.deepEqual(schema.items.properties.category.enum, TEMPLATE.categories.map((c) => c.id), 'the categories of the template, in its order');
    const compiled = z.fromJSONSchema(schema);
    for (const ok of [[], [{ category: 'stress', reason: '不涉及' }], [{ category: 'database', reason: 'x', document: '90001' }]]) assert.ok(compiled.safeParse(ok).success, JSON.stringify(ok));
    for (const bad of [{}, 'stress', [{ category: 'stres', reason: 'x' }], [{ category: 'stress' }], [{ category: 'stress', reason: '' }], [{ category: 'stress', reason: 'x', extra: 1 }], [{ category: 'stress', reason: 'x', document: '' }]]) {
      assert.ok(!compiled.safeParse(bad).success, JSON.stringify(bad));
    }
    assert.doesNotMatch(JSON.stringify(schema), /"pattern(Properties)?"/, 'no regular expression: the engine refuses those (fail closed)');
  });

  it('requirements.json: two fact requirements on every item, static layer, bookkeeping, required, judged by the coverage check', () => {
    const { requirements } = RequirementsFile.parse(json('requirements.json'));
    assert.equal(requirements.length, 3);
    assert.deepEqual(requirements[1].checks, ["command_coverage"]);
    assert.deepEqual([requirements[1].target, requirements[1].accepted_producer, requirements[1].done_rule, requirements[1].layers], ["item", "fact", "bookkeeping", ["static"]]);
    const [r] = requirements;
    // 覆盖要求项接受的是判断，不是事实。标签声明是第三条。
    assert.deepEqual([r.key, r.target, r.accepted_producer, r.layers, r.done_rule, r.required, r.checks], ['coverage', 'item', 'judgment', ['static'], 'bookkeeping', true, ['coverage']]);
    assert.equal(requirements[2].key, 'tag_declarations');
    // With or without `* -> unknown`, a gap stays a violation (engine decision 6 aligns action unknown
    // to keep terminal violation with attribution unattributed). engine.test.ts tests the `* -> unknown` variant.
    assert.deepEqual(r.error_handling, []);
  });

  it('checks.json: coverage@1 over the subject built by functions/subject.ts, per item, judging the subject', () => {
    const { checks } = ChecksFile.parse(json('checks.json'));
    assert.deepEqual(checks[0], { id: 'coverage', title: '模板类别覆盖', applies: 'item', subject: { module: 'functions/classification-subject.ts' }, judges: 'subject', tier: 'advisory', function: { module: 'functions/coverage-check.ts' }, reads: { roles: ['subject'], max_bytes: 1048576 } });
    assert.deepEqual(checks[1], { id: 'command_coverage', title: '按命令的模板类别覆盖', function: { module: 'functions/command-check.ts' }, applies: 'item', subject: { module: 'functions/command-subject.ts' }, judges: 'subject', tier: 'advisory', reads: { roles: ['subject'], max_bytes: 1048576 } });
  });

  it('slots.schema.json declares nothing: the model fills no slot', () => {
    const slots = SlotsFile.parse(json('slots.schema.json'));
    assert.equal(slots.schema, 'slots@1');
    assert.deepEqual(slots.run, {});
    assert.equal(slots.item.coverage.data?.title, 'category-judgment@1');
  });

  it('the coverage table is an admitted coverage@1 table, advisory, naming its origin, whose members are the template categories', () => {
    const table = json('tables/template-v3-coverage.json');
    assert.ok(TABLE_SCHEMAS['coverage@1'].safeParse(table).success);
    assert.deepEqual(getInterpreter('coverage@1')?.validateTable(table), []);
    assert.equal(table.tier, 'advisory');
    assert.equal(table.basis, undefined);
    assert.ok(HAN.test(table.origin) && HAN.test(table.description));
    // A closed set written from the template, so the projection's own fields cannot decide what must be covered.
    assert.deepEqual(table.required, { values: TEMPLATE.categories.filter((c) => c.required !== false).map((c) => c.id) });
    assert.deepEqual(table.required.values, TEMPLATE.categories.map((c) => c.id), 'all 24 categories');
    assert.deepEqual(table.covered, ['$.covered[*]']);
  });

  it('samples: pack-sample@1 of the coverage check, both kinds, every one tagged with its source, subjects shaped like subject.ts builds them', () => {
    const manifest = PackManifest.parse(json('pack.json'));
    const samples = manifest.files.filter((f) => f.path.startsWith('samples/')).map((f) => ({ path: f.path, sample: PackSample.parse(json(f.path)) }));
    assert.equal(samples.length, 15);
    // 覆盖检查的主体是 classification-subject，不再是旧的 covered 列表。
    const keys = Object.keys(classificationSubject({ item: { id: 'x', location: 'src:x', fields: {} }, context: { groups: [] }, slots: {} })).sort();
    for (const { path, sample } of samples) {
      assert.ok(['coverage', 'command_coverage', 'tag_declarations'].includes(sample.check), path);
      // 覆盖和命令样例仍不能表达过渡未知。标签负例同时给出未声明闭集的 refute 和缺类型声明的 unknown。
      if (sample.check !== 'tag_declarations') assert.ok(!sample.expect.some(e => e.verdict === 'unknown'), `${path}: coverage and command samples still cannot express a transitional unknown`);
      assert.equal(sample.source, 'author', path);
      if (sample.check === 'coverage') assert.deepEqual(Object.keys(sample.subject as object).sort(), keys, path);
      assert.ok(sample.note !== undefined && HAN.test(sample.note), path);
    }
  });

  it('SKILL.md: relays the result unchanged, marks commentary as model relay, binds a catalog product and names every template category', async () => {
    const skill = await readFile(join(PACK_DIR, 'SKILL.md'), 'utf8');
    assert.match(skill, /最终只转述受理回执及其限定/);
    assert.match(skill, /product 和 build/);
    assert.match(skill, /fields=document,node,commands,command_identities,title,path_labels/);
    assert.match(skill, /默认 case_rule=marked/);
    for (const category of TEMPLATE.categories) assert.ok(skill.includes(category.id) && skill.includes(category.label), category.id);
    assert.match(skill, /24 个类别的必选范围/);
    assert.ok(skill.length < 4000, 'the procedure travels in every start_run answer');
  });

  it('SKILL.md: a skip is the user’s call with the user’s words, and the evidence step does not depend on a reference the answer may lack', async () => {
    const skill = await readFile(join(PACK_DIR, 'SKILL.md'), 'utf8');
    const step = (n: number): string => skill.split('\n').find((line) => line.startsWith(`${n}. `)) ?? '';
    assert.match(step(7), /skipped 只按用户明确声明填写/);
    assert.match(step(7), /reason 照用户原话/);
    assert.match(step(4), /unclassified 是还缺类别判断的用例，不是缺类别/);
    assert.match(step(9), /最终只转述受理回执/);
  });
});

describe('codes.json', () => {
  const codes = json('tables/codes.json') as { refusals: Array<{ code: string; when: string; fix: string }>; warnings: Array<{ code: string; when: string; fix: string }>; violations: Array<{ code: string; when: string; fix: string }>; checks: Array<{ code: string; when: string; fix: string }> };
  // undeclared_tag 在 checks 里，是提示档，不是违规。
  const declared = new Set([...codes.refusals, ...codes.warnings, ...codes.violations, ...codes.checks].map((entry) => entry.code));

  it('declares each code once, under the pack name, in Chinese', () => {
    const all = [...codes.refusals, ...codes.warnings, ...codes.violations, ...codes.checks];
    assert.equal(declared.size, all.length);
    for (const entry of all) {
      assert.match(entry.code, /^template-gap\.[a-z][a-z_]*$/);
      assert.ok(HAN.test(entry.when) && HAN.test(entry.fix), entry.code);
    }
  });

  it('covers every code the functions emit, and every declared code is reachable', () => {
    const emitted = new Set<string>();
    const collect = (out: unknown): void => {
      if (Array.isArray(out)) { out.forEach(collect); return; }
      if (out && typeof out === 'object' && 'code' in out && typeof out.code === 'string') emitted.add(out.code);
      const value = out as { error?: { code: string }; warnings?: PackWarning[] };
      if (value.error) emitted.add(value.error.code);
      for (const warning of value.warnings ?? []) emitted.add(warning.code);
    };
    const base = baseDocument();
    const model = (nodes: unknown[]) => ({ ...bind(base, { external: 'agile:mindmap:1' }), model: { nodes } });
    const tagged = (id: unknown, extra: object = {}) => ({ data: { id, text: '用例', priority: 2, resource: ['Function'], ...extra }, children: [] });
    collect(projectDefault(null));
    collect(projectDefault(projectionInput([bind(base)])));
    collect(projectDefault(projectionInput([bind(outlineDocument())], { case_rule: 'tagged' })));
    collect(projectDefault(projectionInput([bind(base, { external: 'agile:mindmap:1' }), bind(base, { external: 'agile:mindmap:2' })])));
    collect(projectDocuments(projectionInput([bind(base)]), { outputBytes: 1024 }));
    collect(projectDocuments(projectionInput([bind(base)]), { table: { schema: 'x' } }));
    collect(projectDefault({ get inputs(): never { throw new Error('x'); } }));
    collect(projectDefault(projectionInput([bind(base)], { skipped: [{ category: 'stress', reason: 'x', document: '999999' }] })));
    collect(projectDefault(projectionInput([model([{ data: { id: 'r', text: '根' }, children: [1, 2, 3, 4, 9] }, tagged('d'), tagged('d'), tagged(null), tagged('x'.repeat(300), { resource: ['Function', null] })])])));
    collect(projectDefault(projectionInput([model(Array.from({ length: 205 }, (_, i) => ({ data: { id: `n${i}`, text: 'x', ...(i === 1 ? { priority: 2, resource: ['Stress'] } : {}) }, children: i < 204 ? [i + 1] : [] })))])));
    for (const example of commandSampleSubjects()) collect(commandOutcomes(example.subject));
    collect(coverageOutcomes({ skipped: [{ category: 'not-a-category', reason: '合成' }] }));
    // 示例文档已按 category_ids 分类并缺 stress，完整范围下才是 category_shortfall。
    const projected = projectDocuments({ inputs: [bind(exampleBytes())], parameters: {}, context: LOCK });
    if (!isFailure(projected)) {
      const item = projected.items[0]!;
      collect(coverageOutcomes(classificationSubject({
        applies: 'item',
        item: { id: item.id, label: item.label, location: `src:x/${item.location.parser}/${item.location.selector}`, fields: item.fields },
        slots: { coverage: [] }, evidence: [], context: { ...LOCK, groups: projected.groups },
      })));
    }
    collect(tagDeclarations({ subject: { item: '1', location: 'src:x', fields: { case_resources: [{ case: 'c', present: true, resource: ['NotAType'] }] } } }));
    collect(projectDefault(projectionInput([bind(base, { external: 'agile:mindmap:900001' }), bindIndex(indexView([], ['900001']))])));
    for (const code of emitted) assert.ok(declared.has(code), `${code} is not declared in tables/codes.json`);
    for (const code of declared) assert.ok(emitted.has(code), `${code} is declared but no scenario emits it`);
  });
});

describe('the pack functions', () => {
  const sources = ['functions/cases.ts', 'functions/category-evidence.ts', 'functions/classification-subject.ts', 'functions/classification.ts', 'functions/command-check.ts', 'functions/command-identity.ts', 'functions/command-subject.ts', 'functions/commands.ts', 'functions/common.ts', 'functions/coverage-check.ts', 'functions/generated/vocabulary.ts', 'functions/index.ts', 'functions/project.ts', 'functions/source-quotes.ts', 'functions/subject.ts', 'functions/tag-declarations.ts', 'functions/tags.ts', 'functions/template.ts', 'functions/text.ts', 'functions/types.ts'];

  it('are exactly the listed modules, import only the pack at run time and use no clock, randomness or I/O', async () => {
    assert.deepEqual((await readManifest()).files.map((f) => f.path).filter((p) => p.startsWith('functions/')), sources);
    for (const name of sources) {
      const code = readFileSync(join(PACK_DIR, name), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
        .join('\n');
      for (const match of code.matchAll(/^\s*import\s+(type\s+)?[^'"]*from\s+'([^']+)'(.*)$/gm)) {
        if (match[1] !== undefined) continue;
        // 类别判断和命令身份按包内 JSON Schema 校验；引文只许 source-quotes 用 createHash 核对原文字节。
        if (match[2] === 'zod') assert.ok(name === 'functions/classification.ts' || name === 'functions/command-identity.ts', name);
        else if (match[2] === 'node:crypto') assert.equal(name, 'functions/source-quotes.ts');
        else if (/^\.\.\/tables\/[a-z0-9.-]+\.json$/.test(match[2])) assert.match(match[3], /with \{\s*type:\s*'json'\s*\}/, name);
        else assert.match(match[2], /^\.\/(?:[a-z-]+|generated\/vocabulary)\.ts$/, `${name} imports ${match[2]} at run time`);
      }
      for (const forbidden of [/\bDate\b/, /Math\.random/, /\bprocess\b/, /\brequire\(/, /\bfetch\(/, /\bsetTimeout\b/, /\bperformance\b/, /\beval\(/, /new Function/, /\bimport\(/, /\bglobalThis\b/, /from 'node:(?!crypto')/, /\bBuffer\b/]) {
        assert.ok(!forbidden.test(code), `${name} uses ${forbidden}`);
      }
    }
    for (const declared of ['functions/project.ts', 'functions/subject.ts']) assert.match(readFileSync(join(PACK_DIR, declared), 'utf8'), /export default function \(input: unknown\): unknown/, declared);
  });

  it('run in the Hub sandbox with the same results as in process', async (t) => {
    if (!(await osIsolationAvailable())) return t.skip('sandbox-exec is not available on this machine');
    const input = projectionInput([bind(renamed(baseDocument(), 'r0sandbox001'), { external: 'agile:mindmap:900001', meta: { title: '沙箱里的文档', folders: ['甲'] } }), bind(outlineDocument('r0sandbox002'))], { case_rule: 'tagged' });
    const refused = await callPackFunction({ packDir: staged.path, module: 'functions/project.ts' }, input);
    assert.equal(refused.osIsolation, true);
    assert.deepEqual(refused.output, projectDefault(input));
    const ok = projectionInput([bind(renamed(baseDocument(), 'r0sandbox001'), { external: 'agile:mindmap:900001' })], { skipped: [{ category: 'database', reason: '不涉及' }] });
    const projected = await callPackFunction({ packDir: staged.path, module: 'functions/project.ts' }, ok);
    assert.deepEqual(projected.output, projectDefault(ok));
    const [item] = (projected.output as { items: Array<{ id: string; label: string; fields: unknown }> }).items;
    const subjectInput = { applies: 'item', item: { id: item.id, label: item.label, location: 'src:x', fields: item.fields }, slots: null, evidence: [], context: ok.context };
    const subject = await callPackFunction({ packDir: staged.path, module: 'functions/subject.ts' }, subjectInput);
    assert.deepEqual(subject.output, subjectDefault(subjectInput));
  });

  it('stay inside the sandbox limits on hostile maps: a long dash run in the root text, a deep chain above many cases', async (t) => {
    if (!(await osIsolationAvailable())) return t.skip('sandbox-exec is not available on this machine');
    const km = (root: unknown) => new TextEncoder().encode(JSON.stringify({ root, template: 'right', theme: 'classic', version: '1.4.43' }));
    const n = (id: string, text: string, extra: Record<string, unknown> = {}, ...children: unknown[]) => ({ data: { id, text, ...extra }, children });
    const kase = (id: string) => n(id, `用例 ${id}`, { priority: 2, resource: ['Function'] }, n(`${id}e`, '期望'));
    // Before: the earlier arrow pattern was quadratic on the dashes and ran once per case (SANDBOX_TIMEOUT after 10 s).
    const dashes = km(n('r', `用例${'-'.repeat(20_000)}`, {}, ...Array.from({ length: 80 }, (_, i) => kase(`c${i}`))));
    // Before: every case copied and normalized its 190 ancestors (SANDBOX_VIOLATION, memory, after 1.4 s).
    let chain: unknown = n('g189', '分组 189', { priority: 1 }, ...Array.from({ length: 20_000 }, (_, i) => kase(`d${i}`)));
    for (let k = 188; k >= 0; k--) chain = n(`g${k}`, `分组 ${k}`, { priority: 1 }, chain);
    const deep = km(n('r', '根', {}, chain));
    for (const [name, bytes, cases] of [['dashes', dashes, 80], ['deep', deep, 20_000]] as const) {
      const input = projectionInput([bind(bytes, { external: 'agile:mindmap:700200' })]);
      const started = performance.now();
      const out = await callPackFunction({ packDir: staged.path, module: 'functions/project.ts' }, input);
      const took = performance.now() - started;
      const produced = out.output as { items?: Array<{ fields: { caseCount: number } }>; error?: { code?: string } };
      assert.deepEqual(out.output, projectDefault(input), name);
      assert.ok(took < 5_000, `${name}: ${took.toFixed(0)} ms in the sandbox`);
      if (name === 'deep') {
        // 两万条用例带上逐条分类和 resource 后超过投影自己的 8MB 上限，函数拒绝，不把沙箱超时或内存违规当成通过。
        assert.equal(produced.error?.code, 'template-gap.too_large', name);
        continue;
      }
      if (!produced.items) assert.fail(`${name}: ${JSON.stringify(produced).slice(0, 400)}`);
      const [item] = produced.items;
      assert.equal(item.fields.caseCount, cases, name);
    }
  });
});

describe('the examples', () => {
  it('are what the functions give for the example document', async () => {
    const bytes = new Uint8Array(await readFile(join(PACK_DIR, EXAMPLE_INPUT)));
    assert.deepEqual(bytes, exampleBytes(), 'the example input is the synthetic document without its Stress cases');
    assert.deepEqual(json(EXAMPLE_RESULT), await exampleResult(bytes));
    assert.deepEqual(json(EXAMPLE_RESULT).item.fields.missing, ['stress']);
  });
});

it('records decision 35 item 19 while keeping all 24 template categories required', async () => {
  const readme = await readFile(join(PACK_DIR, 'README.md'), 'utf8');
  assert.match(readme, /1\. .*已定（决定 35 第 19 项）/);
  assert.equal(TEMPLATE.categories.length, 24);
  assert.ok(TEMPLATE.categories.every(category => category.required !== false));
});

it('documents the transitional-sample contract gap and the unversioned follow-up without inventing an interface', async () => {
  const readme = await readFile(join(PACK_DIR, 'README.md'), 'utf8');
  assert.match(readme, /期望过渡未知/); assert.match(readme, /合约缺口/); assert.match(readme, /kb-unversioned/);
  // JSON 不保留值为 undefined 的 claims；提交的样例就是 stringify 之后的形状。
  for (const pair of commandTransitionalExamples()) assert.deepEqual(json(`examples/${pair.id}.json`), JSON.parse(JSON.stringify(pair)));
});
