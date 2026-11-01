// The check of a publication (pack publish --dry-run): the steps of publish up to its first write. A passing check leaves
// every record, decision, object and extracted tree as it was; check and publish refuse the same inputs by the same rules;
// a product pack's variable names are checked without being claimed; a check of content already published names that
// version, and the version it compares with is the one in use.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { RECORD_KINDS } from '../../../contracts/generated/protocol.ts';
import type { Principal } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { packChanges } from './changes.ts';
import { editJson, productPack, withFiles, workflowPack, type PackDescription } from './testing/builder.ts';
import { openPackTestbed, type PackTestbed } from './testing/setup.ts';
import type { PublishCheck, PublishOutcome } from './types.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

async function testbed(t: { after: (fn: () => Promise<void>) => void }): Promise<PackTestbed> {
  const bed = await openPackTestbed({ postgres });
  t.after(() => bed.close());
  return bed;
}

type Json = Record<string, any>;

/** Every record by kind, every decision and the extraction directory's entries: what a check leaves as it was. */
async function snapshot(bed: PackTestbed): Promise<string> {
  const counts: Record<string, number> = {};
  for (const kind of RECORD_KINDS) counts[kind] = (await bed.kit.store.list({ kind, limit: 500 })).items.length;
  const decisions = (await bed.kit.authorizations.history({ limit: 500 })).items.map((item) => item.digest);
  const extracted = (await readdir(bed.extractDir).catch(() => [] as string[])).sort();
  return JSON.stringify({ counts, decisions, extracted });
}

const rules = (outcome: PublishOutcome | PublishCheck): string[] => (outcome.ok ? [] : outcome.problems.map((p) => p.rule));

test('a passing check stores nothing, and the publication after it stores what publish always did', async (t) => {
  const bed = await testbed(t);
  const written = await bed.write(workflowPack());
  const before = await snapshot(bed);
  const checked = await bed.registry.check(bed.alice, written.dir);
  assert.ok(checked.ok, JSON.stringify(rules(checked)));
  assert.equal(checked.manifest.id, 'demo-review');
  assert.equal(checked.manifest.version, '1.0.0');
  assert.equal(checked.existing, null);
  assert.equal(checked.current, null, 'nobody published this pack id yet');
  assert.equal(checked.report.samples.passed, 4, 'the samples ran, in the sandbox where the checks have functions');
  assert.equal(await snapshot(bed), before, 'no record, no decision and no extracted tree');
  for (const file of checked.manifest.files) assert.equal(await bed.kit.objects.has(file.sha256), false, file.path);
  assert.equal(await bed.kit.objects.has(checked.digest), false, 'not even the manifest');
  assert.equal(await bed.kit.authorizations.ownerOf('demo-review'), null, 'a check makes nobody the owner');
  assert.equal(await bed.registry.getPack('demo-review'), null);

  const published = await bed.registry.publish(bed.alice, written.dir);
  assert.ok(published.ok && published.created);
  assert.equal(published.version.digest, checked.digest);
  assert.deepEqual(published.report.samples, checked.report.samples);
  const again = await bed.registry.check(bed.alice, written.dir);
  assert.ok(again.ok);
  assert.equal(again.existing?.digest, checked.digest, 'the same content names the version already published');
  assert.equal(again.current?.version, '1.0.0');
});

test('check and publish refuse the same inputs by the same rules, and a refused check writes nothing either', async (t) => {
  const bed = await testbed(t);
  const both = async (label: string, by: Principal, pack: PackDescription, answerRequests: string[] = []): Promise<string[]> => {
    const dir = (await bed.write(pack)).dir;
    const before = await snapshot(bed);
    const checked = await bed.registry.check(by, dir, { answerRequests });
    assert.equal(await snapshot(bed), before, `${label}: the check wrote nothing`);
    const published = await bed.registry.publish(by, dir, { answerRequests });
    assert.ok(!checked.ok && !published.ok, label);
    assert.deepEqual(rules(checked), rules(published), label);
    assert.deepEqual(checked.report?.failures.map((f) => f.sample) ?? null, published.report?.failures.map((f) => f.sample) ?? null, label);
    return rules(checked);
  };
  assert.deepEqual(await both('no right', bed.carol, workflowPack()), ['publish.no_right']);
  await bed.publish(bed.alice, workflowPack());
  assert.deepEqual(await both('not the owner', bed.bob, workflowPack({ version: '1.1.0' })), ['publish.not_owner']);
  assert.deepEqual(await both('version reused', bed.alice, workflowPack({ title: '改了标题' })), ['publish.version_reused']);
  assert.deepEqual(await both('kind changed', bed.alice, { ...productPack({ pack: 'demo-review' }), version: '3.0.0' }), ['publish.kind_changed']);
  const failing = editJson<Json>(workflowPack({ version: '1.1.0' }), 'samples/negative/titles-bad.json', (s) => void (s.expect[0].code = 'core.structure.cardinality'));
  assert.deepEqual(await both('failing sample', bed.alice, failing), ['publish.sample_failed']);
  assert.ok((await both('unsampled', bed.alice, withFiles(workflowPack({ version: '1.1.0' }), { 'samples/negative/titles-bad.json': null }))).includes('publish.unsampled'));
  const invalid = editJson<Json>(workflowPack({ version: '1.1.0' }), 'requirements.json', (r) => void r.requirements[0].checks.push('ghost'));
  assert.ok((await both('invalid', bed.alice, invalid)).includes('requirements.unknown_check'));
  assert.deepEqual(await both('unknown request', bed.alice, workflowPack({ version: '1.1.0' }), ['f'.repeat(64)]), ['publish.answer_request']);
  await bed.registry.retire(bed.admin, 'demo-review', '1.0.0');
  assert.deepEqual(await both('withdrawn', bed.alice, workflowPack()), ['publish.version_withdrawn']);
  await bed.kit.principals.setDisabled(bed.admin, bed.alice.id, true);
  assert.deepEqual(await both('disabled account', bed.alice, workflowPack({ version: '1.2.0' })), ['publish.account']);
});

test('a product pack\'s variable names are checked under the publication\'s locks and never claimed by a check', async (t) => {
  const bed = await testbed(t);
  const registry = bed.second({ variableNameAvailable: async () => true });
  const source = (id: string) => editJson<Json>(productPack({ id }), 'product.json', (p) => {
    p.variables = [{ name: 'DEMO_CHECKED', description: 'Synthetic options', schema: { type: 'array', items: { type: 'string' } }, default: [] }];
    p.producers[0].params = { options: '${var:DEMO_CHECKED}' };
  });
  const first = (await bed.write(source('demo-first'))).dir;
  const second = (await bed.write(source('demo-second'))).dir;
  assert.ok((await registry.check(bed.alice, first)).ok);
  assert.ok((await registry.check(bed.alice, second)).ok, 'a check claimed no name');
  assert.ok((await registry.publish(bed.alice, first)).ok);
  const taken = await registry.check(bed.alice, second);
  assert.ok(!taken.ok);
  assert.equal(taken.problems[0].rule, 'variables.unavailable');
  assert.deepEqual(rules(taken), rules(await registry.publish(bed.alice, second)));
  // Without the deployment-name port the check says what the publication would.
  const unwired = await bed.registry.check(bed.alice, (await bed.write(source('demo-third'))).dir);
  assert.ok(!unwired.ok);
  assert.match(unwired.problems[0].message, /端口/);
});

test('a check compares the new version with the version in use, file by file', async (t) => {
  const bed = await testbed(t);
  await bed.publish(bed.alice, workflowPack());
  const base = workflowPack({ version: '1.1.0' });
  // One file changed, one sample moved to another path (removed and added), one sample added.
  const next = withFiles(base, {
    'SKILL.md': '# 合成规程\n\n改过的说明。\n',
    'samples/positive/codes-good.json': null,
    'samples/positive/codes-moved.json': base.files['samples/positive/codes-good.json'],
    'samples/positive/titles-more.json': { id: 'titles_more', source: 'author', check: 'titles', subject: { items: [{ id: 'a', fields: { title: '另一个标题' } }] }, expect: [{ verdict: 'support', item: 'a' }] },
  });
  const checked = await bed.registry.check(bed.alice, (await bed.write(next)).dir);
  assert.ok(checked.ok, JSON.stringify(rules(checked)));
  assert.equal(checked.current?.version, '1.0.0');
  assert.deepEqual(packChanges(checked.current!.manifest, checked.manifest), [
    { path: 'SKILL.md', change: 'modified' },
    { path: 'samples/positive/codes-good.json', change: 'removed' },
    { path: 'samples/positive/codes-moved.json', change: 'added' },
    { path: 'samples/positive/titles-more.json', change: 'added' },
  ]);
  assert.deepEqual(packChanges(checked.manifest, checked.manifest), [], 'a version does not differ from itself');
});
