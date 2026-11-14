import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GetNodesInput,
  ListTaskPacksInput,
  ResolveReferenceInput,
  StartRunInput,
  SubmitResultInput,
  UploadFileInput,
} from '../../contracts/src/tools.ts';
import { PUBLISHED } from './tools.ts';
import {
  buildEscalation,
  checkedExampleFromInputSchema,
  checkedPackDeclaredExample,
  countsTowardEscalation,
  escalateProtocolErrors,
  escalationTier,
  isPackScopedCode,
  occurrenceOf,
  withEscalatedFix,
} from './refusal-escalate.ts';

const TOOL_INPUTS = {
  list_task_packs: ListTaskPacksInput,
  upload_file: UploadFileInput,
  start_run: StartRunInput,
  get_nodes: GetNodesInput,
  resolve_reference: ResolveReferenceInput,
  submit_result: SubmitResultInput,
} as const;

test('SOURCE_UNAVAILABLE, internal and cancel codes do not escalate', () => {
  assert.equal(countsTowardEscalation('SOURCE_UNAVAILABLE'), false);
  assert.equal(countsTowardEscalation('INTERNAL_ERROR'), false);
  assert.equal(countsTowardEscalation('CANCELLED'), false);
  assert.equal(countsTowardEscalation('REQUEST_CANCELLED'), false);
  assert.equal(countsTowardEscalation(null), false);
  assert.equal(countsTowardEscalation('SUBMISSION_SCHEMA_VIOLATION'), true);
  assert.equal(countsTowardEscalation('SOURCE_NOT_PERMITTED'), true);
});

test('tiers: 1 keeps disclosure, 2 adds example slot, 3+ adds alternative path', () => {
  assert.equal(escalationTier(1), 1);
  assert.equal(escalationTier(2), 2);
  assert.equal(escalationTier(3), 3);
  assert.equal(escalationTier(9), 3);
  const first = buildEscalation({ occurrence: 1, exampleJson: '{"pack":"a","inputs":{}}' });
  assert.equal(first.fixSuffix, null);
  assert.equal(first.exampleJson, null);
  const second = buildEscalation({ occurrence: 2, exampleJson: '{"pack":"a","inputs":{}}' });
  assert.equal(second.tier, 2);
  assert.match(second.countLabel, /最近一小时内第 2 次/);
  assert.ok(second.fixSuffix?.includes(second.countLabel));
  assert.ok(second.fixSuffix?.includes('完整正确示例：'));
  assert.ok(second.fixSuffix?.includes(second.exampleJson!));
  assert.equal(second.alternative, null);
  const third = buildEscalation({ occurrence: 3, exampleJson: '{"pack":"a","inputs":{}}' });
  assert.equal(third.tier, 3);
  assert.match(third.countLabel, /最近一小时内第 3 次/);
  assert.ok(third.alternative?.includes('替代路径'));
  assert.ok(third.alternative?.includes('换写法'));
  assert.ok(third.alternative?.includes('找谁'));
  assert.ok(third.alternative?.includes('收尾'));
  assert.ok(third.fixSuffix?.includes(third.countLabel));
  assert.ok(third.fixSuffix?.includes('替代路径'));
});

test('every emitted tool schema example passes that tool input safeParse', () => {
  for (const [name, input] of Object.entries(TOOL_INPUTS)) {
    const published = PUBLISHED.get(name);
    assert.ok(published, name);
    const json = checkedExampleFromInputSchema(published.inputSchema, input);
    assert.ok(json !== null, `${name} must yield a schema-checked example`);
    const parsed = JSON.parse(json!);
    assert.equal(input.safeParse(parsed).success, true, name);
  }
});

test('pack-scoped codes accept only pack-declared examples that pass the tool input', () => {
  assert.equal(isPackScopedCode('case-review.reuse'), true);
  assert.equal(isPackScopedCode('SUBMISSION_SCHEMA_VIOLATION'), false);
  const ok = { pack: 'case-review', inputs: {} };
  assert.equal(checkedPackDeclaredExample(ok, StartRunInput), JSON.stringify(ok));
  assert.equal(checkedPackDeclaredExample({ pack: 1 }, StartRunInput), null);
  assert.equal(checkedPackDeclaredExample(undefined, StartRunInput), null);
});

test('occurrence is prior call_logs count + 1 and never uses process memory', async () => {
  const seen: unknown[] = [];
  const callLog = {
    countRecentErrors: async (query: unknown) => {
      seen.push(query);
      return 2;
    },
  };
  assert.equal(
    await occurrenceOf({
      callLog,
      userId: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a',
      tool: 'start_run',
      errorCode: 'SUBMISSION_SCHEMA_VIOLATION',
      now: new Date('2026-11-14T03:00:00.000Z'),
    }),
    3,
  );
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    userId: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a',
    tool: 'start_run',
    errorCode: 'SUBMISSION_SCHEMA_VIOLATION',
    since: '2026-11-14T02:00:00.000Z',
  });
  assert.equal(
    await occurrenceOf({
      callLog,
      userId: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a',
      tool: 'start_run',
      errorCode: 'SOURCE_UNAVAILABLE',
    }),
    null,
  );
});

test('escalateProtocolErrors syncs fix for the 1st / 2nd / 3rd structural shapes', async () => {
  let prior = 0;
  const callLog = { countRecentErrors: async () => prior };
  const published = PUBLISHED.get('start_run')!;
  const base = {
    code: 'SUBMISSION_SCHEMA_VIOLATION',
    message: '参数不符合 start_run 的输入模式',
    fix: '按工具的输入模式改正这个参数后再调用',
  };
  const first = await escalateProtocolErrors({
    callLog,
    userId: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a',
    tool: 'start_run',
    errors: [base],
    input: StartRunInput,
    inputSchema: published.inputSchema,
  });
  assert.equal(first[0].fix, base.fix);

  prior = 1;
  const second = await escalateProtocolErrors({
    callLog,
    userId: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a',
    tool: 'start_run',
    errors: [base],
    input: StartRunInput,
    inputSchema: published.inputSchema,
  });
  assert.match(second[0].fix!, /最近一小时内第 2 次/);
  assert.match(second[0].fix!, /完整正确示例：/);
  const exampleMatch = /完整正确示例：(\{.*\})/.exec(second[0].fix!);
  assert.ok(exampleMatch);
  assert.equal(StartRunInput.safeParse(JSON.parse(exampleMatch![1])).success, true);

  prior = 2;
  const third = await escalateProtocolErrors({
    callLog,
    userId: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a',
    tool: 'start_run',
    errors: [base],
    input: StartRunInput,
    inputSchema: published.inputSchema,
  });
  assert.match(third[0].fix!, /最近一小时内第 3 次/);
  assert.match(third[0].fix!, /替代路径/);
  assert.match(third[0].fix!, /换写法/);
  assert.match(third[0].fix!, /找谁/);
  assert.match(third[0].fix!, /收尾/);
  assert.ok(third[0].fix!.startsWith(base.fix));
});

test('withEscalatedFix leaves call_result semantics untouched and only extends fix', () => {
  const parts = buildEscalation({ occurrence: 2, exampleJson: '{"pack":"a","inputs":{}}' });
  const error = withEscalatedFix(
    { code: 'SOURCE_ABSENT', message: 'Hub 里没有任务包 toy', fix: '核对任务包名' },
    parts,
  );
  assert.equal(error.code, 'SOURCE_ABSENT');
  assert.equal(error.message, 'Hub 里没有任务包 toy');
  assert.ok(error.fix?.startsWith('核对任务包名；'));
  assert.ok(error.fix?.includes(parts.countLabel));
});
