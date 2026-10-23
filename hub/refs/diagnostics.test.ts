// Synthetic refusals across registry, upload MCP response and the production input binder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParseError, createDefaultRegistry, recognize } from './api.ts';
import { createTestServer } from '../server/testing.ts';
import { bindInputs } from '../runs/engine/inputs.ts';
import { Refusal } from '../runs/engine/errors.ts';
import type { EngineContext } from '../runs/engine/deps.ts';
import type { LoadedWorkflow } from '../ports.ts';

const FIX = '上传能按声明格式解析的文件，或换用对应的解析器';
const vectors = [
  ['application/json', '{broken', 'json@1', /不是有效的 JSON/],
  ['application/xml', '<private-synthetic><other></private-synthetic>', 'xml@1', /XML 格式不对/],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PK broken', 'xlsx@1', /ZIP 结束记录/],
] as const;

test('recognize reports only the last refusal after every registered candidate refuses', () => {
  const registry = createDefaultRegistry(); const errors: ParseError[] = [];
  assert.equal(recognize(registry, Buffer.from('{broken'), 'application/json', {}, (error) => errors.push(error)), null);
  assert.equal(errors.length, 1); assert.equal(errors[0].parser, 'json@1'); assert.equal(errors[0].code, 'SOURCE_UNPARSEABLE');
  assert.ok(recognize(registry, Buffer.from('{}'), 'application/json', {}, (error) => errors.push(error)));
  assert.equal(errors.length, 1);
});

test('malformed JSON, XML and XLSX uploads return the definite parser reason and fix over MCP', async (t) => {
  const server = await createTestServer(); t.after(() => server.close());
  const client = await server.client(server.admin.token); t.after(() => client.close());
  for (const [mediaType, text, parser, reason] of vectors) {
    const result = await client.call('upload_file', { file_path: Buffer.from(text).toString('base64'), media_type: mediaType });
    assert.equal(result.isError, true);
    const errors = result.structuredContent.errors as { code: string; message: string; fix: string }[];
    assert.equal(errors[0].code, 'SOURCE_UNPARSEABLE'); assert.match(errors[0].message, reason); assert.ok(errors[0].message.includes(parser)); assert.equal(errors[0].fix, FIX);
    assert.doesNotMatch(JSON.stringify(result), /private-synthetic/); assert.ok(result.content.some((block) => block.text?.includes(FIX)));
  }
});

test('input binding refuses the same malformed sources with SOURCE_UNPARSEABLE and input path', async () => {
  for (const [mediaType, text, parser, reason] of vectors) {
    const ctx = { parsers: createDefaultRegistry(), deps: { records: { artifacts: { source: async () => ({ bytes: Buffer.from(text), mediaType, artifact: { body: {} } }) }, store: {} } } } as unknown as EngineContext;
    const workflow = { workflow: { inputs: [{ slot: 'file', role: 'subject', required: true, accepts: [mediaType] }] } } as unknown as LoadedWorkflow;
    await assert.rejects(bindInputs(ctx, { id: 'synthetic', name: '合成', role: 'user' }, workflow, { file: { reference: `src:${'a'.repeat(64)}` } }, 'synthetic-run', 'synthetic-trace'), (error: unknown) => {
      assert.ok(error instanceof Refusal); assert.equal(error.errors[0].code, 'SOURCE_UNPARSEABLE'); assert.equal(error.errors[0].path, '/inputs/file'); assert.match(error.errors[0].message, reason); assert.ok(error.errors[0].message.includes(parser)); assert.equal(error.errors[0].fix, FIX); return true;
    });
  }
});
