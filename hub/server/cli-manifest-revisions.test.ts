import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { ExecutorRegistry } from '../dispatch/api.ts';
import { definition } from '../dispatch/testing/definition.ts';
import type { WorkflowStore } from '../ports.ts';
import { sha256Hex } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { docCommand } from './cli-admin.ts';
import { executorCommand } from './cli-job.ts';
import type { Session } from './cli-session.ts';
import { createDocs } from './docs.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

async function fixture(t: TestContext) {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
  const docs = createDocs({ records: kit, workflows: {} as WorkflowStore });
  const lines: string[] = [];
  const session = {
    records: async () => kit, admin: async () => admin, viewer: async () => admin, ctx: { io: { cwd: kit.dataDir } }, options: {},
    hub: async () => ({ docs, records: kit, dispatch: null, executorRegistry: registry }),
    out: (text: string) => lines.push(text), err: (text: string) => lines.push(text),
  };
  const put = async (content: string) => {
    lines.length = 0;
    await writeFile(join(kit.dataDir, 'inventory.json'), content);
    assert.equal(await docCommand(session as unknown as Session, ['put', 'synthetic-inventory', 'inventory.json']), 0);
    return [...lines];
  };
  const [a, b, c] = ['{"revision":1}', '{"revision":2}', '{"revision":3}'];
  const registry = new ExecutorRegistry(kit);
  const base = { ...definition('http://127.0.0.1:9/mcp'), credential: '${secret:DEMO_KEY}' };
  const add = async (manifest: string, enabled = true) => (await registry.add(admin, { ...base, enabled, manifest_sha256: manifest })).id;
  await kit.variables.setVariable(admin, 'DEMO_INVENTORY', sha256Hex(b), '合成清单修订');
  return { session, lines, put, a, b, c, older: await add(sha256Hex(a)), previous: await add('${var:DEMO_INVENTORY}'), literal: await add(sha256Hex(b)), disabled: await add(sha256Hex(b), false), current: await add(sha256Hex(c)) };
}

test('doc put lists only enabled executors whose resolved manifest is the revision just replaced', async t => {
  const f = await fixture(t);
  assert.equal((await f.put(f.a)).length, 1);
  await f.put(f.b);
  const lines = await f.put(f.c);
  const warnings = lines.slice(1);
  assert.equal(warnings.length, 2);
  for (const id of [f.previous, f.literal]) assert.ok(warnings.some(line => line.includes(id)));
  for (const id of [f.older, f.current, f.disabled]) assert.ok(warnings.every(line => !line.includes(id)));
  for (const line of warnings) {
    assert.match(line, /命名文档 synthetic-inventory 的旧修订/);
    assert.match(line, /现行修订.*重新登记/);
  }
  assert.equal((await f.put(f.c)).length, 1);
});

test('executor list names historical document revisions, including resolved variables, on enabled and disabled executors', async t => {
  const f = await fixture(t);
  for (const content of [f.a, f.b, f.c]) await f.put(content);
  f.lines.length = 0;
  assert.equal(await executorCommand(f.session, ['list']), 0);
  const warnings = f.lines.filter(line => line.includes('命名文档 synthetic-inventory 的旧修订'));
  assert.equal(warnings.length, 4, f.lines.join('\n'));
  for (const id of [f.older, f.previous, f.literal, f.disabled]) assert.ok(warnings.some(line => line.includes(id)));
  assert.ok(warnings.every(line => !line.includes(f.current)));
  assert.ok(f.lines.some(line => line.includes(f.disabled) && line.includes('启用 0')));
  await f.put(f.b);
  f.lines.length = 0;
  assert.equal(await executorCommand(f.session, ['list']), 0);
  const restored = f.lines.filter(line => line.includes('命名文档 synthetic-inventory 的旧修订'));
  assert.equal(restored.length, 2);
  for (const id of [f.older, f.current]) assert.ok(restored.some(line => line.includes(id)));
});

test('a successful document replacement stands when the executor registry cannot be read', async t => {
  const f = await fixture(t);
  await f.put(f.a);
  t.mock.method(ExecutorRegistry.prototype, 'sources', async () => { throw new Error('synthetic unreadable registry'); });
  const lines = await f.put(f.b);
  assert.match(lines[0], /已发布命名文档 synthetic-inventory/);
  assert.match(lines[1], /有执行器的登记未能核对/);
  assert.equal((await f.put(f.b)).length, 1);
});
