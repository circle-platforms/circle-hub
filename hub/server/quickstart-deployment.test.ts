// The quickstart deployment definition is one shared byte sequence: the checked-in example file and the JSON fences
// in docs/quickstart.md and docs/quickstart.en.md. The [PG] case applies those exact bytes on a temporary Hub and
// runs start_run as the assigned account.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyDeployment, parseDeployment } from './cli-apply.ts';
import { terminalSafe } from './assemble/terminal.ts';
import type { Session } from './cli-session.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLE = join(ROOT, 'docs/examples/quickstart-deployment.json');

function fenceJson(markdown: string, label: string): string {
  const match = /```json\n([\s\S]*?)\n```/.exec(markdown);
  assert.ok(match, `${label} must contain a json fence with the deployment definition`);
  return `${match[1]}\n`;
}

test('quickstart example parses as deployment@2 and matches both quickstart doc fences', () => {
  const fileText = readFileSync(EXAMPLE, 'utf8');
  assert.equal(fileText.endsWith('\n'), true, 'example file ends with a newline');
  const parsed = parseDeployment(JSON.parse(fileText));
  assert.equal(parsed.schema, 'deployment@2');
  assert.equal(parsed.packs.length, 1);
  assert.equal(parsed.packs[0]?.ref, 'test-bed@1.3.3');
  assert.equal(parsed.packs[0]?.directory, '../../packs/workflow/test-bed');
  assert.deepEqual(parsed.workflowAssignments, [{ pack: 'test-bed', user: 'admin' }]);
  assert.deepEqual(parsed.knowledgeSync, []);
  assert.equal(parsed.documents[0]?.name, 'bed-topology');

  const zh = fenceJson(readFileSync(join(ROOT, 'docs/quickstart.md'), 'utf8'), 'docs/quickstart.md');
  const en = fenceJson(readFileSync(join(ROOT, 'docs/quickstart.en.md'), 'utf8'), 'docs/quickstart.en.md');
  assert.equal(zh, fileText, 'Chinese quickstart fence must match docs/examples/quickstart-deployment.json');
  assert.equal(en, fileText, 'English quickstart fence must match docs/examples/quickstart-deployment.json');
});

test('[PG] quickstart example apply then start_run facts as the assigned admin account', { timeout: 180_000 }, async (t) => {
  const { createTestHub } = await import('./testing-real.ts');
  const fileText = readFileSync(EXAMPLE, 'utf8');
  const input = JSON.parse(fileText);
  const hub = await createTestHub({
    repositoryPacks: false,
    mindmapSkill: false,
    workbookSkill: false,
    xmlSkill: false,
    htmlSkill: false,
    stubs: false,
  });
  t.after(() => hub.close());

  // Definition assigns by exact name "admin"; createTestHub's bootstrap admin is named 管理员.
  const assigned = await hub.createUser('admin');
  const output: string[] = [];
  const session = {
    ctx: { io: { cwd: dirname(EXAMPLE), env: {}, stdout: (line: string) => output.push(line) } },
    options: {},
    config: () => ({ ...hub.records.config, database: hub.records.database, host: '127.0.0.1', port: hub.port }),
    admin: async () => hub.admin.user,
    viewer: async () => hub.admin.user,
    records: async () => hub.records,
    hub: async () => hub.hub,
    leases: async () => hub.leases,
    out: (line: string) => output.push(terminalSafe(line)),
    err: (line: string) => output.push(terminalSafe(line)),
  } as unknown as Session;

  const report = await applyDeployment(session, input, dirname(EXAMPLE));
  assert.deepEqual(report.differences, []);
  assert.ok(report.created > 0, `apply must create at least the pack, document and assignment; got ${report.created}; log: ${output.join('\n').slice(0, 800)}`);
  assert.equal(await hub.records.authorizations.canUse(assigned.user.id, 'test-bed'), true);
  assert.equal((await hub.hub.docs.show('bed-topology'))?.sha256, input.documents[0].sha256);

  const client = await hub.client(assigned.token);
  t.after(() => client.close());
  const raw = await client.call('start_run', {
    pack: 'test-bed',
    inputs: { inventory: { external: 'doc:doc:bed-topology' } },
    parameters: { action: 'facts' },
  });
  assert.equal(raw.isError, false, JSON.stringify(raw.structuredContent).slice(0, 800));
  const out = raw.structuredContent as { call_result?: string; run?: { run?: string }; result?: { reference?: string } };
  assert.equal(out.call_result, 'ok');
  assert.ok(out.run?.run?.startsWith('run_'), `expected run id, got ${out.run?.run}`);
  assert.ok(out.result?.reference?.startsWith('rec:'), `expected result reference, got ${out.result?.reference}`);
});
