import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChecksFile,
  ExpectedSourcesOutput,
  PackManifest,
  PackSample,
  ProjectionInput,
  ProjectionOutput,
  REQUIRED_FILES,
  RequirementsFile,
  SlotClaim,
  SlotsFile,
  WorkflowFile,
  packPathProblem,
  schemas,
} from './pack.ts';

const sha = 'a'.repeat(64);
const file = (path: string) => ({ path, sha256: sha, size: 10 });

const manifest = {
  schema: 'pack@1',
  id: 'sample-review',
  version: '1.0.0',
  kind: 'workflow',
  title: 'Sample review',
  description: 'An invented workflow pack',
  files: ['SKILL.md', 'checks.json', 'functions/project.ts', 'requirements.json', 'slots.schema.json', 'tables/structure.json', 'workflow.json'].map(file),
};

const requirements = {
  schema: 'requirements@1',
  requirements: [
    { key: 'structure', name: 'Structure', description: 'Case structure', target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['structure'], error_handling: [{ code: '*', action: 'reject' }] },
    {
      key: 'catalog', name: 'Catalog', description: 'Commands exist', target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['catalog'],
      expected: { overrides: [{ when: { pointer: '/negative', equals: true }, outcome: 'refute', codes: ['core.catalog.param_out_of_range'] }] },
      error_handling: [{ code: 'core.catalog.not_member', action: 'repair', max_rounds: 2 }, { code: '*', action: 'unknown' }],
    },
    { key: 'findings', name: 'Findings', description: 'Judged findings', target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'independent_judgment', independent_of: 'predecessor', checks: [], error_handling: [] },
    { key: 'level', name: 'Level', description: 'Whole target', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'judgment', checks: [], error_handling: [] },
  ],
};

test('a manifest parses and names what is wrong with a bad one', () => {
  assert.ok(PackManifest.safeParse(manifest).success);
  const missing = PackManifest.safeParse({ ...manifest, files: manifest.files.filter((f) => f.path !== 'SKILL.md') });
  assert.ok(!missing.success && missing.error.issues.some((i) => /contains SKILL\.md/.test(i.message)));
  const unsorted = PackManifest.safeParse({ ...manifest, files: [...manifest.files].reverse() });
  assert.ok(!unsorted.success && unsorted.error.issues.some((i) => /sorted/.test(i.message)));
  const dup = PackManifest.safeParse({ ...manifest, files: [...manifest.files, file('Checks.json')].sort((a, b) => (a.path < b.path ? -1 : 1)) });
  assert.ok(!dup.success && dup.error.issues.some((i) => /twice/.test(i.message)));
  assert.ok(!PackManifest.safeParse({ ...manifest, files: [...manifest.files, file('pack.json')] }).success, 'pack.json is not in its own manifest');
  assert.ok(!PackManifest.safeParse({ ...manifest, owner: 'x' }).success, 'unknown keys are refused');
});

test('every pack kind has required files that are legal pack paths', () => {
  for (const [kind, files] of Object.entries(REQUIRED_FILES)) {
    for (const f of files) assert.equal(packPathProblem(f), null, `${kind}: ${f}`);
  }
});

test('pack paths stay inside the places packs keep files', () => {
  for (const ok of ['pack.json', 'SKILL.md', 'functions/a.ts', 'functions/sub/b.ts', 'tables/structure.json', 'samples/positive/one.json', 'policies/x.json', 'product.json', 'system.json']) {
    assert.equal(packPathProblem(ok), null, ok);
  }
  for (const bad of ['', '/etc/passwd', '../x', 'functions/../x.ts', 'functions//a.ts', 'functions/.hidden', 'functions', 'node_modules/x.js', 'other.json', 'functions/a b.ts', 'functions/ü.ts', 'functions/a.ts/', 'x'.repeat(201)]) {
    assert.notEqual(packPathProblem(bad), null, JSON.stringify(bad));
  }
});

test('requirements: valid file, and the rules of W02', () => {
  assert.ok(RequirementsFile.safeParse(requirements).success);
  const dupKey = { ...requirements, requirements: [requirements.requirements[0], requirements.requirements[0]] };
  assert.ok(!RequirementsFile.safeParse(dupKey).success);
  const noOf = structuredClone(requirements);
  delete (noOf.requirements[2] as { independent_of?: string }).independent_of;
  assert.ok(!RequirementsFile.safeParse(noOf).success, 'an independent judgment names what it is independent of');
  const wrongOf = structuredClone(requirements);
  (wrongOf.requirements[0] as { independent_of?: string }).independent_of = 'predecessor';
  assert.ok(!RequirementsFile.safeParse(wrongOf).success, 'a fact is not independent of anything');
  const repairNoRounds = structuredClone(requirements);
  repairNoRounds.requirements[1].error_handling = [{ code: 'x', action: 'repair' } as never];
  assert.ok(!RequirementsFile.safeParse(repairNoRounds).success);
  const roundsOnReject = structuredClone(requirements);
  roundsOnReject.requirements[0].error_handling = [{ code: '*', action: 'reject', max_rounds: 2 } as never];
  assert.ok(!RequirementsFile.safeParse(roundsOnReject).success);
  const twice = structuredClone(requirements);
  twice.requirements[1].error_handling = [{ code: 'a', action: 'unknown' }, { code: 'a', action: 'reject' }];
  assert.ok(!RequirementsFile.safeParse(twice).success);
  const badLayer = structuredClone(requirements);
  (badLayer.requirements[0] as { layers: string[] }).layers = ['static', 'sideways'];
  assert.ok(!RequirementsFile.safeParse(badLayer).success, 'layers come from the vocabulary');
});

test('checks: a check names an interpreter with a table, or a function, never both', () => {
  const checks = {
    schema: 'checks@1',
    checks: [
      { id: 'structure', interpreter: 'structure@1', table: 'tables/structure.json', applies: 'run', judges: 'subject', tier: 'blocking', basis: 'clause 3' },
      { id: 'catalog', interpreter: 'catalog@1', table: 'tables/catalog.json', applies: 'item', catalog: 'commands@1', subject: { module: 'functions/subject.ts', export: 'catalogSubject' }, judges: 'subject' },
      { id: 'consistent', function: { module: 'functions/consistent.ts' }, applies: 'item', judges: 'artifact_under_verification' },
    ],
  };
  assert.ok(ChecksFile.safeParse(checks).success);
  assert.ok(!ChecksFile.safeParse({ ...checks, checks: [{ ...checks.checks[0], function: { module: 'functions/x.ts' } }] }).success, 'both');
  assert.ok(!ChecksFile.safeParse({ ...checks, checks: [{ id: 'x', applies: 'run', judges: 'subject' }] }).success, 'neither');
  assert.ok(!ChecksFile.safeParse({ ...checks, checks: [{ id: 'x', interpreter: 'structure@1', applies: 'run', judges: 'subject' }] }).success, 'an interpreter needs its table');
  assert.ok(!ChecksFile.safeParse({ ...checks, checks: [checks.checks[0], checks.checks[0]] }).success, 'duplicate ids');
  assert.ok(!ChecksFile.safeParse({ ...checks, checks: [{ ...checks.checks[0], table: '../tables/x.json' }] }).success, 'table paths are pack paths');
  assert.ok(!ChecksFile.safeParse({ ...checks, checks: [{ ...checks.checks[0], judges: 'everything' }] }).success, 'roles come from the vocabulary');
});

test('slots: closed sets, run-level requirements are identified by their codes', () => {
  const slots = {
    schema: 'slots@1',
    item: { findings: { codes: [{ code: 'literal_issue', label: '字面问题' }, { code: 'coverage_gap', label: '覆盖缺口' }], ranks: [{ code: 'critical', label: '严重' }, { code: 'major', label: '一般' }, { code: 'minor', label: '轻微' }], min: 0, evidence: true } },
    run: { level: { codes: [{ code: 'level', label: '等级' }], ranks: ['P0', 'P1', 'P2'].map((c) => ({ code: c, label: c })), min: 1, max: 1 } },
  };
  assert.ok(SlotsFile.safeParse(slots).success);
  assert.ok(!SlotsFile.safeParse({ ...slots, run: { level: { ranks: slots.run.level.ranks } } }).success, 'a run-level requirement needs codes');
  const shared = { ...slots, run: { level: slots.run.level, verdict: { codes: [{ code: 'level', label: 'x' }] } } };
  assert.ok(!SlotsFile.safeParse(shared).success, 'one code identifies one requirement');
  assert.ok(!SlotsFile.safeParse({ ...slots, item: { findings: { codes: [{ code: 'a', label: 'a' }, { code: 'a', label: 'b' }] } } }).success, 'a code is listed once');
  assert.ok(!SlotsFile.safeParse({ ...slots, item: { Findings: {} } }).success, 'requirement keys are lowercase');
});

test('a slot claim carries quotations and commands as data the Hub resolves', () => {
  const ref = `src:${sha}/kityminder@1/n/abc`;
  assert.ok(SlotClaim.safeParse({ text: '期望不可验证', code: 'coverage_gap', rank: 'major', location: ref, quotes: [{ reference: ref, text: '设备正常' }], commands: [{ command: 'show version', present: true }], data: { note: 1 } }).success);
  assert.ok(!SlotClaim.safeParse({ text: '' }).success);
  assert.ok(!SlotClaim.safeParse({ text: 'x', quotes: [{ reference: 'not a reference', text: 'y' }] }).success);
  assert.ok(!SlotClaim.safeParse({ text: 'x', surprise: true }).success);
});

test('workflow: the subject names an input slot; slots and parameters are unique', () => {
  const workflow = {
    schema: 'workflow@1',
    inputs: [{ slot: 'subject', role: 'subject', description: 'The mind map', accepts: ['agile:mindmap', 'application/json'], required: true, many: false }],
    parameters: [{ name: 'defect', description: 'Defect id', required: false }],
    product: { catalogs: ['commands@1'] },
    subject: 'subject',
    projection: { module: 'functions/project.ts' },
    expected_sources: { module: 'functions/expected.ts' },
  };
  assert.ok(WorkflowFile.safeParse(workflow).success);
  assert.ok(!WorkflowFile.safeParse({ ...workflow, subject: 'other' }).success);
  assert.ok(!WorkflowFile.safeParse({ ...workflow, inputs: [workflow.inputs[0], workflow.inputs[0]] }).success);
  assert.ok(!WorkflowFile.safeParse({ ...workflow, parameters: [workflow.parameters[0], workflow.parameters[0]] }).success);
  assert.ok(!WorkflowFile.safeParse({ ...workflow, projection: { module: '../project.ts' } }).success);
});

test('projection and expected-source functions exchange parsed models and external ids', () => {
  const context = { product: 'widget', names: ['Widget', 'Gadget'], line: '1.2', build: 'Rel_1_2_3', root: sha, parameters: {}, groups: [] };
  const input = { inputs: [{ slot: 'subject', external: 'agile:mindmap:90001', sha256: sha, media_type: 'application/json', parser: 'kityminder@1', model: { root: {} }, meta: { title: 't', ancestors: ['a', 'b'] } }], parameters: {}, context };
  assert.ok(ProjectionInput.safeParse(input).success);
  const item = { id: '1:a', label: 'case', location: { parser: 'kityminder@1', selector: 'n/a' }, fields: { title: 'x' } };
  assert.ok(ProjectionOutput.safeParse({ items: [item], warnings: [] }).success);
  assert.ok(ProjectionOutput.safeParse({ error: { code: 'pack.no_case', message: 'm', fix: 'f' }, warnings: [] }).success);
  assert.ok(!ProjectionOutput.safeParse({ items: [{ ...item, location: 'src:abc' }], warnings: [] }).success, 'the pack gives parser and selector, the Hub forms the reference');
  assert.ok(ExpectedSourcesOutput.safeParse({ sources: [{ external: 'plm:story:33001', role: 'expected', reason: '标题里的需求号' }], warnings: [] }).success);
  assert.ok(!ExpectedSourcesOutput.safeParse({ sources: [{ external: 'plm:story:1', role: 'subject', reason: 'x' }], warnings: [] }).success, 'only expected or hint sources are bound this way');
});

test('samples carry their source and what the check must say', () => {
  const sample = { id: 'good_case', source: 'author', check: 'structure', subject: { items: [] }, expect: [{ verdict: 'support' }] };
  assert.ok(PackSample.safeParse(sample).success);
  assert.ok(!PackSample.safeParse({ ...sample, source: 'someone' }).success);
  assert.ok(!PackSample.safeParse({ ...sample, expect: [{ verdict: 'maybe' }] }).success);
});

test('every registered schema key is name@major', () => {
  for (const key of Object.keys(schemas)) assert.match(key, /^[a-z][a-z0-9_-]*@(?:0|[1-9][0-9]*)$/);
});
