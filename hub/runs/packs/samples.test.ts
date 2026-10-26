import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { readPackDirectory } from './directory.ts';
import { refusalsOf, runPublishCheck } from './samples.ts';
import { editJson, temporaryDirectory, withFiles, workflowPack, writePack, type PackDescription } from './testing/builder.ts';
import type { PublishReport, ValidatedPack } from './types.ts';
import { validatePack } from './validate.ts';

let temp: { path: string; remove: () => Promise<void> };
let n = 0;
before(async () => {
  temp = await temporaryDirectory();
});
after(() => temp?.remove());

type Json = Record<string, any>;

async function checked(pack: PackDescription): Promise<{ report: PublishReport; pack: ValidatedPack; dir: string }> {
  const written = await writePack(join(temp.path, `s${++n}`), pack);
  const read = await readPackDirectory(written.dir);
  assert.ok(read.ok, JSON.stringify(!read.ok && read.problems));
  const validation = await validatePack(read.pack);
  assert.ok(validation.ok, JSON.stringify(!validation.ok && validation.problems, null, 1));
  // The written source directory serves as the pack directory here; the registry uses a read-only extraction.
  const report = await runPublishCheck({ pack: validation.pack, packDir: written.dir, sandbox: { requireOsIsolation: false } });
  return { report, pack: validation.pack, dir: written.dir };
}

const base = workflowPack();
const titlesGood = base.files['samples/positive/titles-good.json'] as Json;

test('every sample runs and passes; counts are reported by source per check, and author-only support is marked', async () => {
  const { report, pack } = await checked(base);
  assert.deepEqual(report.samples, { total: 4, passed: 4, failed: 0, sources: { author: 3, returned_counterexample: 1, retained_delivery: 0 } });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(refusalsOf(report, pack), []);
  const titles = report.checks.find((c) => c.check === 'titles');
  const codes = report.checks.find((c) => c.check === 'codes');
  assert.deepEqual(titles, { check: 'titles', tier: 'blocking', positive: 1, negative: 1, sources: { author: 1, returned_counterexample: 1, retained_delivery: 0 }, marks: [] });
  assert.deepEqual(codes, { check: 'codes', tier: 'advisory', positive: 1, negative: 1, sources: { author: 2, returned_counterexample: 0, retained_delivery: 0 }, marks: ['author_samples_only'] });
  const warning = report.warnings.find((w) => w.rule === 'publish.author_samples_only');
  assert.ok(warning && /codes/.test(warning.message) && /仅作者样例/.test(warning.message));
});

test('a sample whose outcomes differ from its expectation refuses the publication with check, sample and the difference', async () => {
  const wrong = editJson<Json>(base, 'samples/negative/titles-bad.json', (s) => void (s.expect[0].code = 'core.structure.duplicate_key'));
  const { report, pack } = await checked(wrong);
  assert.equal(report.samples.failed, 1);
  assert.equal(report.failures.length, 1);
  const failure = report.failures[0];
  assert.equal(failure.check, 'titles');
  assert.equal(failure.sample, 'titles_bad');
  assert.equal(failure.file, 'samples/negative/titles-bad.json');
  assert.equal(failure.source, 'returned_counterexample');
  assert.ok(failure.differences.some((d) => d.includes('core.structure.duplicate_key') && d.includes('core.structure.required_empty')), JSON.stringify(failure.differences));
  const refusals = refusalsOf(report, pack);
  assert.ok(refusals.some((p) => p.rule === 'publish.sample_failed' && p.file === failure.file && /titles_bad/.test(p.message)));
});

test('the number of outcomes, the verdict, the item and the tier are compared', async () => {
  const extra = editJson<Json>(base, 'samples/negative/titles-bad.json', (s) => void s.expect.pop());
  const tooFew = (await checked(extra)).report.failures[0];
  assert.ok(tooFew.differences.some((d) => /期望 1 个结果，实际 2 个/.test(d)));
  assert.ok(tooFew.differences.some((d) => /多出的第 2 个结果/.test(d)));
  const verdict = editJson<Json>(base, 'samples/positive/titles-good.json', (s) => void (s.subject.items[0].fields.title = ''));
  assert.ok((await checked(verdict)).report.failures[0].differences.some((d) => /应为支持/.test(d)));
  const item = editJson<Json>(base, 'samples/positive/titles-good.json', (s) => void (s.expect[0].item = 'z'));
  assert.ok((await checked(item)).report.failures[0].differences.some((d) => /item 应为 z/.test(d)));
  const tier = editJson<Json>(base, 'samples/positive/titles-good.json', (s) => void (s.expect[0].tier = 'advisory'));
  assert.ok((await checked(tier)).report.failures[0].differences.some((d) => /tier 应为 advisory/.test(d)));
});

test('a check without a positive or a negative sample is refused, whatever its tier (C05 R[0], T02 R[0])', async () => {
  const noNegative = withFiles(base, { 'samples/negative/titles-bad.json': null });
  const { report, pack } = await checked(noNegative);
  assert.deepEqual(report.unsampled.find((u) => u.check === 'titles'), { check: 'titles', tier: 'blocking', missing: ['negative'] });
  const refusal = refusalsOf(report, pack).find((p) => p.rule === 'publish.unsampled');
  assert.ok(refusal && refusal.file === 'checks.json' && refusal.field === '/checks/0' && /反例/.test(refusal.message));

  const noPositive = withFiles(base, { 'samples/positive/titles-good.json': null });
  const positive = await checked(noPositive);
  assert.ok(refusalsOf(positive.report, positive.pack).some((p) => p.rule === 'publish.unsampled' && /正例/.test(p.message)));

  // An advisory check is a rule like any other: unexercised, a misconfigured one would stay unknown in every run.
  const advisory = withFiles(base, { 'samples/positive/codes-good.json': null, 'samples/negative/codes-bad.json': null });
  const unsampled = await checked(advisory);
  assert.deepEqual(unsampled.report.unsampled, [{ check: 'codes', tier: 'advisory', missing: ['positive', 'negative'] }]);
  const refused = refusalsOf(unsampled.report, unsampled.pack);
  assert.deepEqual(refused.map((p) => [p.rule, p.field]), [['publish.unsampled', '/checks/1']]);
  assert.match(refused[0].message, /提示档/);
  assert.deepEqual(unsampled.report.checks.find((c) => c.check === 'codes')?.marks, ['author_samples_only'], 'no sample from outside the author: marked');
});

test('a declaration that makes a check advisory does not exempt it from samples', async () => {
  const advisory = editJson<Json>(withFiles(base, { 'samples/negative/titles-bad.json': null, 'samples/positive/titles-good.json': null }), 'checks.json', (c) => void (c.checks[0].tier = 'advisory'));
  const { report, pack } = await checked(advisory);
  assert.deepEqual(refusalsOf(report, pack).map((p) => [p.rule, p.field]), [['publish.unsampled', '/checks/0']]);
});

test("a sample's catalog is bound only for a check that declares one, as a run binds it", async () => {
  const root = 'c'.repeat(64);
  const catalogTable = { schema: 'catalog@1', origin: '决定：合成的命令目录检查', item: '/id', catalog: 'commands', commands: ['$.commands'], scope: 'all', required: true };
  const pack = withFiles(
    editJson<Json>(
      editJson<Json>(base, 'checks.json', (c) => void c.checks.push({ id: 'commands', interpreter: 'catalog@1', table: 'tables/commands.json', applies: 'item', judges: 'subject', catalog: 'commands@1', tier: 'advisory' })),
      'requirements.json',
      (r) => void r.requirements[0].checks.push('commands'),
    ),
    {
      'tables/commands.json': catalogTable,
      'samples/positive/commands-good.json': { id: 'commands_good', source: 'author', check: 'commands', subject: { id: 'i1', commands: ['show widget'] }, catalog: { root, entries: [{ head: 'show widget' }] }, expect: [{ verdict: 'support', item: 'i1' }] },
      'samples/negative/commands-bad.json': { id: 'commands_bad', source: 'author', check: 'commands', subject: { id: 'i1', commands: ['show gizmo'] }, catalog: { root, entries: [{ head: 'show widget' }] }, expect: [{ verdict: 'refute', code: 'core.catalog.not_member', item: 'i1' }] },
    },
  );
  const { pack: validated, dir } = await checked(pack);
  // The same samples for a check that declares no catalog (validation refuses that pack; here the declaration is changed
  // after it) see no catalog: the support they expect becomes unknown (missing input), exactly what a run would give.
  const unbound = structuredClone(validated);
  if (unbound.declarations.kind !== 'workflow') throw new Error('workflow expected');
  delete unbound.declarations.checks.checks[2].catalog;
  const report = await runPublishCheck({ pack: unbound, packDir: dir, sandbox: { requireOsIsolation: false } });
  const failure = report.failures.find((f) => f.sample === 'commands_good');
  assert.ok(failure && failure.differences.some((d) => /未知/.test(d)), JSON.stringify(report.failures, null, 1));
});

test('a sample with a catalog consults it; a malformed catalog is a failure of that sample', async () => {
  const root = 'c'.repeat(64);
  const catalogTable = { schema: 'catalog@1', origin: '决定：合成的命令目录检查', tier: 'blocking', basis: '要求项 commands：命令在目录里', item: '/id', catalog: 'commands', commands: ['$.commands'], scope: 'all', required: true };
  const pack = withFiles(
    editJson<Json>(
      editJson<Json>(base, 'checks.json', (c) => void c.checks.push({ id: 'commands', interpreter: 'catalog@1', table: 'tables/commands.json', applies: 'item', judges: 'subject', catalog: 'commands@1', tier: 'blocking' })),
      'requirements.json',
      (r) => void r.requirements[0].checks.push('commands'),
    ),
    {
      'tables/commands.json': catalogTable,
      'samples/positive/commands-good.json': { id: 'commands_good', source: 'retained_delivery', check: 'commands', subject: { id: 'i1', commands: ['show widget'] }, catalog: { root, entries: [{ head: 'show widget' }] }, expect: [{ verdict: 'support', item: 'i1' }] },
      'samples/negative/commands-bad.json': { id: 'commands_bad', source: 'author', check: 'commands', subject: { id: 'i1', commands: ['show gizmo'] }, catalog: { root, entries: [{ head: 'show widget' }] }, expect: [{ verdict: 'refute', code: 'core.catalog.not_member', item: 'i1' }] },
    },
  );
  const { report } = await checked(pack);
  assert.deepEqual(report.failures, [], JSON.stringify(report.failures, null, 1));
  assert.equal(report.samples.sources.retained_delivery, 1);
  const broken = editJson<Json>(pack, 'samples/positive/commands-good.json', (s) => void (s.catalog = { root: 'not-a-digest', entries: [{ head: 'show widget' }] }));
  const failure = (await checked(broken)).report.failures.find((f) => f.sample === 'commands_good');
  assert.ok(failure && failure.differences.some((d) => /catalog 不是有效的目录/.test(d)));
});

test('named closed sets reach membership tables as <requirement>.codes', async () => {
  // CODES_TABLE uses { name: 'findings.codes' }: a code outside slots.item.findings.codes is refuted by the sample run.
  const renamed = editJson<Json>(base, 'slots.schema.json', (s) => void (s.item.findings.codes = [{ code: 'other', label: '其他' }]));
  const { report } = await checked(renamed);
  assert.deepEqual(report.failures.map((f) => f.sample).sort(), ['codes_bad', 'codes_good']);
});

test('samples of a pack function run in the sandbox against the pack directory', async () => {
  const functionCheck = withFiles(
    editJson<Json>(
      editJson<Json>(base, 'checks.json', (c) => void c.checks.push({ id: 'balance', function: { module: 'functions/balance.ts' }, applies: 'item', judges: 'subject', basis: '要求项 titles 的合同条款', tier: 'blocking' })),
      'requirements.json',
      (r) => void r.requirements[0].checks.push('balance'),
    ),
    {
      'functions/balance.ts': [
        'interface Input { subject: { id: string; left: number; right: number } }',
        'export default function balance(input: unknown): unknown {',
        '  const { subject } = input as Input;',
        "  if (subject.left === subject.right) return [{ verdict: 'support', statement: '两边相等', grounds: [], tier: 'advisory', item: subject.id }];",
        "  return [{ verdict: 'refute', code: 'demo-review.unbalanced', statement: '两边不等', grounds: [], tier: 'advisory', item: subject.id }];",
        '}',
        '',
      ].join('\n'),
      'samples/positive/balance-good.json': { id: 'balance_good', source: 'author', check: 'balance', subject: { id: 'k', left: 1, right: 1 }, expect: [{ verdict: 'support', item: 'k', tier: 'blocking' }] },
      'samples/negative/balance-bad.json': { id: 'balance_bad', source: 'returned_counterexample', check: 'balance', subject: { id: 'k', left: 1, right: 2 }, expect: [{ verdict: 'refute', code: 'demo-review.unbalanced', item: 'k' }] },
    },
  );
  const { report } = await checked(functionCheck);
  assert.deepEqual(report.failures, [], JSON.stringify(report.failures, null, 1));
  assert.equal(report.checks.find((c) => c.check === 'balance')?.tier, 'blocking');
  const wrong = editJson<Json>(functionCheck, 'samples/negative/balance-bad.json', (s) => void (s.expect[0].code = 'demo-review.other'));
  const failure = (await checked(wrong)).report.failures.find((f) => f.sample === 'balance_bad');
  assert.ok(failure && failure.differences.some((d) => d.includes('demo-review.unbalanced')));
});

test('a pack check function sees the context a run gives it: the pack, the first requirement listing the check, the closed sets', async () => {
  const echo = withFiles(
    editJson<Json>(
      editJson<Json>(base, 'checks.json', (c) => void c.checks.push({ id: 'echo', function: { module: 'functions/echo.ts' }, applies: 'run', judges: 'subject', tier: 'advisory' })),
      'requirements.json',
      (r) => void r.requirements[1].checks.push('echo'),
    ),
    {
      'functions/echo.ts': [
        'interface Input { context: { pack?: string; requirement?: string; sets?: Record<string, string[]> } }',
        'export default function echo(input: unknown): unknown {',
        '  const { context } = input as Input;',
        "  const item = [context.pack, context.requirement, Object.keys(context.sets ?? {}).sort().join(',')].join('/');",
        "  return [{ verdict: 'support', statement: '回显', grounds: [], tier: 'advisory', item }];",
        '}',
        '',
      ].join('\n'),
      'samples/positive/echo.json': { id: 'echo_context', source: 'author', check: 'echo', subject: null, expect: [{ verdict: 'support', item: 'demo-review/findings/findings.codes,findings.ranks,level.codes,level.ranks' }] },
    },
  );
  const { report } = await checked(echo);
  assert.deepEqual(report.failures, [], JSON.stringify(report.failures, null, 1));
});

test('a sample of a pack function needs the pack directory', async () => {
  const functionCheck = withFiles(editJson<Json>(base, 'checks.json', (c) => void c.checks.push({ id: 'noop', function: { module: 'functions/util.ts', export: 'itemsOf' }, applies: 'item', judges: 'subject', tier: 'advisory' })), {
    'samples/positive/noop.json': { ...titlesGood, id: 'noop_good', check: 'noop' },
  });
  const written = await writePack(join(temp.path, `s${++n}`), functionCheck);
  const read = await readPackDirectory(written.dir);
  assert.ok(read.ok);
  const validation = await validatePack(read.pack);
  assert.ok(validation.ok, JSON.stringify(!validation.ok && validation.problems));
  const report = await runPublishCheck({ pack: validation.pack, packDir: null });
  assert.ok(report.failures.find((f) => f.sample === 'noop_good')?.differences.some((d) => /没有解包后的目录/.test(d)));
});
