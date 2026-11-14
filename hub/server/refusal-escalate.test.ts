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
  categoryOfCallError,
  checkedExampleFromInputSchema,
  checkedPackDeclaredExample,
  countsTowardEscalation,
  escalateProtocolErrors,
  escalationTier,
  factOfCallError,
  formatCategoryCallError,
  isPackScopedCode,
  occurrenceOf,
  withEscalatedFix,
} from './refusal-escalate.ts';
import { fixByRole } from './fix-by-role.ts';

const TOOL_INPUTS = {
  list_task_packs: ListTaskPacksInput,
  upload_file: UploadFileInput,
  start_run: StartRunInput,
  get_nodes: GetNodesInput,
  resolve_reference: ResolveReferenceInput,
  submit_result: SubmitResultInput,
} as const;

const FORBIDDEN_CALL_ERROR = /状态已确认|状态未知|判断错误|决定者程序|原因缺资料|原因还没查清|任务包|没有分配给你/;

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
  assert.doesNotMatch(second.fixSuffix!, FORBIDDEN_CALL_ERROR);
  const third = buildEscalation({ occurrence: 3, exampleJson: '{"pack":"a","inputs":{}}' });
  assert.equal(third.tier, 3);
  assert.match(third.countLabel, /最近一小时内第 3 次/);
  assert.ok(third.alternative?.includes('替代路径'));
  assert.ok(third.alternative?.includes('换写法'));
  assert.ok(third.alternative?.includes('找谁'));
  assert.ok(third.alternative?.includes('收尾'));
  assert.ok(third.fixSuffix?.includes(third.countLabel));
  assert.ok(third.fixSuffix?.includes('替代路径'));
  assert.doesNotMatch(third.fixSuffix!, FORBIDDEN_CALL_ERROR);
  assert.doesNotMatch(third.alternative!, FORBIDDEN_CALL_ERROR);
});

test('1st / 2nd / 3rd composed prose uses the five-category sentence form', () => {
  const category = categoryOfCallError('SUBMISSION_SCHEMA_VIOLATION')!;
  assert.equal(category, '参数无效');
  const message = '参数不符合 start_run 的输入模式：缺少 pack';
  const baseFix = '按工具的输入模式改正这个参数后再调用';
  const example = checkedExampleFromInputSchema(PUBLISHED.get('start_run')!.inputSchema, StartRunInput)!;
  assert.equal(StartRunInput.safeParse(JSON.parse(example)).success, true);

  const first = formatCategoryCallError({ category, message, fix: baseFix });
  assert.equal(first, '参数无效：参数不符合 start_run 的输入模式：缺少 pack。按工具的输入模式改正这个参数后再调用。');
  assert.doesNotMatch(first, FORBIDDEN_CALL_ERROR);

  const secondParts = buildEscalation({ occurrence: 2, exampleJson: example });
  const secondFix = withEscalatedFix({ code: 'SUBMISSION_SCHEMA_VIOLATION', message, fix: baseFix }, secondParts).fix!;
  const second = formatCategoryCallError({ category, message, fix: secondFix });
  assert.match(second, /^参数无效：.+\。.+\。$/);
  assert.match(second, /最近一小时内第 2 次/);
  assert.match(second, /完整正确示例：/);
  assert.ok(second.includes(example));
  assert.doesNotMatch(second, FORBIDDEN_CALL_ERROR);
  assert.equal(second.includes('状态'), false);
  assert.equal(second.includes('判断'), false);
  assert.equal(second.includes('决定者'), false);

  const thirdParts = buildEscalation({ occurrence: 3, exampleJson: example });
  const thirdFix = withEscalatedFix({ code: 'SUBMISSION_SCHEMA_VIOLATION', message, fix: baseFix }, thirdParts).fix!;
  const third = formatCategoryCallError({ category, message, fix: thirdFix });
  assert.match(third, /^参数无效：.+\。.+\。$/);
  assert.match(third, /最近一小时内第 3 次/);
  assert.match(third, /替代路径/);
  assert.match(third, /换写法/);
  assert.match(third, /找谁/);
  assert.match(third, /收尾/);
  assert.doesNotMatch(third, FORBIDDEN_CALL_ERROR);
});

test('factOfCallError strips a leading category word so format does not double it', () => {
  assert.equal(factOfCallError('参数无效：/pack 是必填的字符串，这次没有给出', '参数无效'), '/pack 是必填的字符串，这次没有给出');
  assert.equal(
    formatCategoryCallError({
      category: '参数无效',
      message: '参数无效：/pack 是必填的字符串，这次没有给出',
      fix: '请在 /pack 写 list_task_packs 返回的编号',
    }),
    '参数无效：/pack 是必填的字符串，这次没有给出。请在 /pack 写 list_task_packs 返回的编号。',
  );
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

test('escalateProtocolErrors syncs fix for the 1st / 2nd / 3rd category-form shapes', async () => {
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
  assert.equal(
    formatCategoryCallError({ category: '参数无效', message: first[0].message, fix: first[0].fix }),
    '参数无效：参数不符合 start_run 的输入模式。按工具的输入模式改正这个参数后再调用。',
  );

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
  const secondProse = formatCategoryCallError({
    category: '参数无效',
    message: second[0].message,
    fix: second[0].fix,
  });
  assert.match(secondProse, /^参数无效：.+\。.+\。$/);
  assert.doesNotMatch(secondProse, FORBIDDEN_CALL_ERROR);

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
  const thirdProse = formatCategoryCallError({
    category: '参数无效',
    message: third[0].message,
    fix: third[0].fix,
  });
  assert.match(thirdProse, /^参数无效：.+\。.+\。$/);
  assert.doesNotMatch(thirdProse, FORBIDDEN_CALL_ERROR);
});

test('withEscalatedFix leaves call_result semantics untouched and only extends fix', () => {
  const parts = buildEscalation({ occurrence: 2, exampleJson: '{"pack":"a","inputs":{}}' });
  const error = withEscalatedFix(
    { code: 'SOURCE_ABSENT', message: 'Hub 里没有工作流 toy', fix: '核对工作流名称' },
    parts,
  );
  assert.equal(error.code, 'SOURCE_ABSENT');
  assert.equal(error.message, 'Hub 里没有工作流 toy');
  assert.ok(error.fix?.startsWith('核对工作流名称；'));
  assert.ok(error.fix?.includes(parts.countLabel));
  assert.doesNotMatch(error.fix!, FORBIDDEN_CALL_ERROR);
});

test('fixByRole keeps an admin fix that already carries the D5 escalation suffix', () => {
  const mapped = fixByRole('SOURCE_NOT_PERMITTED', 'admin')!;
  const parts = buildEscalation({ occurrence: 2, exampleJson: null });
  const escalated = `${mapped}；${parts.fixSuffix}`;
  assert.equal(fixByRole('SOURCE_NOT_PERMITTED', 'admin', escalated), escalated);
  assert.equal(fixByRole('SOURCE_NOT_PERMITTED', 'admin'), mapped);
});
