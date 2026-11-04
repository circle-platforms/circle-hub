// What a sandboxed function adds to its trace: a `run-function` step of type tool, the run and its time, the wait for a
// slot, and a waiting call kept in the trace that asked. Synthetic packs in a temporary directory.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { installTraceSink, startTrace, type SpanRow } from '../../telemetry/usage.ts';
import { SandboxError } from './errors.ts';
import { MAX_CONCURRENT, callPackFunction } from './sandbox.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-rules-usage-')));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'functions'));
writeFileSync(join(root, 'functions/echo.ts'), 'export default function (input: unknown) { return input; }\n');
writeFileSync(join(root, 'functions/fail.ts'), `export default function () { throw new Error('synthetic failure'); }\n`);

const target = (module: string) => ({ packDir: root, module });
const OPTIONS = { requireOsIsolation: false };

test('a function run is a tool step with its usage; a failed run counts too', async (t) => {
  const rows: SpanRow[] = [];
  t.after(installTraceSink({ push: (row) => rows.push(row) }));
  const result = await startTrace({ name: 'start_run', origin: 'mcp' }, () => callPackFunction(target('functions/echo.ts'), { value: 1 }, {}, OPTIONS));
  assert.deepEqual(result.output, { value: 1 });
  const step = rows.find((row) => row.name === 'run-function')!;
  assert.equal(step.type, 'tool');
  assert.equal(step.usage['sandbox.runs'], 1);
  assert.ok((step.usage['sandbox.ms'] ?? 0) > 0);
  assert.equal(typeof step.usage['sandbox.wait_ms'], 'number');
  const root = rows.find((row) => row.is_root)!;
  assert.equal(step.parent_span_id, root.span_id);
  assert.equal(root.usage['sandbox.runs'], 1, 'the root counts its steps');

  rows.length = 0;
  await assert.rejects(startTrace({ name: 'start_run', origin: 'mcp' }, () => callPackFunction(target('functions/fail.ts'), null, {}, OPTIONS)), SandboxError);
  const failed = rows.find((row) => row.name === 'run-function')!;
  assert.equal(failed.level, 'error');
  assert.equal(failed.usage['sandbox.runs'], 1);
  assert.match(String(failed.status_message), /^[A-Z_]+$/, 'the code of the failure, not its text');
});

test('calls beyond the running limit wait for a slot, in their own traces', async (t) => {
  const rows: SpanRow[] = [];
  t.after(installTraceSink({ push: (row) => rows.push(row) }));
  const calls = MAX_CONCURRENT + 2;
  await Promise.all(Array.from({ length: calls }, (_, index) => startTrace({ name: 'start_run', origin: 'mcp' }, () => callPackFunction(target('functions/echo.ts'), index, {}, OPTIONS))));
  const roots = rows.filter((row) => row.is_root);
  assert.equal(roots.length, calls);
  for (const row of roots) assert.equal(row.usage['sandbox.runs'], 1, 'one run each, whichever call freed the slot');
  assert.ok(roots.some((row) => (row.usage['sandbox.wait_ms'] ?? 0) > 0), 'someone waited for a slot');
});
