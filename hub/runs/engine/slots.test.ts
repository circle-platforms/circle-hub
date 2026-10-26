import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { ItemProjection } from '../../../contracts/src/run.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import { findSubschema, packSchema, renderExpected, renderShape, requirementAt, schemaProblems, slotProblems, slotSchemaOf, specificFix, unsafeSchema } from './slots.ts';
import { locatePack, reviewPack, writePack } from './testing/packs.ts';
import { FakeWorkflowStore } from './testing/workflows.ts';

let dir: string;
let review: LoadedWorkflow;
let locate: LoadedWorkflow;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'circle-hub-slots-'));
  const store = new FakeWorkflowStore();
  review = await store.add(await writePack(dir, reviewPack()));
  locate = await store.add(await writePack(dir, locatePack()));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SHA = 'b'.repeat(64);
const REUSE = `rec:${'c'.repeat(64)}#/partitions/delivered/0`;
const items: ItemProjection[] = [
  { id: 'd:1', label: '一', location: `src:${SHA}/kityminder@1/n/1`, fields: {}, digest: SHA, reuse: REUSE },
  { id: 'd:2', label: '二', location: `src:${SHA}/kityminder@1/n/2`, fields: {} },
];
const finding = (extra: Record<string, unknown> = {}) => ({ text: '缺边界用例', code: 'edge_case_gap', rank: 'major', quotes: [{ reference: `src:${SHA}/kityminder@1/n/1`, text: '一' }], ...extra });
const level = { nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' };

function submission(value: Record<string, unknown>): Submission {
  return Submission.parse({ run: 'run_01m5h9zh07x7amhg4bwmye5yhw', model: 'm', cross_item: [level], ...value });
}

function problems(value: Record<string, unknown>): ProtocolError[] {
  return slotProblems(review, items, submission(value));
}

test('an item id the run does not have gets a fix that teaches the form (count, exact id example, suffix hint)', () => {
  // A plain wrong id (no item id ends with it): the message names the count, where the exact ids sit, the first id.
  const wrong = problems({ items: [{ item: 'zz', handling: 'handled', slots: { findings: [finding()] } }] });
  assert.equal(wrong.length, 1);
  assert.match(wrong[0]!.message, /本运行有 2 个条目/);
  assert.match(wrong[0]!.message, /编号照 start_run 回执里条目清单第一列原样写/);
  assert.match(wrong[0]!.message, /例如 d:1/);
  assert.doesNotMatch(wrong[0]!.message, /是不是指/);
  // An id that is exactly the tail of a real one (only the part after the colon): the hint names that id.
  const tail = problems({ items: [{ item: '2', handling: 'handled', slots: { findings: [finding()] } }] });
  assert.match(tail[0]!.message, /是不是指 d:2/);
  // An id that is no item id's tail: no hint.
  const other = problems({ items: [{ item: 'x9', handling: 'handled', slots: { findings: [finding()] } }] });
  assert.doesNotMatch(other[0]!.message, /是不是指/);
});

test('the slot schema is JSON Schema 2020-12 of one item slot record with the closed sets, counts and data schema', () => {
  const slots = slotSchemaOf(review);
  assert.ok(slots);
  assert.equal(slots.sha256, review.manifest.files.find((f) => f.path === 'slots.schema.json')?.sha256);
  const schema = slots.schema as Record<string, any>;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema.required, ['findings']);
  assert.equal(schema.additionalProperties, false);
  const findings = schema.properties.findings;
  assert.equal(findings.minItems, 0);
  assert.equal(findings.maxItems, 10);
  assert.deepEqual(findings.items.properties.code.enum, ['literal_issue', 'coverage_gap', 'differentiation_gap', 'edge_case_gap', 'negative_gap', 'block_structure_mismatch', 'self_contradiction']);
  assert.deepEqual(findings.items.properties.rank.enum, ['critical', 'major', 'minor']);
  assert.deepEqual(findings.items.required.sort(), ['code', 'rank', 'text']);
  assert.deepEqual(findings.items.properties.data.properties, { suggestion: { type: 'string' } });
  assert.deepEqual(schema.$defs.cross_item_level.properties.code.enum, ['draft_level']);
  assert.equal(schema.$defs.cross_item_level.properties.rank.enum.length, 8);
  // the published schema accepts a valid record and refuses codes, ranks and keys outside it
  const validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  assert.ok(validator.safeParse({ findings: [finding()] }).success);
  assert.ok(validator.safeParse({ findings: [] }).success);
  assert.ok(!validator.safeParse({ findings: [finding({ code: 'made_up' })] }).success);
  assert.ok(!validator.safeParse({ findings: [finding({ rank: 'P9' })] }).success);
  assert.ok(!validator.safeParse({ findings: [], other: [] }).success);
  assert.ok(!validator.safeParse({}).success);
  assert.equal(slotSchemaOf(locate), undefined);
});

test('a valid submission has no structure problems', () => {
  assert.deepEqual(problems({ items: [{ item: 'd:1', handling: 'handled', slots: { findings: [finding()] } }, { item: 'd:2', handling: 'skipped', reason: '不需要' }] }), []);
  assert.deepEqual(problems({ items: [{ item: 'd:1', handling: 'handled', reuse: REUSE }] }), []);
});

test('items and slot keys: unknown items, unknown keys, fact requirement keys, run-level keys, missing keys, lists', () => {
  const at = (value: Record<string, unknown>) => problems(value).map((p) => p.path);
  assert.deepEqual(at({ items: [{ item: 'd:9', handling: 'handled', slots: { findings: [] } }] }), ['/items/0/item']);
  assert.deepEqual(at({ items: [{ item: 'd:1', handling: 'handled', slots: { findings: [], extra: [] } }] }), ['/items/0/slots/extra']);
  const fact = problems({ items: [{ item: 'd:1', handling: 'handled', slots: { findings: [], catalog: [] } }] });
  assert.match(fact[0].message, /事实，由 Hub 计算/);
  const run = problems({ items: [{ item: 'd:1', handling: 'handled', slots: { findings: [], level: [] } }] });
  assert.match(run[0].message, /cross_item/);
  assert.deepEqual(at({ items: [{ item: 'd:1', handling: 'handled', slots: {} }] }), ['/items/0/slots']);
  assert.deepEqual(at({ items: [{ item: 'd:1', handling: 'handled', slots: { findings: {} } }] }), ['/items/0/slots/findings']);
  assert.deepEqual(at({ items: [{ item: 'd:1', handling: 'handled' }] }), ['/items/0']);
});

test('statements: closed codes and ranks, required when declared, counts, data schema, evidence, the SlotClaim shape', () => {
  const at = (f: Record<string, unknown>[]) => problems({ items: [{ item: 'd:1', handling: 'handled', slots: { findings: f } }] }).map((p) => p.path);
  assert.deepEqual(at([finding({ code: 'made_up' })]), ['/items/0/slots/findings/0/code']);
  assert.deepEqual(at([finding({ code: undefined })]), ['/items/0/slots/findings/0/code']);
  assert.deepEqual(at([finding({ rank: 'P1' })]), ['/items/0/slots/findings/0/rank']);
  assert.deepEqual(at([finding({ rank: undefined })]), ['/items/0/slots/findings/0/rank']);
  assert.deepEqual(at(Array.from({ length: 11 }, () => finding())), ['/items/0/slots/findings']);
  assert.deepEqual(at([finding({ data: { suggestion: 3 } })]), ['/items/0/slots/findings/0/data/suggestion']);
  assert.deepEqual(at([finding({ data: { other: 'x' } })]), ['/items/0/slots/findings/0/data/other']);
  assert.deepEqual(at([finding({ quotes: undefined })]), ['/items/0/slots/findings/0']);
  assert.deepEqual(at([finding({ unknown_field: 1 })]), ['/items/0/slots/findings/0/unknown_field']);
  assert.deepEqual(at([finding({ text: '' })]), ['/items/0/slots/findings/0/text']);
  const cmdIssue = problems({
    items: [{ item: 'd:1', handling: 'handled', slots: { findings: [{ ...finding(), commands: ['zone set'] }] } }],
  });
  assert.equal(cmdIssue[0].code, 'SUBMISSION_SCHEMA_VIOLATION');
  assert.equal(cmdIssue[0].path, '/items/0/slots/findings/0/commands/0');
  assert.equal(
    cmdIssue[0].fix,
    '/items/0/slots/findings/0/commands/0 要的是对象 {"command": "<string>", "present"?: <boolean>}，收到的是字符串',
  );
  const all = problems({ items: [{ item: 'd:1', handling: 'handled', slots: { findings: [finding({ code: 'made_up' })] } }] });
  assert.ok(all.every((p) => (p as { code?: string }).code === 'SUBMISSION_SCHEMA_VIOLATION'));
});

test('a carry-over must be the one start_run offered', () => {
  const other = `rec:${'d'.repeat(64)}#/partitions/delivered/0`;
  assert.deepEqual(problems({ items: [{ item: 'd:1', handling: 'handled', reuse: other }] }).map((p) => p.path), ['/items/0/reuse']);
  assert.deepEqual(problems({ items: [{ item: 'd:2', handling: 'handled', reuse: REUSE }] }).map((p) => p.path), ['/items/0/reuse']);
});

test('cross-item entries: code names the run-level requirement, rank in its set, counts; free entries carry no rank', () => {
  const at = (cross: unknown[]) => slotProblems(review, items, submission({ items: [], cross_item: cross })).map((p) => p.path);
  assert.deepEqual(at([level]), []);
  assert.deepEqual(at([level, { nature: 'fact', statement: '三个用例共用前置条件', grounds: [`src:${SHA}`] }]), []);
  assert.deepEqual(at([{ ...level, code: 'made_up' }]), ['/cross_item/0/code', '/cross_item']);
  assert.deepEqual(at([{ ...level, rank: 'major' }]), ['/cross_item/0/rank']);
  assert.deepEqual(at([{ ...level, rank: undefined }]), ['/cross_item/0/rank']);
  assert.deepEqual(at([]), ['/cross_item']);
  assert.deepEqual(at([level, level]), ['/cross_item']);
  assert.deepEqual(at([level, { nature: 'judgment', statement: '自由评论', grounds: [], rank: 'P1' }]), ['/cross_item/1/rank']);
});

test('the requirement of a pointer into the submission', () => {
  const s = submission({ items: [] });
  assert.equal(requirementAt(review, s, '/items/3/slots/findings/0/quotes/1'), 'findings');
  assert.equal(requirementAt(review, s, '/cross_item/0/grounds/0'), 'level');
  assert.equal(requirementAt(review, s, '/items/0'), null);
  assert.equal(requirementAt(review, s, undefined), null);
});

test('pack JSON Schemas: regular expression keywords refused wherever a subschema sits; names are names; unreadable schemas fail closed', () => {
  assert.equal(unsafeSchema({ type: 'object', properties: { pattern: { type: 'string' }, patternProperties: { type: 'number' } } }), null);
  for (const [schema, where] of [
    [{ type: 'string', pattern: '^(a+)+$' }, '/pattern'],
    [{ type: 'object', patternProperties: { '^x': {} } }, '/patternProperties'],
    [{ type: 'array', items: { type: 'string', pattern: 'a' } }, '/items/pattern'],
    [{ anyOf: [{ type: 'number' }, { type: 'string', pattern: 'a' }] }, '/anyOf/1/pattern'],
    [{ $defs: { s: { pattern: 'a' } } }, '/$defs/s/pattern'],
    [{ type: 'object', propertyNames: { pattern: '^[a-z]+$' } }, '/propertyNames/pattern'],
    [{ type: 'array', items: [{ type: 'string', pattern: 'a' }] }, '/items/0/pattern'],
  ] as const) {
    assert.match(unsafeSchema(schema) ?? '', new RegExp(`^${where.replaceAll('$', '\\$')} `), JSON.stringify(schema));
  }
  let deep: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 40; i++) deep = { type: 'array', items: deep };
  assert.match(unsafeSchema(deep) ?? '', /嵌套超过 32 层/);
  assert.match(unsafeSchema({ properties: { a: 3 } }) ?? '', /不是 JSON Schema/);
  // compiled once, fail closed when zod cannot read it
  const fine = packSchema({ type: 'object', properties: { suggestion: { type: 'string' } }, additionalProperties: false });
  assert.ok(fine.ok && fine.schema.safeParse({ suggestion: 'x' }).success && !fine.schema.safeParse({ other: 1 }).success);
  const unread = packSchema({ type: 'object', unevaluatedProperties: false });
  assert.equal(unread.ok, false);
  assert.deepEqual(schemaProblems(review), []);
});

test('a statement whose data the pack schema cannot check is a structure violation (fail closed backstop)', async () => {
  const store = new FakeWorkflowStore();
  const odd = await store.add(await writePack(dir, reviewPack({ version: '3.0.0', findingsData: { type: 'object', unevaluatedProperties: false } })));
  assert.equal(schemaProblems(odd).length, 1);
  const submission = Submission.parse({ run: 'run_01m5h9zh07x7amhg4bwmye5yhw', model: 'm', items: [{ item: 'd:2', handling: 'handled', slots: { findings: [finding({ data: { suggestion: 'x' } })] } }], cross_item: [level] });
  const problems = slotProblems(odd, items, submission);
  assert.deepEqual(problems.map((p) => [p.code, p.path, p.fix]), [['SUBMISSION_SCHEMA_VIOLATION', '/items/0/slots/findings/0/data', '请联系任务包作者']]);
});

test('specificFix renders expected shape dynamically from synthetic slot schema and real commands schema', () => {
  // Synthetic slot schema with arbitrary custom field names
  const syntheticSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      custom_slot: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            custom_entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  widget_name: { type: 'string' },
                  is_enabled: { type: 'boolean' },
                },
                required: ['widget_name'],
              },
            },
          },
        },
      },
    },
  };

  // 1. Synthetic schema: object element of array
  const objIssue = {
    code: 'invalid_type',
    expected: 'object',
    path: ['custom_entries', 0],
    message: 'Invalid input: expected object, received string',
  } as unknown as z.ZodIssue;
  const objFix = specificFix('/items/0/slots/custom_slot/0/custom_entries/0', objIssue, syntheticSchema);
  assert.deepEqual(objFix, {
    message: '/items/0/slots/custom_slot/0/custom_entries/0 要的是对象 {"widget_name": "<string>", "is_enabled"?: <boolean>}，收到的是字符串',
    fix: '/items/0/slots/custom_slot/0/custom_entries/0 要的是对象 {"widget_name": "<string>", "is_enabled"?: <boolean>}，收到的是字符串',
  });

  // 2. Synthetic schema: array itself
  const arrIssue = {
    code: 'invalid_type',
    expected: 'array',
    path: ['custom_entries'],
    message: 'Invalid input: expected array, received string',
  } as unknown as z.ZodIssue;
  const arrFix = specificFix('/items/0/slots/custom_slot/0/custom_entries', arrIssue, syntheticSchema);
  assert.deepEqual(arrFix, {
    message: '/items/0/slots/custom_slot/0/custom_entries 要的是数组 [{"widget_name": "<string>", "is_enabled"?: <boolean>}]，收到的是字符串',
    fix: '/items/0/slots/custom_slot/0/custom_entries 要的是数组 [{"widget_name": "<string>", "is_enabled"?: <boolean>}]，收到的是字符串',
  });

  // 3. Real shape of commands
  const realCommandsSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      cases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            commands: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  command: { type: 'string' },
                  present: { type: 'boolean' },
                },
                required: ['command'],
              },
            },
          },
        },
      },
    },
  };

  const cmdIssue = {
    code: 'invalid_type',
    expected: 'object',
    path: ['commands', 0],
    message: 'Invalid input: expected object, received string',
  } as unknown as z.ZodIssue;
  const cmdFix = specificFix('/items/0/slots/cases/0/commands/0', cmdIssue, realCommandsSchema);
  assert.deepEqual(cmdFix, {
    message: '/items/0/slots/cases/0/commands/0 要的是对象 {"command": "<string>", "present"?: <boolean>}，收到的是字符串',
    fix: '/items/0/slots/cases/0/commands/0 要的是对象 {"command": "<string>", "present"?: <boolean>}，收到的是字符串',
  });

  // 4. Fallback when path cannot be reached in schema
  const fallbackIssue = {
    code: 'invalid_type',
    expected: 'number',
    path: ['unknown_path'],
    message: 'Invalid input: expected number, received string',
  } as unknown as z.ZodIssue;
  const fallbackFix = specificFix('/items/0/slots/unknown_path', fallbackIssue, realCommandsSchema);
  assert.deepEqual(fallbackFix, {
    message: '/items/0/slots/unknown_path 要的是数字，收到的是字符串',
    fix: '/items/0/slots/unknown_path 要的是数字，收到的是字符串',
  });
});
