// schemaErrors: category sentence form「参数无效：<事实>」+「请<下一步>」；path resolves; never undefined / 你.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProtocolError } from '../../contracts/src/common.ts';
import { GetNodesInput, ListTaskPacksInput, ResolveReferenceInput, StartRunInput, UploadFileInput } from '../../contracts/src/tools.ts';
import { LEGACY_ARGUMENT_FIX, PUBLISHED, pathInInputSchema, schemaErrors } from './tools.ts';

const schemas = {
  list_task_packs: ListTaskPacksInput,
  start_run: StartRunInput,
  upload_file: UploadFileInput,
  get_nodes: GetNodesInput,
  resolve_reference: ResolveReferenceInput,
} as const;

type Tool = keyof typeof schemas;

function refuse(tool: Tool, args: unknown) {
  const parsed = schemas[tool].safeParse(args);
  assert.ok(!parsed.success, `${tool} should refuse ${JSON.stringify(args)}`);
  return schemaErrors(tool, parsed.error, args);
}

/** message=类别+事实、fix=下一步（规则短截可接后）；合起来即 `<类别词>：<事实>。<下一步>。` */
function assertSchemaError(tool: Tool, error: ProtocolError) {
  const input = PUBLISHED.get(tool)!.inputSchema as Record<string, unknown>;
  assert.equal(typeof error.path === 'string' && pathInInputSchema(input, error.path), true, `path ${error.path} must resolve in ${tool} inputSchema`);
  assert.equal(typeof error.fix, 'string');
  assert.notEqual(error.fix, LEGACY_ARGUMENT_FIX);
  assert.match(error.message, /^参数无效：/);
  assert.match(error.fix!, /^请/);
  assert.match(error.fix!, /规则全文：tools\/list →/);
  assert.doesNotMatch(`${error.message}\n${error.fix}`, /你|undefined/i);
  const next = error.fix!.replace(/；规则全文：.+$/, '');
  assert.match(`${error.message}。${next}。`, /^参数无效：.+\。请.+\。$/);
}

test('missing required pack: category sentence without undefined', () => {
  const errors = refuse('start_run', {});
  const pack = errors.find((e) => e.path === '/pack');
  assert.ok(pack);
  assertSchemaError('start_run', pack);
  assert.equal(pack.message, '参数无效：/pack 是必填的字符串，这次没有给出');
  assert.equal(
    pack.fix,
    '请在 /pack 写 list_task_packs 返回的编号；规则全文：tools/list → start_run.inputSchema 的 pack',
  );
  assert.equal(
    `${pack.message}。${pack.fix!.replace(/；规则全文：.+$/, '')}。`,
    '参数无效：/pack 是必填的字符串，这次没有给出。请在 /pack 写 list_task_packs 返回的编号。',
  );
});

test('enum kind=plugin lists allowed values', () => {
  const errors = refuse('list_task_packs', { kind: 'plugin' });
  assert.equal(errors.length, 1);
  assertSchemaError('list_task_packs', errors[0]);
  assert.equal(errors[0].path, '/kind');
  assert.equal(
    errors[0].message,
    '参数无效：/kind 收到的是 "plugin"；允许的取值只有 product、workflow、system、skill',
  );
  assert.equal(
    errors[0].fix,
    '请在 /kind 写 "workflow"（或去掉 kind 以列出全部）；规则全文：tools/list → list_task_packs.inputSchema 的 kind.enum',
  );
});

test('unknown key names the key and legal fields', () => {
  const errors = refuse('list_task_packs', { knd: 'x' });
  assert.equal(errors.length, 1);
  assertSchemaError('list_task_packs', errors[0]);
  assert.equal(errors[0].path, '/knd');
  assert.equal(errors[0].message, '参数无效：不认识的参数 knd');
  assert.equal(
    errors[0].fix,
    '请去掉 /knd；合法字段见 inputSchema（kind、pack_id、offset）；规则全文：tools/list → list_task_packs.inputSchema',
  );
});

test('wrong type on offset uses integer shape, not undefined', () => {
  const errors = refuse('list_task_packs', { offset: '0' });
  assert.equal(errors.length, 1);
  assertSchemaError('list_task_packs', errors[0]);
  assert.equal(errors[0].path, '/offset');
  assert.equal(errors[0].message, '参数无效：/offset 要的是整数（≥0），收到的是字符串');
});

test('every crafted parameter error path resolves and fix is specific', () => {
  const samples: { tool: Tool; args: unknown }[] = [
    { tool: 'start_run', args: {} },
    { tool: 'start_run', args: { pack: 1, inputs: {} } },
    { tool: 'start_run', args: { pack: 'p', inputs: { s: { reference: 'nope' } } } },
    { tool: 'list_task_packs', args: { kind: 'plugin' } },
    { tool: 'list_task_packs', args: { knd: 'x', 'a/b': 1 } },
    { tool: 'list_task_packs', args: { offset: '0' } },
    { tool: 'upload_file', args: { file_path: 1 } },
    { tool: 'get_nodes', args: { depth: 'deep' } },
    { tool: 'resolve_reference', args: {} },
    { tool: 'resolve_reference', args: { text: 1 } },
  ];
  for (const sample of samples) {
    const errors = refuse(sample.tool, sample.args);
    assert.ok(errors.length > 0, JSON.stringify(sample));
    for (const error of errors) assertSchemaError(sample.tool, error);
  }
});
