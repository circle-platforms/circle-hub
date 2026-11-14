// schemaErrors: each path resolves in the published inputSchema, fix is this-call wording (never the legacy generic), and missing required fields never say "undefined".
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

function assertSchemaError(tool: Tool, error: ProtocolError) {
  const input = PUBLISHED.get(tool)!.inputSchema as Record<string, unknown>;
  assert.equal(typeof error.path === 'string' && pathInInputSchema(input, error.path), true, `path ${error.path} must resolve in ${tool} inputSchema`);
  assert.equal(typeof error.fix, 'string');
  assert.notEqual(error.fix, LEGACY_ARGUMENT_FIX);
  assert.doesNotMatch(`${error.message}\n${error.fix}`, /undefined/i);
  assert.match(error.fix!, /这次可以这样写：/);
  assert.match(error.fix!, /规则全文：tools\/list →/);
}

test('missing required pack: this-call wording without undefined', () => {
  const errors = refuse('start_run', {});
  const pack = errors.find((e) => e.path === '/pack');
  assert.ok(pack);
  assertSchemaError('start_run', pack);
  assert.equal(pack.message, '参数不符合 start_run 的输入模式：/pack 是必填的字符串，这次没有给出');
  assert.equal(
    pack.fix,
    '这次可以这样写：在 /pack 写 list_task_packs 返回的包 id（可带 @version），并保留 /inputs；规则全文：tools/list → start_run.inputSchema 的 pack',
  );
});

test('enum kind=plugin lists allowed values', () => {
  const errors = refuse('list_task_packs', { kind: 'plugin' });
  assert.equal(errors.length, 1);
  assertSchemaError('list_task_packs', errors[0]);
  assert.equal(errors[0].path, '/kind');
  assert.equal(
    errors[0].message,
    '参数不符合 list_task_packs 的输入模式：/kind 收到的是 "plugin"；允许的取值只有 product、workflow、system、skill',
  );
  assert.equal(
    errors[0].fix,
    '这次可以这样写：在 /kind 写 "workflow"（或去掉 kind 以列出全部）；规则全文：tools/list → list_task_packs.inputSchema 的 kind.enum',
  );
});

test('unknown key names the key and legal fields', () => {
  const errors = refuse('list_task_packs', { knd: 'x' });
  assert.equal(errors.length, 1);
  assertSchemaError('list_task_packs', errors[0]);
  assert.equal(errors[0].path, '/knd');
  assert.equal(errors[0].message, '参数不符合 list_task_packs 的输入模式：不认识的参数 knd');
  assert.equal(
    errors[0].fix,
    '这次可以这样写：去掉 /knd；合法字段见 inputSchema（kind、pack_id、offset）；规则全文：tools/list → list_task_packs.inputSchema',
  );
});

test('wrong type on offset uses integer shape, not undefined', () => {
  const errors = refuse('list_task_packs', { offset: '0' });
  assert.equal(errors.length, 1);
  assertSchemaError('list_task_packs', errors[0]);
  assert.equal(errors[0].path, '/offset');
  assert.equal(errors[0].message, '参数不符合 list_task_packs 的输入模式：/offset 要的是整数（≥0），收到的是字符串');
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
