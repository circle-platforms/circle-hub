import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { readPackDirectory } from './directory.ts';
import { editJson, productPack, systemPack, temporaryDirectory, withFiles, workflowPack, writePack, type PackDescription } from './testing/builder.ts';
import type { PackProblem, PackValidation } from './types.ts';
import { validatePack } from './validate.ts';

let temp: { path: string; remove: () => Promise<void> };
let n = 0;
before(async () => {
  temp = await temporaryDirectory();
});
after(() => temp?.remove());

type Json = Record<string, any>;

async function validated(pack: PackDescription): Promise<PackValidation> {
  const written = await writePack(join(temp.path, `v${++n}`), pack);
  const read = await readPackDirectory(written.dir);
  assert.ok(read.ok, `the directory itself should read: ${JSON.stringify(!read.ok && read.problems)}`);
  return validatePack(read.pack);
}

async function refused(pack: PackDescription, rule: string, where: { file?: string; field?: string } = {}): Promise<PackProblem> {
  const result = await validated(pack);
  assert.equal(result.ok, false, `expected ${rule}, but the pack validated`);
  const all = result.ok ? [] : result.problems;
  const hit = all.find((p) => p.rule === rule && (where.file === undefined || p.file === where.file) && (where.field === undefined || p.field === where.field));
  assert.ok(hit, `expected ${rule} ${JSON.stringify(where)} in ${JSON.stringify(all, null, 1)}`);
  assert.match(hit.message, /\p{Script=Han}/u);
  assert.match(hit.fix, /\p{Script=Han}/u);
  return hit;
}

async function accepted(pack: PackDescription): Promise<PackValidation & { ok: true }> {
  const result = await validated(pack);
  assert.ok(result.ok, `expected the pack to validate: ${JSON.stringify(!result.ok && result.problems, null, 1)}`);
  return result as PackValidation & { ok: true };
}

const base = workflowPack();
// The edits mutate their copy; whatever they return is ignored.
const changed = (path: string) => (edit: (value: Json) => unknown) =>
  editJson<Json>(base, path, (f) => {
    edit(f);
  });
const requirements = changed('requirements.json');
const checks = changed('checks.json');
const slots = changed('slots.schema.json');
const workflow = changed('workflow.json');
const projection = (source: string, extra: Record<string, string> = {}) => withFiles(base, { 'functions/project.ts': source, ...extra });

test('the synthetic workflow, product and system packs validate', async () => {
  const workflowResult = await accepted(base);
  assert.equal(workflowResult.pack.declarations.kind, 'workflow');
  assert.equal(workflowResult.pack.samples.length, 4);
  assert.deepEqual(workflowResult.pack.warnings, []);
  assert.equal((await accepted(productPack())).pack.declarations.kind, 'product');
  assert.equal((await accepted(systemPack())).pack.declarations.kind, 'system');
});

test('every check a requirement lists exists, once', async () => {
  const p = await refused(requirements((f) => f.requirements[0].checks.push('ghost')), 'requirements.unknown_check', { file: 'requirements.json', field: '/requirements/0/checks/1' });
  assert.match(p.message, /ghost/);
  await refused(requirements((f) => f.requirements[0].checks.push('titles')), 'requirements.duplicate_check');
});

test("a check's table exists under tables/ or policies/, is JSON and passes the interpreter's admission", async () => {
  await refused(checks((f) => (f.checks[0].table = 'functions/titles.json')), 'checks.table_place', { field: '/checks/0/table' });
  await refused(checks((f) => (f.checks[0].table = 'tables/none.json')), 'checks.table_missing', { field: '/checks/0/table' });
  await refused(withFiles(base, { 'tables/titles.json': '{ not json' }), 'file.json', { file: 'tables/titles.json' });
  const p = await refused(editJson<Json>(base, 'tables/titles.json', (t) => void delete t.origin), 'checks.table_admission', { file: 'tables/titles.json' });
  assert.match(p.message, /structure@1/);
  await refused(editJson<Json>(base, 'tables/titles.json', (t) => void delete t.basis), 'checks.table_admission', { file: 'tables/titles.json', field: '/tier' });
  await refused(checks((f) => (f.checks[0].interpreter = 'nothing@1')), 'checks.interpreter_missing', { field: '/checks/0/interpreter' });
  // Passing: a table under policies/.
  await accepted(withFiles(checks((f) => (f.checks[0].table = 'policies/titles.json')), { 'tables/titles.json': null, 'policies/titles.json': base.files['tables/titles.json'] }));
});

test('a check consults only catalogs the workflow declares', async () => {
  await refused(checks((f) => (f.checks[1].catalog = 'other@1')), 'checks.catalog_undeclared', { field: '/checks/1/catalog' });
  await accepted(checks((f) => (f.checks[1].catalog = 'commands@1')));
});

test('a blocking check names its contract clause (C05 R[1])', async () => {
  const withFunction = withFiles(
    checks((f) => f.checks.push({ id: 'custom', function: { module: 'functions/check.ts' }, applies: 'item', judges: 'subject', tier: 'blocking' })),
    { 'functions/check.ts': 'export default function check(_input: unknown): unknown {\n  return [];\n}\n' },
  );
  await refused(withFunction, 'checks.blocking_without_basis', { field: '/checks/2/tier' });
  const result = await accepted(editJson<Json>(withFunction, 'checks.json', (f) => void (f.checks[2].basis = '要求项 titles 的合同条款')));
  // Listed by no requirement: a warning, not a refusal.
  assert.ok(result.pack.warnings.some((w) => w.rule === 'checks.unused' && w.field === '/checks/2/id'));
});

test('every function reference names an existing module inside functions/', async () => {
  const missing = 'functions/none.ts';
  const variants: [PackDescription, string, string][] = [
    [workflow((w) => (w.projection = { module: missing })), 'workflow.json', '/projection/module'],
    [workflow((w) => (w.expected_sources = { module: missing })), 'workflow.json', '/expected_sources/module'],
    [checks((f) => f.checks.push({ id: 'fn', function: { module: missing }, applies: 'item', judges: 'subject', tier: 'advisory' })), 'checks.json', '/checks/2/function/module'],
    [checks((f) => (f.checks[0].subject = { module: missing, export: 'build' })), 'checks.json', '/checks/0/subject/module'],
  ];
  const product = productPack();
  variants.push(
    [editJson<Json>(product, 'product.json', (p) => void (p.select_build = { module: missing })), 'product.json', '/select_build/module'],
    [editJson<Json>(product, 'product.json', (p) => void (p.producers[0].function = { module: missing })), 'product.json', '/producers/0/function/module'],
    [editJson<Json>(product, 'product.json', (p) => void (p.sync = { start: ['site:listing:index'], plan: { module: missing } })), 'product.json', '/sync/plan/module'],
  );
  variants.push([editJson<Json>(systemPack(), 'system.json', (s) => void (s.reads[0].project = { module: missing })), 'system.json', '/reads/0/project/module']);
  for (const [pack, file, field] of variants) await refused(pack, 'functions.missing_module', { file, field });
  await accepted(editJson<Json>(product, 'product.json', (p) => void (p.sync = { start: ['site:listing:index'], plan: { module: 'functions/produce.ts' } })));
  await refused(withFiles(systemPack(), { 'functions/project-item.ts': "import { request } from 'node:http';\nexport default function projectItem(): unknown {\n  return request;\n}\n" }), 'functions.import_builtin', { file: 'functions/project-item.ts' });
});

test('the static scan refuses imports the sandbox would refuse and admits those it allows', async () => {
  const header = "import { itemsOf } from './util.ts';\n";
  const body = 'export default function project(input: unknown): unknown {\n  return { items: itemsOf(input), warnings: [] };\n}\n';
  const refusedImports: [string, string][] = [
    ["import { readFileSync } from 'node:fs';\n", 'functions.import_builtin'],
    ["import child from 'child_process';\n", 'functions.import_builtin'],
    ["import 'node:nonexistent';\n", 'functions.import_builtin'],
    ["import lodash from 'lodash';\n", 'functions.import_package'],
    ["import pg from 'pg';\n", 'functions.import_package'],
    ["import { x } from '../../../../hub/records/api.ts';\n", 'functions.import_outside'],
    ["import { x } from '/etc/x.ts';\n", 'functions.import_outside'],
    ["import { x } from '#internal';\n", 'functions.import_outside'],
    ["import { x } from 'https://example.invalid/x.ts';\n", 'functions.import_url'],
    ["import { x } from 'data:text/javascript,export const x = 1';\n", 'functions.import_url'],
    ["import { x } from './none.ts';\n", 'functions.import_missing'],
    ["import { y } from './util';\n", 'functions.import_missing'],
    ["import table from '../tables/titles.json';\n", 'functions.import_json'],
    ["import { x } from '../SKILL.md';\n", 'functions.import_format'],
    ["const name = 'node:fs';\nawait import(name);\n", 'functions.import_computed'],
    ["const fs = process.getBuiltinModule('node:fs');\n", 'functions.import_builtin'],
    // An import whose specifiers are all inline `type` ones still loads the module under Node's type stripping.
    ["import { type Thing } from '../../../../hub/ports.ts';\n", 'functions.import_outside'],
    ["export { type Thing } from 'lodash';\n", 'functions.import_package'],
  ];
  for (const [line, rule] of refusedImports) {
    const p = await refused(projection(header + line + body), rule, { file: 'functions/project.ts' });
    assert.equal(typeof p.line, 'number', `${rule} names the line`);
  }
  // A module reached through a relative import is scanned too.
  await refused(projection(header + "import { helper } from './helper.ts';\n" + body, { 'functions/helper.ts': "import 'node:net';\nexport const helper = 1;\n" }), 'functions.import_builtin', { file: 'functions/helper.ts' });
  // Admitted: pure builtins, declared dependencies, files of the pack, JSON with its attribute, type-only imports from outside.
  const admitted = [
    "import { createHash } from 'node:crypto';\nimport { posix } from 'path';\nimport { z } from 'zod';\nimport { SaxesParser } from 'saxes';\n",
    "import table from '../tables/titles.json' with { type: 'json' };\n",
    "import type { PacksPort } from '../../../../hub/ports.ts';\nexport type { WorkflowStore } from '../../../../hub/ports.ts';\n",
    "const crypto = await import('node:crypto');\n",
  ];
  for (const line of admitted) await accepted(projection(header + line + body));
  // A test module next to the functions is never reached from a declaration, so its imports do not matter.
  await accepted(withFiles(base, { 'functions/project.test.ts': "import { test } from 'node:test';\nimport { readFileSync } from 'node:fs';\n" }));
});

test('the static scan checks that the declared export exists and reports syntax Node cannot strip', async () => {
  await refused(workflow((w) => (w.projection = { module: 'functions/project.ts', export: 'nope' })), 'functions.missing_export', { file: 'workflow.json', field: '/projection' });
  await refused(projection('export function project(): unknown {\n  return null;\n}\n'), 'functions.missing_export', { field: '/projection' });
  await accepted(workflow((w) => (w.projection = { module: 'functions/util.ts', export: 'itemsOf' })));
  await accepted(withFiles(workflow((w) => (w.projection = { module: 'functions/reexport.ts', export: 'itemsOf' })), { 'functions/reexport.ts': "export * from './util.ts';\n" }));
  await accepted(projection("import { itemsOf } from './util.ts';\nconst project = (input: unknown): unknown => ({ items: itemsOf(input), warnings: [] });\nexport { project as default };\n"));
  await refused(projection("export * from './util.ts';\n"), 'functions.missing_export', { field: '/projection' });
  await refused(projection('enum Color { Red }\nexport default function project(): unknown {\n  return Color.Red;\n}\n'), 'functions.unsupported_syntax', { file: 'functions/project.ts' });
  await refused(projection('namespace N { export const a = 1; }\nexport default function project(): unknown {\n  return N.a;\n}\n'), 'functions.unsupported_syntax');
  await refused(projection('class K { constructor(private x: number) {} }\nexport default function project(): unknown {\n  return new K(1);\n}\n'), 'functions.unsupported_syntax');
  await accepted(projection('namespace Types { export type A = string; }\nexport default function project(): unknown {\n  return null;\n}\n'));
  await refused(projection('export default function project(: unknown {\n'), 'functions.syntax', { file: 'functions/project.ts' });
  await refused(projection(Buffer.from([0xff, 0xfe, 0x41]) as unknown as string), 'functions.not_utf8');
});

test('judgment requirements have a slot entry under their target, fact requirements none, and no entry is unknown', async () => {
  await refused(slots((s) => void delete s.item.findings), 'slots.missing_entry', { file: 'slots.schema.json', field: '/item/findings' });
  await refused(slots((s) => void delete s.run.level), 'slots.missing_entry', { field: '/run/level' });
  await refused(slots((s) => void (s.item.titles = { min: 0 })), 'slots.fact_entry', { field: '/item/titles' });
  await refused(
    slots((s) => {
      s.item.level = s.run.level;
      delete s.run.level;
    }),
    'slots.wrong_target',
    { field: '/item/level' },
  );
  await refused(slots((s) => void (s.item.ghost = { min: 0 })), 'slots.unknown_requirement', { field: '/item/ghost' });
});

test('an independent judgment (independent_of) has a slot entry', async () => {
  const independent = requirements((f) => {
    f.requirements[1].accepted_producer = 'independent_judgment';
    f.requirements[1].independent_of = 'predecessor';
  });
  await accepted(independent);
  await refused(editJson<Json>(independent, 'slots.schema.json', (s) => void delete s.item.findings), 'slots.independent_entry', { field: '/item/findings' });
});

test("a run-level requirement's codes identify it alone", async () => {
  await refused(slots((s) => void s.run.level.codes.push({ code: 'gap', label: '缺口' })), 'slots.code_overlap', { field: '/run/level/codes/1/code' });
  const twoRun = requirements((f) => f.requirements.push({ ...f.requirements[2], key: 'verdict', name: '结论' }));
  await refused(editJson<Json>(twoRun, 'slots.schema.json', (s) => void (s.run.verdict = { codes: [{ code: 'level', label: '等级' }] })), 'slots.shape', { file: 'slots.schema.json' });
  await accepted(editJson<Json>(twoRun, 'slots.schema.json', (s) => void (s.run.verdict = { codes: [{ code: 'verdict', label: '结论' }] })));
});

test("the workflow's subject slot exists and the catalogs it requires are valid versioned ids", async () => {
  await refused(workflow((w) => (w.subject = 'other')), 'workflow.shape', { file: 'workflow.json', field: '/subject' });
  await refused(workflow((w) => (w.product.catalogs = ['Commands'])), 'workflow.shape', { field: '/product/catalogs/0' });
  await refused(workflow((w) => (w.product.catalogs = ['commands@1', 'commands@1'])), 'workflow.duplicate_catalog', { field: '/product/catalogs/1' });
  await refused(workflow((w) => (w.product.id = 'Not An Id')), 'workflow.product_id', { field: '/product/id' });
  await refused(editJson<Json>(base, 'knowledge.json', (k) => void (k.requires[0].catalog = 'commands')), 'knowledge.shape', { file: 'knowledge.json' });
  await refused(editJson<Json>(base, 'knowledge.json', (k) => void k.requires.push(k.requires[0])), 'knowledge.duplicate_catalog');
  await accepted(withFiles(workflow((w) => (w.product = { id: 'widget', catalogs: [] })), { 'knowledge.json': null }));
});

test('samples exercise declared checks, sit in their folder and expect what their folder says', async () => {
  const sample = base.files['samples/positive/titles-good.json'] as Json;
  await refused(withFiles(base, { 'samples/positive/ghost.json': { ...sample, id: 'ghost_sample', check: 'ghost' } }), 'samples.unknown_check', { file: 'samples/positive/ghost.json', field: '/check' });
  await refused(withFiles(base, { 'samples/positive/wrong.json': { ...sample, id: 'wrong', expect: [{ verdict: 'refute', code: 'core.structure.required_empty' }] } }), 'samples.polarity', { file: 'samples/positive/wrong.json' });
  await refused(withFiles(base, { 'samples/negative/soft.json': { ...sample, id: 'soft' } }), 'samples.polarity', { file: 'samples/negative/soft.json' });
  await refused(withFiles(base, { 'samples/other/x.json': { ...sample, id: 'elsewhere' } }), 'samples.place', { file: 'samples/other/x.json' });
  await refused(withFiles(base, { 'samples/positive/notes.txt': 'x' }), 'samples.format');
  await refused(withFiles(base, { 'samples/positive/bad.json': { ...sample, id: 'bad', source: 'someone' } }), 'samples.shape', { field: '/source' });
  const { subject: _subject, ...noSubject } = sample;
  await refused(withFiles(base, { 'samples/positive/nosubject.json': { ...noSubject, id: 'nosubject' } }), 'samples.shape', { field: '/subject' });
  // A subject may be null; whether the check agrees is the publish check's question, not validation's.
  await accepted(withFiles(base, { 'samples/positive/null-subject.json': { id: 'null_subject', source: 'author', check: 'titles', subject: null, expect: [{ verdict: 'support' }] } }));
  await refused(withFiles(base, { 'samples/positive/again.json': sample }), 'samples.duplicate_id', { field: '/id' });
  await refused(withFiles(base, { 'samples/positive/empty.json': { ...sample, id: 'empty', expect: [] } }), 'samples.expect_empty');
  await refused(withFiles(base, { 'samples/negative/abstain.json': { ...sample, id: 'abstains', expect: [{ verdict: 'abstain' }, { verdict: 'refute' }] } }), 'samples.abstain', { field: '/expect/0/verdict' });
});

test('error handling and expected outcomes name only known codes', async () => {
  await refused(requirements((f) => f.requirements[0].error_handling.unshift({ code: 'mystery.code', action: 'unknown' })), 'requirements.unknown_code', { field: '/requirements/0/error_handling/0/code' });
  await refused(requirements((f) => f.requirements[0].error_handling.unshift({ code: 'core.structure.invented', action: 'unknown' })), 'requirements.unknown_code');
  await refused(requirements((f) => f.requirements[0].error_handling.unshift({ code: 'demo-review.', action: 'unknown' })), 'requirements.unknown_code');
  await refused(
    requirements((f) => (f.requirements[0].expected = { overrides: [{ when: { pointer: '/negative', equals: true }, outcome: 'refute', codes: ['nobody.knows'] }] })),
    'requirements.unknown_code',
    { field: '/requirements/0/expected/overrides/0/codes/0' },
  );
  const known = await accepted(
    requirements((f) => {
      f.requirements[0].error_handling.unshift({ code: 'demo-review.missing_title', action: 'unknown' }, { code: 'QUOTE_MISMATCH', action: 'unknown' }, { code: 'core.structure.duplicate_key', action: 'repair', max_rounds: 1 });
      f.requirements[0].expected = { overrides: [{ when: { pointer: '/negative', equals: true }, outcome: 'refute', codes: ['core.structure.required_empty'] }] };
    }),
  );
  assert.deepEqual(known.pack.warnings, []);
});

test('a reject row belongs to a requirement with a blocking check on the artifact under verification (W02 F[7]): otherwise a warning', async () => {
  const onSubject = await accepted(requirements((f) => f.requirements[0].error_handling.unshift({ code: 'core.structure.duplicate_key', action: 'reject' })));
  const warning = onSubject.pack.warnings.find((w) => w.rule === 'requirements.reject_scope');
  assert.ok(warning && warning.field === '/requirements/0/error_handling/0/action' && /进已拒收/.test(warning.message));
  const onArtifact = await accepted(
    editJson<Json>(
      requirements((f) => f.requirements[1].error_handling.push({ code: 'core.membership.not_in_set', action: 'reject' })),
      'checks.json',
      (c) => {
        c.checks[1].tier = 'blocking';
        c.checks[1].basis = '要求项 findings：发现码来自声明的集合';
      },
    ),
  );
  assert.ok(!onArtifact.pack.warnings.some((w) => w.rule === 'requirements.reject_scope'));
  // A core code no check of the requirement can give is accepted with a warning.
  const unused = await accepted(requirements((f) => f.requirements[0].error_handling.unshift({ code: 'core.catalog.not_member', action: 'unknown' })));
  assert.ok(unused.pack.warnings.some((w) => w.rule === 'requirements.code_unused'));
  const unlisted = await accepted(checks((f) => f.checks.push({ id: 'spare', interpreter: 'structure@1', table: 'tables/titles.json', applies: 'run', judges: 'subject', tier: 'blocking' })));
  assert.ok(unlisted.pack.warnings.some((w) => w.rule === 'checks.unused'));
});

test('SKILL.md is non-empty UTF-8 text', async () => {
  await refused(withFiles(base, { 'SKILL.md': '  \n\t\n' }), 'skill.empty', { file: 'SKILL.md' });
  await refused(withFiles(base, { 'SKILL.md': Uint8Array.of(0xc3, 0x28) }), 'skill.encoding');
});

test('declaration files follow their contract shapes', async () => {
  await refused(requirements((f) => (f.requirements[0].layers = ['sideways'])), 'requirements.shape', { file: 'requirements.json', field: '/requirements/0/layers/0' });
  await refused(checks((f) => (f.checks[0].function = { module: 'functions/project.ts' })), 'checks.shape', { file: 'checks.json' });
  await refused(withFiles(base, { 'workflow.json': '[1, 2' }), 'file.json', { file: 'workflow.json' });
  await refused(editJson<Json>(productPack(), 'product.json', (p) => void p.names.push('WIDGET')), 'product.shape', { file: 'product.json', field: '/names/2' });
  await refused(editJson<Json>(productPack(), 'product.json', (p) => void (p.names[0] = ' Widget')), 'product.name_space', { field: '/names/0' });
  await refused(withFiles(systemPack(), { 'system.json': [1, 2] }), 'system.shape', { file: 'system.json' });
  await refused(editJson<Json>(systemPack(), 'system.json', (s) => void (s.routes[0].read = false)), 'system.shape', { field: '/routes/0/read' });
});

test('versions have one spelling, and each kind keeps to its own declaration files', async () => {
  await refused({ ...base, version: '1.01.0' }, 'manifest.version', { file: 'pack.json', field: '/version' });
  await accepted({ ...base, version: '11.0.12' });
  await refused(withFiles(productPack(), { 'workflow.json': base.files['workflow.json'] }), 'manifest.foreign_file', { file: 'pack.json' });
  await refused(withFiles(productPack(), { 'samples/positive/s.json': base.files['samples/positive/titles-good.json'] }), 'samples.unknown_check');
  await refused(withFiles(systemPack(), { 'checks.json': base.files['checks.json'] }), 'manifest.foreign_file');
});

test('a version is short enough to be named: id@version at most 100 characters', async () => {
  // demo-review@ is 12 characters: a version of 88 is the longest a reference can name.
  const longest = `1.0.${'7'.repeat(84)}`;
  assert.equal(`demo-review@${longest}`.length, 100);
  await accepted({ ...base, version: longest });
  const p = await refused({ ...base, version: `1.0.${'7'.repeat(95)}` }, 'manifest.version', { file: 'pack.json', field: '/version' });
  assert.match(p.message, /100/);
  assert.ok(p.message.length < 200, 'the message does not repeat the whole version');
});

test('a catalog@1 check names the catalog a run binds, and a sample carries a catalog only for such a check', async () => {
  const catalogTable = { schema: 'catalog@1', origin: '决定：合成的命令目录检查', item: '/id', catalog: 'commands', commands: ['$.commands'] };
  const withCatalogCheck = (check: Json) =>
    withFiles(
      editJson<Json>(editJson<Json>(base, 'checks.json', (c) => void c.checks.push(check)), 'requirements.json', (r) => void r.requirements[0].checks.push(check.id)),
      { 'tables/commands.json': catalogTable },
    );
  const unbound = withCatalogCheck({ id: 'commands', interpreter: 'catalog@1', table: 'tables/commands.json', applies: 'item', judges: 'artifact_under_verification', tier: 'advisory' });
  const p = await refused(unbound, 'checks.catalog_missing', { file: 'checks.json', field: '/checks/2/catalog' });
  assert.match(p.message, /commands/);
  await accepted(withCatalogCheck({ id: 'commands', interpreter: 'catalog@1', table: 'tables/commands.json', applies: 'item', judges: 'artifact_under_verification', catalog: 'commands@1', tier: 'advisory' }));
  // A sample that brings a catalog to a check that consults none would judge differently from a run.
  const sample = { ...(base.files['samples/positive/titles-good.json'] as Json), id: 'with_catalog', catalog: { root: 'c'.repeat(64), entries: [{ head: 'show widget' }] } };
  await refused(withFiles(base, { 'samples/positive/with-catalog.json': sample }), 'samples.catalog_unused', { file: 'samples/positive/with-catalog.json', field: '/catalog' });
});

test('a table reaches only closed sets the slots declare', async () => {
  const p = await refused(editJson<Json>(base, 'tables/codes.json', (t) => void (t.set = { name: 'finding.codes' })), 'checks.set_unknown', { file: 'tables/codes.json', field: '/set/name' });
  assert.match(p.message, /finding\.codes/);
  assert.match(p.fix, /findings\.codes/);
  await accepted(editJson<Json>(base, 'tables/codes.json', (t) => void (t.set = { name: 'findings.ranks' })));
  await accepted(editJson<Json>(base, 'tables/codes.json', (t) => void (t.set = { values: ['gap', 'typo'] })));
});

test('pack files carrying credentials are refused, naming the file and the line but never the text', async () => {
  const secret = 'Synthetic-Pa55word-For-Test-Only';
  const p = await refused(withFiles(base, { 'SKILL.md': `# 合成规程\n\npassword=${secret}\n` }), 'file.credential', { file: 'SKILL.md' });
  assert.equal(p.line, 3);
  assert.ok(!p.message.includes(secret) && !p.fix.includes(secret));
  await refused(editJson<Json>(base, 'tables/titles.json', (t) => void (t.description = 'Authorization: Bearer abcDEF123ghiJKL456mnoPQR789stuVWX012yz')), 'file.credential', { file: 'tables/titles.json' });
  const titled = await refused({ ...base, title: `合成评审 password=${secret}` }, 'file.credential', { file: 'pack.json', field: '/title' });
  assert.ok(!titled.message.includes(secret));
  await refused(withFiles(productPack(), { 'functions/produce.ts': `const key = 'password=${secret}';\nexport default function produce(): unknown {\n  return key;\n}\n` }), 'file.credential', { file: 'functions/produce.ts' });
});

test('JSON that canonical JSON cannot hold is refused with the field: lone surrogates, numbers out of range, deep nesting', async () => {
  const raw = (text: string) => withFiles(base, { 'tables/titles.json': text });
  await refused(raw('{"schema":"structure@1","origin":"\\ud800"}'), 'file.json', { file: 'tables/titles.json', field: '/origin' });
  await refused(raw('{"schema":"structure@1","origin":"x","n":1e400}'), 'file.json', { field: '/n' });
  await refused(raw(`{"schema":"structure@1","deep":${'['.repeat(300)}${']'.repeat(300)}}`), 'file.json', { file: 'tables/titles.json' });
  await refused(withFiles(base, { 'samples/positive/odd.json': '{"id":"odd","source":"author","check":"titles","subject":{"\\udfff":1},"expect":[{"verdict":"support"}]}' }), 'file.json', { file: 'samples/positive/odd.json', field: '/subject' });
});

test('the static scan refuses a module Node would load as CommonJS, which the sandbox refuses', async () => {
  const header = "import { helper } from './helper.ts';\n";
  const body = 'export default function project(): unknown {\n  return { items: [], warnings: [], helper };\n}\n';
  const p = await refused(projection(header + body, { 'functions/helper.ts': 'globalThis.helperValue = 41;\nconst helper = 1;\n' }), 'functions.module_format', { file: 'functions/helper.ts' });
  assert.match(p.fix, /export \{\}/);
  // Type-only syntax is stripped before Node looks at the format.
  await refused(projection(header + body, { 'functions/helper.ts': 'export type T = string;\nexport interface I { a: T }\n' }), 'functions.module_format', { file: 'functions/helper.ts' });
  await accepted(projection("import './helper.ts';\n" + body.replace(', helper', ''), { 'functions/helper.ts': 'globalThis.helperValue = 41;\nexport {};\n' }));
  await accepted(projection("import './helper.mts';\n" + body.replace(', helper', ''), { 'functions/helper.mts': 'globalThis.helperValue = 41;\n' }));
});

test('a dynamic import of JSON with its attribute is admitted; without it, refused', async () => {
  const fn = (call: string) => `const table = await ${call};\nexport default function project(): unknown {\n  return { items: [], warnings: [], table };\n}\n`;
  await accepted(projection(fn("import('../tables/titles.json', { with: { type: 'json' } })")));
  await accepted(projection(fn("import('../tables/titles.json', { 'with': { 'type': 'json' } })")));
  await refused(projection(fn("import('../tables/titles.json')")), 'functions.import_json', { file: 'functions/project.ts' });
  await refused(projection(fn("import('../tables/titles.json', { assert: { type: 'json' } })")), 'functions.import_json');
});

test('code nested too deep to check is refused as a problem, never thrown', async () => {
  const deep = `export default function project(): unknown {\n  return ${'('.repeat(20000)}1${')'.repeat(20000)};\n}\n`;
  const p = await refused(projection(deep), 'functions.syntax', { file: 'functions/project.ts' });
  assert.match(p.message, /嵌套太深/);
});

test('getBuiltinModule reached any way but a direct call with a literal name is refused like a computed import', async () => {
  const body = 'export default function project(): unknown {\n  return { items: [], warnings: [] };\n}\n';
  for (const line of [
    "const name = 'node:fs';\nconst fs = process.getBuiltinModule(name);\n",
    "const get = process.getBuiltinModule;\n",
    "const { getBuiltinModule } = process;\n",
    "const { getBuiltinModule: g } = globalThis.process;\n",
    "const fs = process['getBuiltinModule'](String('node:fs'));\n",
  ]) {
    const p = await refused(projection(line + body), 'functions.import_computed', { file: 'functions/project.ts' });
    assert.match(p.message, /getBuiltinModule/);
  }
  await refused(projection("const fs = process['getBuiltinModule']('node:fs');\n" + body), 'functions.import_builtin', { file: 'functions/project.ts' });
  await accepted(projection("const crypto = process.getBuiltinModule('node:crypto');\n" + body));
  await accepted(projection("const [getBuiltinModule] = [1];\n" + body));
});

test('every check must declare an explicit tier upon publication: missing tier is refused, declaring tier is accepted', async () => {
  const missingTier = checks((f) => delete f.checks[0].tier);
  const p = await refused(missingTier, 'checks.tier_missing', { file: 'checks.json', field: '/checks/0/tier' });
  assert.match(p.message, /任务包 demo-review 的检查 titles 没有声明 tier/);
  assert.match(p.fix, /声明 blocking、advisory 或模型里的其他档名/);
  const withTier = checks((f) => (f.checks[0].tier = 'blocking'));
  await accepted(withTier);
});

test('check reads max_bytes is validated against core limit of 1 MiB', async () => {
  const exceeded = checks((f) => {
    f.checks[0].reads = { roles: ['expected'], max_bytes: 2 * 1024 * 1024 };
  });
  const p = await refused(exceeded, 'checks.max_bytes_exceeded', { file: 'checks.json', field: '/checks/0/reads/max_bytes' });
  assert.match(p.message, /超过了核心上限/);
  assert.match(p.fix, /不超过 1048576 字节/);

  const withinLimit = checks((f) => {
    f.checks[0].reads = { roles: ['expected'], max_bytes: 512 * 1024 };
  });
  await accepted(withinLimit);

  const defaultLimit = checks((f) => {
    f.checks[0].reads = { roles: ['expected'] };
  });
  await accepted(defaultLimit);

  const withTypes = checks((f) => {
    f.checks[0].reads = { roles: ['expected'], types: ['plm:bugs'] };
  });
  await accepted(withTypes);

  const invalidType = checks((f) => {
    (f.checks[0].reads as any) = { roles: ['expected'], types: ['invalid-no-colon'] };
  });
  await refused(invalidType, 'checks.shape', { file: 'checks.json' });
});

test('publishing checks every local tool while packages without tools retain their validation', async () => {
  await accepted(workflowPack({ version: '10.6.0' }));
  await accepted(withFiles(workflowPack({ version: '10.6.0' }), { 'tools/task.ts': "import { readFile } from 'node:fs/promises'; import '../functions/helper.ts'; void readFile;", 'functions/helper.ts': 'export const helper = 1;' }));
  await refused(withFiles(workflowPack({ version: '10.6.0' }), { 'tools/task.ts': "import 'zod';" }), 'tools.import_package', { file: 'tools/task.ts' });
  await refused(withFiles(workflowPack({ version: '10.6.0' }), { 'tools/task.ts': "import '../../outside.ts';" }), 'tools.import_outside');
  await refused(withFiles(workflowPack({ version: '10.6.0' }), { 'tools/task.mjs': 'module.exports = 1;' }), 'tools.unsupported_syntax');
});

test('core emitter usage follows the configured contribution requirement rather than an installed interpreter',async()=>{
  const code='core.contribution.signature_required';
  const row=(pack:PackDescription,index:number)=>editJson<Json>(pack,'requirements.json',value=>{value.requirements[index].error_handling.push({code,action:'repair',max_rounds:2});});
  const capability=editJson<Json>(base,'workflow.json',value=>{value.contribution={slot:'findings',requirement:'titles'};});
  const used=await accepted(row(capability,0));
  assert.ok(!used.pack.warnings.some(warning=>warning.rule==='requirements.code_unused'));
  const other=await accepted(row(capability,1));assert.ok(other.pack.warnings.some(warning=>warning.rule==='requirements.code_unused'&&warning.message.includes('回注准入')));
  const absent=await accepted(row(base,0));assert.ok(absent.pack.warnings.some(warning=>warning.rule==='requirements.code_unused'&&warning.message.includes('回注准入')));
  const structure=await accepted(requirements(value=>{value.requirements[0].error_handling.push({code:'core.structure.duplicate_key',action:'repair',max_rounds:2});}));
  assert.ok(!structure.pack.warnings.some(warning=>warning.rule==='requirements.code_unused'));
  const catalog=await accepted(requirements(value=>{value.requirements[0].error_handling.push({code:'core.catalog.not_member',action:'repair',max_rounds:2});}));
  assert.ok(catalog.pack.warnings.some(warning=>warning.rule==='requirements.code_unused'&&warning.message.includes('解释器')));
});

function narrowedPack(): PackDescription {
  let pack = editJson<Json>(workflowPack(), 'workflow.json', f => {
    f.inputs.push({ slot: 'lookup', role: 'expected', description: '索引视图', accepts: ['knowledge:index'], required: true, many: false });
  });
  return editJson<Json>(pack, 'checks.json', f => {
    f.checks[0].applies = 'item';
    f.checks[0].reads = { roles: ['expected'], types: ['knowledge:index'], narrow: { slot: 'lookup', key_path: '/keys', into: '/lookup', max_keys: 10, max_entries: 100 } };
  });
}
test('publishes an optional item-key bounded index read', async () => { await accepted(narrowedPack()); });
for (const [name, edit] of [
  ['run', (f: Json) => { f.checks[0].applies = 'run'; }],
  ['slot', (f: Json) => { f.checks[0].reads.narrow.slot = 'absent'; }],
  ['role', (f: Json) => { f.checks[0].reads.roles = ['subject']; }],
  ['type', (f: Json) => { f.checks[0].reads.types = ['toy:document']; }],
] as const) {
  test(`refuses narrowed reads without an exact item/index binding: ${name}`, async () => {
    await refused(editJson<Json>(narrowedPack(), 'checks.json', edit), 'checks.narrow_binding', { file: 'checks.json' });
  });
}

test('reason selectors remain typed causes rather than installed-interpreter codes',async()=>{
  const result=await accepted(requirements(value=>{value.requirements[0].error_handling.unshift({reason:'timeout',action:'repair',max_rounds:2});}));
  assert.ok(!result.pack.warnings.some(warning=>warning.rule==='requirements.code_unused'));
});

test('static fact layers without checks cannot be newly published',async()=>{
  await refused(editJson(workflowPack(),'requirements.json',(json:Json)=>{const requirement=json.requirements.find((r:Json)=>r.accepted_producer==='fact');requirement.checks=[];}),'requirements.shape',{field:'/requirements/0/checks'});
});

test('publication rejects static facts without checks and dynamic facts without an observation',async()=>{
  for(const target of ['item','run']){
    await refused(requirements(file=>{Object.assign(file.requirements[0],{target,layers:['static'],checks:[],error_handling:[]});}), 'requirements.shape',{field:'/requirements/0/checks'});
    await refused(requirements(file=>{Object.assign(file.requirements[0],{target,layers:['dynamic'],checks:[],error_handling:[]});}), 'requirements.shape',{field:'/requirements/0/observation'});
  }
});

test('publication accepts explicitly observed dynamic facts without requiring a static check',async()=>{
  for(const target of ['item','run'])await accepted(requirements(file=>{Object.assign(file.requirements[0],{target,layers:['dynamic'],checks:[],observation:'synthetic.observe@1',error_handling:[]});}));
});

test('publication refuses reject by reason even when an artifact blocking check is installed',async()=>{
  const pack=checks(file=>{file.checks[0].judges='artifact_under_verification';});
  await refused(editJson<Json>(pack,'requirements.json',file=>{file.requirements[0].error_handling=[{reason:'check_error',action:'reject'}];}),'requirements.shape',{field:'/requirements/0/error_handling/0/action'});
});

test('effect policy references use the same declared check and require both sample polarities',async()=>{
 let checkId='';
 let spec=withFiles(checks(file=>{checkId=file.checks[0].id;file.checks[0].table='policies/titles.json';}),{'tables/titles.json':null,'policies/titles.json':base.files['tables/titles.json']});
 spec=editJson<Json>(spec,'requirements.json',file=>{const key=file.requirements[0].key;file.effects=[{id:'send_checked',resource_kind:'executor',action:'submit',effect_class:'job',parameters:{policy:'policies/titles.json',check:checkId},release:{requirements:[key],artifact:key},trigger:'hub_template',budget:{count:1,duration_ms:10000},deadline_ms:86400000,optional:false,policy_checks:[checkId]}];});
 await accepted(spec);
 const removed=Object.fromEntries(Object.keys(spec.files).filter(path=>path.startsWith('samples/negative/')).map(path=>[path,null]));
 await refused(withFiles(spec,removed),'effects.policy_samples');
 await refused(editJson<Json>(spec,'requirements.json',file=>{file.effects[0].parameters.policy='policies/other.json';}),'effects.policy_binding');
});

test('product variable declarations accept a referenced synthetic default and reject invalid contracts', async () => {
  const declared = () => editJson<Json>(productPack(), 'product.json', p => {
    p.variables = [{name:'DEMO_OPTIONS',description:'Synthetic options',schema:{type:'array',items:{type:'string'}},default:[]}];
    p.producers[0].params = {options:'${var:DEMO_OPTIONS}'};
  });
  await accepted(declared());
  for (const edit of [
    (p:Json) => { delete p.variables[0].default; },
    (p:Json) => { p.variables[0].default = 1; },
    (p:Json) => { p.variables[0].schema = {type:'string',pattern:'.*'}; p.variables[0].default='demo'; },
    (p:Json) => { p.variables.push(p.variables[0]); },
    (p:Json) => { p.variables[0].name='DEMO_PASSWORD'; },
    (p:Json) => { delete p.producers[0].params; },
    (p:Json) => { p.title='${var:DEMO_OPTIONS}'; },
    (p:Json) => { p.producers[0].params.options='${var:DEMO_MISSING}'; },
    (p:Json) => { p.producers[0].params.options='${secret:DEMO_OPTIONS}'; },
    (p:Json) => { p.producers[0].params.options='prefix ${var:DEMO_OPTIONS}'; },
  ]) {
    const outcome=await validated(editJson<Json>(declared(),'product.json',edit));
    assert.equal(outcome.ok,false);
  }
  await refused(withFiles(systemPack(),{'SKILL.md':'Use ${var:DEMO_OPTIONS}'}),'variables.reference');
  await refused(withFiles(workflowPack(),{'SKILL.md':'Use ${var:DEMO_OPTIONS}'}),'variables.reference');
});

const variableProduct = () => editJson<Json>(productPack(), 'product.json', p => {
  p.variables=[{name:'DEMO_OPTIONS',description:'Synthetic options',schema:{type:'array',items:{type:'string'}},default:[]}];
  p.producers[0].params={options:'${var:DEMO_OPTIONS}'};
});

test('variable declaration diagnostics explain repeated names in Chinese',async()=>{
 const p=await refused(editJson<Json>(variableProduct(),'product.json',p=>{p.variables.push(p.variables[0]);}),'product.shape');
 assert.match(p.message,/变量名字重复/);
});
test('variable declaration diagnostics explain reference property names in Chinese',async()=>{
 const p=await refused(editJson<Json>(variableProduct(),'product.json',p=>{p.producers[0].params['${var:DEMO_OPTIONS}']='synthetic';}),'product.shape');
 assert.match(p.message,/引用不能作为属性名/);
});
test('variable declaration diagnostics explain allowed reference positions in Chinese',async()=>{
 const p=await refused(editJson<Json>(variableProduct(),'product.json',p=>{p.title='${var:DEMO_OPTIONS}';}),'product.shape');
 assert.match(p.message,/只能在 sync.options 或生产器 params 里引用已声明的普通变量/);
});
test('variable declaration diagnostics explain unused declarations in Chinese',async()=>{
 const p=await refused(editJson<Json>(variableProduct(),'product.json',p=>{delete p.producers[0].params;}),'product.shape');
 assert.match(p.message,/DEMO_OPTIONS.*声明了却没有引用/);
});

test('ledger shapes require a declared runtime table, an installed interpreter and a unique shape', async () => {
  const row = { requirement: 'titles', interpreter: 'structure@1', ruled_in: '10.6.0' };
  const ledger = (rows: unknown[]) => ({ 'ledger.json': JSON.stringify({schema:'ledger@1', shapes:rows}) });
  const enabled = editJson<Json>(base, 'requirements.json', f => {f.requirements[0].run_table = true;});
  await accepted(withFiles(enabled, ledger([row])));
  await refused(withFiles(base, ledger([row])), 'ledger.run_table');
  await refused(withFiles(enabled, ledger([{...row, requirement:'absent'}])), 'ledger.requirement');
  await refused(withFiles(enabled, ledger([{...row, interpreter:'absent@1'}])), 'ledger.interpreter');
  await refused(withFiles(enabled, ledger([row,row])), 'ledger.duplicate');
  await refused(withFiles(enabled, ledger([{...row, from:'src:not-a-record'}])), 'ledger.shape');
  const empty = await accepted(enabled);
  assert.ok(empty.pack.warnings.some(w=>w.rule==='ledger.unruled'));
  assert.deepEqual((await accepted(base)).pack.warnings, []);
});

test('read-only predecessor publication requires every requirement to be independently checked',async()=>{
 await refused(workflow(f=>{f.predecessor_access='view';}),'workflow.predecessor_access',{field:'/predecessor_access'});
});
test('criterion review publication requires an account-verified single requirement and read-only predecessor',async()=>{
 await refused(workflow(f=>{f.criterion_review=true;}),'workflow.criterion_review',{field:'/criterion_review'});
});

test('read-only review publication forbids the declared predecessor result default',async()=>{
 const {readFile}=await import('node:fs/promises'),root=new URL('../../../packs/workflow/criterion-review/',import.meta.url);
 const manifest=JSON.parse(await readFile(new URL('pack.json',root),'utf8')),files:PackDescription['files']={};for(const file of manifest.files)files[file.path]=await readFile(new URL(file.path,root));
 const review:PackDescription={...manifest,files};await accepted(review);
 const defaulted=editJson<Json>(review,'workflow.json',file=>{file.inputs[0].default_from_predecessor={pack:'synthetic-author'};});
 await refused(defaulted,'workflow.predecessor_default',{file:'workflow.json',field:'/inputs'});
});

test('V07: a frozen round count above one needs an effect row that authorizes it', async () => {
  const dynamic = (repetition: unknown) => requirements((file) => {
    Object.assign(file.requirements[0], { layers: ['dynamic'], checks: [], observation: 'synthetic.observe@1', error_handling: [] });
    if (repetition !== undefined) file.requirements[0].repetition = repetition;
  });
  // One round needs no authorization: the class default of a pack without a work class, or a written count of one.
  await accepted(dynamic(undefined));
  await accepted(dynamic({ count: 1, aggregation: 'all' }));
  // More rounds than any effect row authorizes is a deterministic refusal, naming the row and the two ways out.
  await refused(dynamic({ count: 3, aggregation: 'all' }), 'effects.repetition_budget', { field: '/requirements/0/repetition/count' });
  await refused(dynamic({ count: 3, aggregation: 'k_of_n', k: 2 }), 'effects.repetition_budget');
  // The shape rules: a static requirement does not repeat, k belongs to k-of-n alone, and the count is 1 to 10.
  await refused(requirements((file) => { file.requirements[0].repetition = { count: 3, aggregation: 'all' }; }), 'requirements.shape');
  await refused(dynamic({ count: 3, aggregation: 'all', k: 2 }), 'requirements.shape');
  await refused(dynamic({ count: 3, aggregation: 'k_of_n' }), 'requirements.shape');
  await refused(dynamic({ count: 11, aggregation: 'all' }), 'requirements.shape');
});
