import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProtocolError } from '../../contracts/src/common.ts';
import { GetNodesInput, ListTaskPacksInput, ResolveReferenceInput, StartRunInput, UploadFileInput } from '../../contracts/src/tools.ts';
import { PUBLISHED, pathInInputSchema, schemaErrors } from './tools.ts';

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

function assertSchemaError(tool: Tool, error: ProtocolError, expectedFix: string) {
  const input = PUBLISHED.get(tool)!.inputSchema as Record<string, unknown>;
  assert.equal(typeof error.path === 'string' && pathInInputSchema(input, error.path), true, `path ${error.path} must resolve in ${tool} inputSchema`);
  assert.equal(error.fix, expectedFix);
  assert.match(error.message, /^参数无效：/);
  assert.match(error.fix!, /^请/);
  assert.match(error.fix!, /规则见 /);
  assert.doesNotMatch(error.fix!, /规则全文|；规则/);
  assert.doesNotMatch(`${error.message}\n${error.fix}`, /你|undefined/i);
  assert.match(`${error.message}。${error.fix}。`, /^参数无效：.+\。请.+\。规则见 .+\。$/);
}

test('missing required pack: category sentence without undefined', () => {
  const errors = refuse('start_run', {});
  const pack = errors.find((e) => e.path === '/pack');
  assert.ok(pack);
  assertSchemaError(
    'start_run',
    pack,
    '请在 /pack 写 list_task_packs 返回的编号。规则见 start_run 输入格式的 pack',
  );
  assert.equal(pack.message, '参数无效：/pack 是必填的字符串，这次没有给出');
  assert.equal(
    `${pack.message}。${pack.fix}。`,
    '参数无效：/pack 是必填的字符串，这次没有给出。请在 /pack 写 list_task_packs 返回的编号。规则见 start_run 输入格式的 pack。',
  );
});

test('enum kind=plugin lists allowed values', () => {
  const errors = refuse('list_task_packs', { kind: 'plugin' });
  assert.equal(errors.length, 1);
  assertSchemaError(
    'list_task_packs',
    errors[0],
    '请在 /kind 写 "workflow"（或去掉 kind 以列出全部）。规则见 list_task_packs 输入格式的 kind',
  );
  assert.equal(errors[0].path, '/kind');
  assert.equal(
    errors[0].message,
    '参数无效：/kind 收到的是 "plugin"；允许的取值只有 product、workflow、system、skill',
  );
});

test('unknown key names the key and legal fields', () => {
  const errors = refuse('list_task_packs', { knd: 'x' });
  assert.equal(errors.length, 1);
  assertSchemaError(
    'list_task_packs',
    errors[0],
    '请去掉 /knd；合法字段见 inputSchema（kind、pack_id、offset）。规则见 list_task_packs 输入格式',
  );
  assert.equal(errors[0].path, '/knd');
  assert.equal(errors[0].message, '参数无效：不认识的参数 knd');
});

test('wrong type on offset uses integer shape, not undefined', () => {
  const errors = refuse('list_task_packs', { offset: '0' });
  assert.equal(errors.length, 1);
  assertSchemaError(
    'list_task_packs',
    errors[0],
    '请在 /offset 写数字 0（或上一页续读的整数下标）。规则见 list_task_packs 输入格式的 offset',
  );
  assert.equal(errors[0].path, '/offset');
  assert.equal(errors[0].message, '参数无效：/offset 要的是整数（≥0），收到的是字符串');
});

test('every crafted parameter error path resolves and fix is specific', () => {
  const samples: { tool: Tool; args: unknown; expectedFixes: string[] }[] = [
    {
      tool: 'start_run',
      args: {},
      expectedFixes: [
        '请在 /pack 写 list_task_packs 返回的编号。规则见 start_run 输入格式的 pack',
        '请在 /inputs 给出对象，键为输入槽名，值为引用或外部对象。规则见 start_run 输入格式的 inputs',
      ],
    },
    {
      tool: 'start_run',
      args: { pack: 1, inputs: {} },
      expectedFixes: ['请在 /pack 写 list_task_packs 返回的编号。规则见 start_run 输入格式的 pack'],
    },
    {
      tool: 'start_run',
      args: { pack: 'p', inputs: { s: { reference: 'nope' } } },
      expectedFixes: [
        '请在 /inputs/s/reference 写符合 REFERENCE_FORMS 的引用字符串（如 upload_file 返回的 src:…）。规则见 start_run 输入格式的 reference',
      ],
    },
    {
      tool: 'list_task_packs',
      args: { kind: 'plugin' },
      expectedFixes: [
        '请在 /kind 写 "workflow"（或去掉 kind 以列出全部）。规则见 list_task_packs 输入格式的 kind',
      ],
    },
    {
      tool: 'list_task_packs',
      args: { knd: 'x', 'a/b': 1 },
      expectedFixes: [
        '请去掉 /knd；合法字段见 inputSchema（kind、pack_id、offset）。规则见 list_task_packs 输入格式',
        '请去掉 /a~1b；合法字段见 inputSchema（kind、pack_id、offset）。规则见 list_task_packs 输入格式',
      ],
    },
    {
      tool: 'list_task_packs',
      args: { offset: '0' },
      expectedFixes: [
        '请在 /offset 写数字 0（或上一页续读的整数下标）。规则见 list_task_packs 输入格式的 offset',
      ],
    },
    {
      tool: 'upload_file',
      args: { file_path: 1 },
      expectedFixes: ['请在 /file_path 写字符串。规则见 upload_file 输入格式的 file_path'],
    },
    {
      tool: 'get_nodes',
      args: { depth: 'deep' },
      expectedFixes: ['请在 /depth 写整数（≥0）。规则见 get_nodes 输入格式的 depth'],
    },
    {
      tool: 'resolve_reference',
      args: {},
      expectedFixes: ['请在 /text 写字符串。规则见 resolve_reference 输入格式的 text'],
    },
    {
      tool: 'resolve_reference',
      args: { text: 1 },
      expectedFixes: ['请在 /text 写字符串。规则见 resolve_reference 输入格式的 text'],
    },
  ];
  for (const sample of samples) {
    const errors = refuse(sample.tool, sample.args);
    assert.equal(errors.length, sample.expectedFixes.length, JSON.stringify(sample));
    for (let i = 0; i < errors.length; i++) {
      assertSchemaError(sample.tool, errors[i]!, sample.expectedFixes[i]!);
    }
  }
});
