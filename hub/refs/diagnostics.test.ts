import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
// Synthetic refusals across registry, upload MCP response and the production input binder.
import assert from 'node:assert/strict';
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { test } from 'node:test';
import { ParseError, recognize } from './api.ts';
import { createTestServer } from '../server/testing.ts';
import { bindInputs } from '../runs/engine/inputs.ts';
import { Refusal } from '../runs/engine/errors.ts';
import type { EngineContext } from '../runs/engine/deps.ts';
import type { LoadedWorkflow } from '../ports.ts';

const FIX = PROTOCOL_CODES.SOURCE_UNPARSEABLE.fix;
const vectors = [
  ['application/json', '{broken', 'json@1', /不是有效的 JSON/],
  ['application/xml', '<private-synthetic><other></private-synthetic>', 'xml@1', /XML 格式不对/],
  ['application/xhtml+xml', '<meta charset="synthetic-private-label-0123456789"><p>x</p>', 'html@1', /HTML.*meta.*不支持/],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PK broken', 'xlsx@1', /ZIP 结束记录/],
] as const;

test('recognize reports only the last refusal after every registered candidate refuses', () => {
  const registry = createDefaultRegistry(); const errors: ParseError[] = [];
  assert.equal(recognize(registry, Buffer.from('{broken'), 'application/json', {}, (error) => errors.push(error)), null);
  assert.equal(errors.length, 1); assert.equal(errors[0].parser, 'json@1'); assert.equal(errors[0].code, 'SOURCE_UNPARSEABLE');
  assert.ok(recognize(registry, Buffer.from('{}'), 'application/json', {}, (error) => errors.push(error)));
  assert.equal(errors.length, 1);
});

test('malformed JSON, XML, XHTML and XLSX uploads return the definite parser reason and fix over MCP', async (t) => {
  const server = await createTestServer(); t.after(() => server.close());
  const client = await server.client(server.admin.token); t.after(() => client.close());
  for (const [mediaType, text, parser, reason] of vectors) {
    const result = await client.call('upload_file', { file_path: Buffer.from(text).toString('base64'), media_type: mediaType });
    assert.equal(result.isError, true);
    const errors = result.structuredContent.errors as { code: string; message: string; fix: string }[];
    assert.equal(errors[0].code, 'SOURCE_UNPARSEABLE'); assert.match(errors[0].message, reason); assert.ok(errors[0].message.includes(parser)); assert.equal(errors[0].fix, FIX);
    assert.doesNotMatch(JSON.stringify(result), /private-synthetic|synthetic-private-label/); assert.ok(result.content.some((block) => block.text?.includes(FIX)));
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

test('guessed media types do not reject uploads and the answer explains how to declare the type', async t => {
  const server = await createTestServer(); t.after(() => server.close());
  const client = await server.client(server.admin.token); t.after(() => client.close());
  const args = { file_path: Buffer.from('<p>a<br></p>').toString('base64') };
  const guessed = await client.call('upload_file', args);
  assert.equal(guessed.isError, false); assert.equal(guessed.structuredContent.media_type, 'text/plain');
  assert.equal((guessed.structuredContent.structure as Record<string, unknown>).media_type_guessed, true);
  assert.match(guessed.content.map(c => c.text ?? '').join('\n'), /猜测.*media_type/);
  const declared = await client.call('upload_file', { ...args, name: 'broken.xml' });
  assert.equal(declared.isError, true);
});
test('parser limit recovery is assigned from the limit kind for uploads and run binding', async t => {
  const text = '['.repeat(200) + '0' + ']'.repeat(200);
  const server = await createTestServer(); t.after(() => server.close());
  const client = await server.client(server.admin.token); t.after(() => client.close());
  const answer = await client.call('upload_file', { file_path: Buffer.from(text).toString('base64'), name: 'deep.json' });
  assert.equal(answer.isError, true);
  const error = (answer.structuredContent.errors as { fix: string }[])[0]!;
  assert.match(error.fix, /128/); assert.match(error.fix, /嵌套|拆分/);
  const ctx = { parsers: createDefaultRegistry(), deps: { records: { artifacts: { source: async () => ({ bytes: Buffer.from(text), mediaType: 'application/json', artifact: { body: {} } }) }, store: {} } } } as unknown as EngineContext;
  const workflow = { workflow: { inputs: [{ slot: 'file', role: 'subject', required: true, accepts: ['application/json'] }] } } as unknown as LoadedWorkflow;
  await assert.rejects(bindInputs(ctx, { id: 'synthetic', name: '合成', role: 'user' }, workflow, { file: { reference: `src:${'a'.repeat(64)}` } }, 'synthetic-run', 'synthetic-trace'), (e: unknown) => e instanceof Refusal && /128/.test(e.errors[0]!.fix ?? '') && /嵌套|拆分/.test(e.errors[0]!.fix ?? ''));
});

test('guessed text and JSON limit refusals retain their definite reason and recovery without media advice', async t => {
  const server = await createTestServer(); t.after(() => server.close());
  const client = await server.client(server.admin.token); t.after(() => client.close());
  for (const [text, parser, cap] of [['a\n'.repeat(1_000_001), 'text@1', '1000000'], ['['.repeat(200) + '0' + ']'.repeat(200), 'json@1', '128']]) {
    const result = await client.call('upload_file', { file_path: Buffer.from(text).toString('base64') });
    assert.equal(result.isError, false);
    const structure = result.structuredContent.structure as Record<string, unknown>;
    const refusal = structure.guessed_refusal as { message: string; fix: string };
    assert.ok(refusal); assert.ok(refusal.message.includes(parser)); assert.ok(refusal.fix.includes(cap));
    assert.ok(result.content.some(c => c.text?.includes(refusal.fix)));
    assert.doesNotMatch(String(structure.note), /media_type|application\/xml|text\/html/);
  }
});
