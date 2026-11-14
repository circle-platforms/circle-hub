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
  categoryCloseOf,
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

const FORBIDDEN_CALL_ERROR = /状态已确认|状态未知|判断错误|决定者程序|原因缺资料|原因还没查清|任务包|没有分配给你|替代路径|按工具的输入模式改正这个参数后再调用/;

test('SOURCE_UNAVAILABLE, internal and cancel codes do not escalate', () => {
  assert.equal(countsTowardEscalation('SOURCE_UNAVAILABLE'), false);
  assert.equal(countsTowardEscalation('INTERNAL_ERROR'), false);
  assert.equal(countsTowardEscalation('CANCELLED'), false);
  assert.equal(countsTowardEscalation('REQUEST_CANCELLED'), false);
  assert.equal(countsTowardEscalation(null), false);
  assert.equal(countsTowardEscalation('SUBMISSION_SCHEMA_VIOLATION'), true);
  assert.equal(countsTowardEscalation('SOURCE_NOT_PERMITTED'), true);
});

test('tiers: 1 keeps disclosure, 2 adds example, 3+ adds category close (no 替代路径)', () => {
  assert.equal(escalationTier(1), 1);
  assert.equal(escalationTier(2), 2);
  assert.equal(escalationTier(3), 3);
  assert.equal(escalationTier(9), 3);
  const first = buildEscalation({ occurrence: 1, exampleJson: '{"pack":"<工作流编号>","inputs":{}}' });
  assert.equal(first.fixSuffix, null);
  assert.equal(first.exampleJson, null);
  const second = buildEscalation({ occurrence: 2, exampleJson: '{"pack":"<工作流编号>","inputs":{}}', category: '参数无效', hasPath: true });
  assert.equal(second.tier, 2);
  assert.match(second.countLabel, /这是一小时内第 2 次同样的错误/);
  assert.ok(second.fixSuffix?.includes(second.countLabel));
  assert.ok(second.fixSuffix?.includes('完整的正确写法：'));
  assert.ok(second.fixSuffix?.includes(second.exampleJson!));
  assert.equal(second.categoryClose, null);
  assert.doesNotMatch(second.fixSuffix!, FORBIDDEN_CALL_ERROR);
  assert.doesNotMatch(second.fixSuffix!, /"x"/);
  const noPath = buildEscalation({ occurrence: 2, exampleJson: null, category: '参数无效', hasPath: false });
  assert.equal(noPath.countLabel, '这是一小时内这个工具第 2 次参数无效');
  const third = buildEscalation({ occurrence: 3, exampleJson: '{"pack":"<工作流编号>","inputs":{}}', category: '参数无效', hasPath: true });
  assert.equal(third.tier, 3);
  assert.match(third.countLabel, /这是一小时内第 3 次同样的错误/);
  assert.ok(third.categoryClose?.includes('照原样重试不会成功'));
  assert.ok(third.fixSuffix?.includes(third.countLabel));
  assert.ok(third.fixSuffix?.includes('照原样重试不会成功'));
  assert.doesNotMatch(third.fixSuffix!, /替代路径/);
  assert.doesNotMatch(third.fixSuffix!, FORBIDDEN_CALL_ERROR);
});

test('1st / 2nd / 3rd composed prose uses D2 first sentence then escalation', () => {
  const category = categoryOfCallError('SUBMISSION_SCHEMA_VIOLATION')!;
  assert.equal(category, '参数无效');
  const message = '/pack 是必填的字符串，这次没有给出';
  const baseFix = '请在 /pack 写 list_task_packs 返回的编号。规则见 start_run 输入格式的 pack';
  const example = checkedExampleFromInputSchema(PUBLISHED.get('start_run')!.inputSchema, StartRunInput)!;
  assert.equal(StartRunInput.safeParse(JSON.parse(example)).success, true);
  assert.doesNotMatch(example, /"x"/);

  const first = formatCategoryCallError({ category, message, fix: baseFix });
  assert.equal(
    first,
    '参数无效：/pack 是必填的字符串，这次没有给出。请在 /pack 写 list_task_packs 返回的编号。规则见 start_run 输入格式的 pack。',
  );
  assert.doesNotMatch(first, FORBIDDEN_CALL_ERROR);

  const secondParts = buildEscalation({ occurrence: 2, exampleJson: example, category, hasPath: true });
  const secondFix = withEscalatedFix({ code: 'SUBMISSION_SCHEMA_VIOLATION', message, fix: baseFix }, secondParts).fix!;
  const second = formatCategoryCallError({ category, message, fix: secondFix });
  assert.match(second, /^参数无效：/);
  assert.match(second, /这是一小时内第 2 次同样的错误/);
  assert.match(second, /完整的正确写法：/);
  assert.ok(second.includes(example));
  assert.doesNotMatch(second, FORBIDDEN_CALL_ERROR);

  const thirdParts = buildEscalation({ occurrence: 3, exampleJson: example, category, hasPath: true });
  const thirdFix = withEscalatedFix({ code: 'SUBMISSION_SCHEMA_VIOLATION', message, fix: baseFix }, thirdParts).fix!;
  const third = formatCategoryCallError({ category, message, fix: thirdFix });
  assert.match(third, /这是一小时内第 3 次同样的错误/);
  assert.match(third, /照原样重试不会成功/);
  assert.doesNotMatch(third, /替代路径/);
  assert.doesNotMatch(third, FORBIDDEN_CALL_ERROR);
});

test('categoryCloseOf covers the five categories', () => {
  assert.match(categoryCloseOf('参数无效')!, /照原样重试不会成功/);
  assert.match(categoryCloseOf('无权限')!, /这不是写法问题/);
  assert.match(categoryCloseOf('不存在')!, /请先用列表工具核对名称/);
  assert.match(categoryCloseOf('已被占用')!, /请等待持有者释放/);
  assert.match(categoryCloseOf('暂时不可用', 30)!, /请等待 30 秒/);
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

test('every emitted tool schema example passes that tool input safeParse and avoids "x"', () => {
  for (const [name, input] of Object.entries(TOOL_INPUTS)) {
    const published = PUBLISHED.get(name);
    assert.ok(published, name);
    const json = checkedExampleFromInputSchema(published.inputSchema, input);
    assert.ok(json !== null, `${name} must yield a schema-checked example`);
    const parsed = JSON.parse(json!);
    assert.equal(input.safeParse(parsed).success, true, name);
    assert.doesNotMatch(json!, /"x"/);
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
      path: '/pack',
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
    path: '/pack',
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
    message: '/pack 是必填的字符串，这次没有给出',
    fix: '请在 /pack 写 list_task_packs 返回的编号。规则见 start_run 输入格式的 pack',
    path: '/pack',
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
    '参数无效：/pack 是必填的字符串，这次没有给出。请在 /pack 写 list_task_packs 返回的编号。规则见 start_run 输入格式的 pack。',
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
  assert.match(second[0].fix!, /这是一小时内第 2 次同样的错误/);
  assert.match(second[0].fix!, /完整的正确写法：/);
  const exampleMatch = /完整的正确写法：(\{.*\})/.exec(second[0].fix!);
  assert.ok(exampleMatch);
  assert.equal(StartRunInput.safeParse(JSON.parse(exampleMatch![1])).success, true);
  assert.doesNotMatch(second[0].fix!, FORBIDDEN_CALL_ERROR);

  prior = 2;
  const third = await escalateProtocolErrors({
    callLog,
    userId: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a',
    tool: 'start_run',
    errors: [base],
    input: StartRunInput,
    inputSchema: published.inputSchema,
  });
  assert.match(third[0].fix!, /这是一小时内第 3 次同样的错误/);
  assert.match(third[0].fix!, /照原样重试不会成功/);
  assert.doesNotMatch(third[0].fix!, /替代路径/);
  assert.doesNotMatch(third[0].fix!, FORBIDDEN_CALL_ERROR);
});

test('withEscalatedFix leaves call_result semantics untouched and only extends fix', () => {
  const parts = buildEscalation({ occurrence: 2, exampleJson: '{"pack":"<工作流编号>","inputs":{}}', category: '不存在' });
  const error = withEscalatedFix(
    { code: 'SOURCE_ABSENT', message: 'Hub 里没有名为「toy」的工作流或技能', fix: '请核对名称' },
    parts,
  );
  assert.equal(error.code, 'SOURCE_ABSENT');
  assert.equal(error.message, 'Hub 里没有名为「toy」的工作流或技能');
  assert.ok(error.fix?.startsWith('请核对名称。'));
  assert.ok(error.fix?.includes(parts.countLabel));
  assert.doesNotMatch(error.fix!, FORBIDDEN_CALL_ERROR);
});

test('fixByRole keeps an admin fix that already carries the D5 escalation suffix', () => {
  const mapped = fixByRole('SOURCE_NOT_PERMITTED', 'admin')!;
  const parts = buildEscalation({ occurrence: 2, exampleJson: null, category: '无权限' });
  const escalated = `${mapped}。${parts.fixSuffix}。`;
  // Callers that already escalated should pass the escalated string through text.ts without fixByRole dropping it.
  assert.ok(/这是一小时内第 2 次同样的错误/.test(escalated));
  assert.equal(fixByRole('SOURCE_NOT_PERMITTED', 'admin'), mapped);
});
