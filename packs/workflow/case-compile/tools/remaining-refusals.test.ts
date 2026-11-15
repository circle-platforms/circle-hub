import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CallFailure, callFailureData } from '../functions/text.ts';
import { canonicalJson } from '../functions/canonical-json.ts';
import { parsePriorPlanSnapshot } from '../functions/rework-history.ts';
import { parseCommaRoundList } from './rework-inputs.ts';
import { readKnowledge } from './authoring-brief.ts';

const cli = (name: string, args: string[], cwd: string) => spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args], { cwd, encoding: 'utf8' });
const invalid = (error: unknown): boolean => error instanceof CallFailure && error.category === 'invalid_parameters' && error.next_action.length > 0;

test('normalization refuses missing inputs and occupied outputs using native filesystem codes', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'typed-normalize-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  const missing = cli('normalize-mindmap.ts', ['--in', 'missing.json', '--out', 'new.json'], scratch);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /^不存在：/); assert.doesNotMatch(missing.stderr, /缺少结构化错误原因/);
  await writeFile(join(scratch, 'source.json'), '{"root":{"data":{},"children":[]}}');
  await writeFile(join(scratch, 'existing.json'), 'original output');
  const occupied = cli('normalize-mindmap.ts', ['--in', 'source.json', '--out', 'existing.json'], scratch);
  assert.equal(occupied.status, 1); assert.match(occupied.stderr, /^已被占用：/);
  assert.equal(await readFile(join(scratch, 'existing.json'), 'utf8'), 'original output');
  const malformed = cli('normalize-mindmap.ts', ['--in', 'source.json', '--out'], scratch);
  assert.equal(malformed.status, 1); assert.match(malformed.stderr, /^参数无效：/); assert.match(malformed.stderr, /--out/);
});

test('recomposition CLI declares JSON and argument failures at their producer boundary', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'typed-recompose-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  await writeFile(join(scratch, 'run.json'), '{'); await writeFile(join(scratch, 'parts.json'), '[]');
  const malformed = cli('seal-recompose.ts', ['--run', 'run.json', '--parts', 'parts.json', '--model', 'synthetic-model', '--out', 'draft.json'], scratch);
  assert.equal(malformed.status, 1); assert.match(malformed.stderr, /^参数无效：--run 不是完整的 UTF-8 JSON/);
  const unknown = cli('seal-recompose.ts', ['--network', 'poison prose'], scratch);
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /^参数无效：未知选项 --network/);
});

test('prior-round input validation is typed regardless of source-label prose', () => {
  assert.throws(() => parseCommaRoundList('', 2, '--prior-plans'), invalid);
  assert.throws(() => parseCommaRoundList('a,b,c', 2, '--prior-plans'), invalid);
  assert.throws(() => parsePriorPlanSnapshot({ items: [] }, new Set(['synthetic']), 'network permission denied'), invalid);
  assert.throws(() => parsePriorPlanSnapshot({ item: 'other', steps: [] }, new Set(['synthetic'])), invalid);
});

test('canonical JSON reports malformed Unicode and excessive depth as typed input errors', () => {
  for (const value of ['\ud800', Infinity, undefined]) assert.throws(() => canonicalJson(value), invalid);
  let nested: unknown = null; for (let index = 0; index < 1002; index++) nested = [nested];
  assert.throws(() => canonicalJson(nested), invalid);
  try { canonicalJson('\ud800'); } catch (error) { assert.equal(callFailureData(error).category, 'invalid_parameters'); }
});

test('knowledge brief parsing supplies a concrete typed recovery instead of a neutral fallback', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'typed-knowledge-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(join(scratch, 'knowledge')); await writeFile(join(scratch, 'knowledge', 'nodes.jsonl'), '{"schema":"wrong","root":"synthetic"}\n');
  await assert.rejects(readKnowledge(scratch), (error: unknown) => invalid(error) && error instanceof CallFailure && error.next_action.includes('run-knowledge@1'));
});
