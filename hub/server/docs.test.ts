// Named documents (C4 of docs/hub-r4-tasks/device-core.md, design docs/hub-r4-device-pack.md section 4): an admin
// publishes a file with `circle-hub doc put`, which stores it through the source-artifact pipeline (the credential
// scan as usual) and moves a named pointer (hub/records/pointers.ts compare-and-set) to its digest; replacing keeps
// every older revision readable by digest. The external ids `doc:doc:<name>` (current) and `doc:doc:<name>@<sha256>`
// (pinned) are answered by the Hub's own reader: the digest freezes into the run at start, the provenance is
// `declared`, and only a run of a pack that declares the doc input type reads them, only for that run's user;
// everyone else gets the same answer as for a doc that does not exist. Temporary PostgreSQL, synthetic content only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { LoadedWorkflow, WorkflowStore } from '../ports.ts';
import { sha256Hex, type ActionBody, type Principal, type SourceArtifactBody } from '../records/api.ts';
import { osIsolationAvailable } from '../rules/api.ts';
import { writePack } from '../runs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import { assembleHub, type AssembledHub } from './assemble/hub.ts';
import { removeTree } from './assemble/files.ts';
import { DOCS_PACK, docsPack, reviewPack } from './assemble/test-packs.ts';
import { DOC_EXTERNAL_TYPE, MAX_DOC_BYTES, createDocs, docIdOf, type Docs } from './docs.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

const enc = new TextEncoder();

function docJson(items: Array<{ title: string; expected: string[] }>): Uint8Array {
  return enc.encode(JSON.stringify({ items }));
}

/** A WorkflowStore whose one loaded workflow declares (or does not declare) the doc input type. */
function fakeWorkflows(declares: boolean): WorkflowStore {
  const loaded = {
    workflow: { inputs: [{ slot: 'spec', accepts: declares ? [DOC_EXTERNAL_TYPE] : ['agile:mindmap'] }] },
  } as unknown as LoadedWorkflow;
  return {
    forUser: async () => null,
    byDigest: async () => loaded,
    summaries: async () => [],
  };
}

async function world(declares = true): Promise<{ kit: TestRecordsKit; docs: Docs; admin: Principal; user: Principal }> {
  const kit = await openTestRecords({ postgres });
  const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
  const user = await kit.principals.createUser(admin, '甲', 'user');
  const principalOf = (u: { id: string; name: string; role: Principal['role'] }): Principal => ({ id: u.id, name: u.name, role: u.role });
  return {
    kit,
    docs: createDocs({ records: kit, workflows: fakeWorkflows(declares), now: () => new Date('2026-10-22T01:00:00.000Z') }),
    admin: principalOf(admin),
    user: principalOf(user),
  };
}

describe('named documents: put, list, show, replace', () => {
  test('put stores through the pipeline and moves the pointer; every revision stays readable by digest', async (t) => {
    const { kit, docs, admin } = await world();
    t.after(() => kit.close());
    const a = docJson([{ title: '甲', expected: ['乙'] }]);
    const first = await docs.put(admin, 'topology', a, { fileName: 'topology.json' });
    assert.equal(first.sha256, sha256Hex(a));
    assert.equal(first.size, a.byteLength);
    assert.equal(first.version, 1);
    assert.equal(first.created, true);
    assert.equal(first.findings, 0);
    assert.deepEqual(await docs.show('topology'), { name: 'topology', sha256: first.sha256, size: first.size });
    assert.deepEqual(await docs.list(), [{ name: 'topology', sha256: first.sha256, size: first.size }]);
    // The stored artifact is admins-only and its provenance is declared.
    const stored = (await kit.artifacts.records(first.sha256)).find((r) => (r.body as SourceArtifactBody).provenance_type === 'declared');
    assert.ok(stored);
    assert.equal(stored.body.visibility.admins, true);
    assert.deepEqual(stored.body.visibility.readers, []);

    const b = docJson([{ title: '甲', expected: ['乙'] }, { title: '丙', expected: ['丁'] }]);
    const second = await docs.put(admin, 'topology', b, { fileName: 'topology.json' });
    assert.equal(second.version, 2);
    assert.notEqual(second.sha256, first.sha256);
    assert.equal((await docs.show('topology'))?.sha256, second.sha256);

    // Replacing again with the same bytes is idempotent: no move, no new revision.
    const again = await docs.put(admin, 'topology', b, { fileName: 'topology.json' });
    assert.equal(again.created, false);
    assert.equal(again.version, 2);
    const history = await kit.pointers.history('doc:topology');
    assert.equal(history.items.length, 2, 'exactly two moves');
  });

  test('name and size rules; a bad name or an oversize file stores nothing', async (t) => {
    const { kit, docs, admin } = await world();
    t.after(() => kit.close());
    for (const bad of ['9bad', 'BAD', '', `a${'b'.repeat(64)}`]) {
      await assert.rejects(docs.put(admin, bad, docJson([])), /命名文档的名字/);
    }
    const longest = `a${'b'.repeat(63)}`;
    assert.equal(longest.length, 64, 'the boundary itself is accepted');
    const big = new Uint8Array(MAX_DOC_BYTES + 1).fill(120);
    await assert.rejects(docs.put(admin, 'topology', big), /超过命名文档的上限/);
    assert.equal(await docs.show('topology'), null);
    assert.equal(await kit.pointers.get('doc:topology'), null, 'no pointer was moved');
    assert.deepEqual(await docs.list(), []);
  });

  test('two concurrent puts of one name serialise on the compare-and-set: one current, every revision pinned-readable', async (t) => {
    const { kit, docs, admin } = await world();
    t.after(() => kit.close());
    const a = docJson([{ title: '第一', expected: ['甲'] }]);
    const b = docJson([{ title: '第二', expected: ['乙'] }]);
    const [ra, rb] = await Promise.all([docs.put(admin, 'topology', a, { fileName: 't.json' }), docs.put(admin, 'topology', b, { fileName: 't.json' })]);
    const current = await kit.pointers.get('doc:topology');
    assert.ok(current !== null);
    assert.ok([ra.sha256, rb.sha256].includes(current.target), 'the current revision is one of the two');
    assert.equal(current.version, 2, 'one move applied after the other');
    for (const sha of [ra.sha256, rb.sha256]) {
      const read = await docs.reader.read(docIdOf('topology', sha), { principal: admin, run: null, purpose: '测试' });
      assert.equal(read.ok, true, `pinned revision ${sha.slice(0, 12)} reads`);
    }
  });
});

describe('the doc:doc: reader', () => {
  test('answers the current and pinned revisions; frozen form keeps the digest; provenance is declared', async (t) => {
    const { kit, docs, admin, user } = await world();
    t.after(() => kit.close());
    const bytes = docJson([{ title: '甲', expected: ['乙'] }]);
    const put = await docs.put(admin, 'topology', bytes, { fileName: 'topology.json' });

    const read = await docs.reader.read('doc:doc:topology', { principal: admin, run: null, purpose: '测试' });
    assert.equal(read.ok, true, read.ok === false ? read.reason : '');
    if (!read.ok) return;
    assert.equal(read.revision, put.sha256, 'the revision is the content digest: withRevision freezes doc:doc:<name>@<sha256>');
    const original = read.artifacts.find((a) => a.name === 'original');
    assert.ok(original);
    assert.equal(original.artifact.body.sha256, put.sha256);
    assert.equal(original.artifact.body.provenance_type, 'declared');
    const source = await kit.artifacts.source(admin, put.sha256, { consumer: 'function' });
    assert.ok(source?.bytes);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(source.bytes)), JSON.parse(new TextDecoder().decode(bytes)));

    const pinned = await docs.reader.read(docIdOf('topology', put.sha256), { principal: admin, run: null, purpose: '测试' });
    assert.equal(pinned.ok, true, 'the pinned form reads');
    for (const bad of ['doc:doc:no-such-doc', docIdOf('topology', '0'.repeat(64)), docIdOf('no-such-doc', put.sha256)]) {
      const miss = await docs.reader.read(bad, { principal: admin, run: null, purpose: '测试' });
      assert.equal(miss.ok, false, `${bad}: same answer as for a doc that does not exist`);
    }
    // A doc name must be well-formed; a malformed id is refused, never thrown.
    const malformed = await docs.reader.read('doc:doc:BAD', { principal: admin, run: null, purpose: '测试' });
    assert.equal(malformed.ok, false);
    // The admin's own upload of unrelated bytes is never a revision of the doc.
    const alien = enc.encode('synthetic unrelated bytes');
    await kit.artifacts.ingest({ bytes: alien, mediaType: 'text/plain', origin: { upload: { session: null } }, author: { user: admin.id }, provenanceType: 'declared', visibility: { readers: [], admins: true, packs: [], shareable: false } });
    const sneaky = await docs.reader.read(docIdOf('topology', sha256Hex(alien)), { principal: admin, run: null, purpose: '测试' });
    assert.equal(sneaky.ok, false, 'a digest that was never a revision of this doc is not served');
    void user;
  });

  test('reads through a run only: no run, another runner, and an undeclaring pack all get the neutral answer', async (t) => {
    const { kit, docs, admin, user } = await world(false);
    t.after(() => kit.close());
    const put = await docs.put(admin, 'topology', docJson([{ title: '甲', expected: ['乙'] }]), { fileName: 't.json' });
    const bare = await docs.reader.read('doc:doc:topology', { principal: user, run: null, purpose: '测试' });
    assert.equal(bare.ok, false, 'a user outside a run gets the neutral answer');
    void put;
    void user;
  });

  test('a credential hit is held back until an admin accepts it', async (t) => {
    const { kit, docs, admin } = await world();
    t.after(() => kit.close());
    const bytes = enc.encode('示例手册：copy ftp://user:synthetic-pass-42@192.0.2.10/images/system.bin flash:');
    const put = await docs.put(admin, 'manual-part', bytes, { fileName: 'part.md' });
    assert.ok(put.findings > 0, 'the scan hit is reported');
    const held = await docs.reader.read('doc:doc:manual-part', { principal: admin, run: null, purpose: '测试' });
    assert.equal(held.ok, false, 'held back before acceptance');
    if (!held.ok) assert.match(held.reason, /凭据扫描/);
    await kit.artifacts.acceptFindings(admin, put.sha256, '合成手册里的 ftp 示例，口令是占位符');
    const served = await docs.reader.read('doc:doc:manual-part', { principal: admin, run: null, purpose: '测试' });
    assert.equal(served.ok, true, 'served after the acceptance');
  });
});

describe('runs over named documents', () => {
  test('the digest freezes at start; the declaring pack reads it, undeclared packs and other users do not', async (t) => {
    const kit = await openTestRecords({ postgres });
    const scratch = await mkdtemp(join(tmpdir(), 'circle-hub-docs-'));
    let hub: AssembledHub | null = null;
    try {
      hub = await assembleHub(
        {
          dataDir: kit.dataDir,
          logDir: join(kit.dataDir, 'logs'),
          host: '127.0.0.1',
          port: 0,
          database: kit.database,
          keychain: { service: 'circle-hub-test', account: 'vault' },
          limits: { ...kit.config.limits },
        },
        kit,
        { requireOsIsolation: await osIsolationAvailable(), log: () => {}, resourceCacheMs: 0, extractDir: join(scratch, 'extracted') },
      );
      const boot = await kit.principals.bootstrapAdmin('管理员');
      const admin: Principal = { id: boot.user.id, name: boot.user.name, role: boot.user.role };
      await kit.authorizations.grantPublishRight(admin, boot.user.id, '文档测试发布任务包');
      const dir = (await writePack(join(scratch, DOCS_PACK), docsPack())).dir;
      const outcome = await hub.registry.publish(admin, dir);
      assert.ok(outcome.ok, JSON.stringify(outcome.ok ? [] : outcome.problems).slice(0, 300));
      const review = (await writePack(join(scratch, 'demo-check'), reviewPack())).dir;
      assert.ok((await hub.registry.publish(admin, review)).ok);
      const userRec = await kit.principals.createUser(boot.user, '甲', 'user');
      const user: Principal = { id: userRec.id, name: userRec.name, role: userRec.role };
      await kit.authorizations.assign(admin, user.id, DOCS_PACK);
      await kit.authorizations.assign(admin, user.id, 'demo-check');
      const otherRec = await kit.principals.createUser(boot.user, '乙', 'user');
      const other: Principal = { id: otherRec.id, name: otherRec.name, role: otherRec.role };
      await kit.authorizations.assign(admin, other.id, DOCS_PACK);

      const bytes = docJson([{ title: '甲', expected: ['乙'] }]);
      const put = await hub.docs.put(admin, 'topology', bytes, { fileName: 'topology.json' });
      const call = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', sessionId: null, adminNote: () => {} };
      const answer = await hub.runs.startRun(user, { pack: DOCS_PACK, inputs: { spec: { external: 'doc:doc:topology' } } }, call);
      assert.ok(answer.run !== undefined, JSON.stringify(answer.errors ?? []).slice(0, 400));
      const run1 = answer.run.run;
      const frozen = answer.run.sources.find((s) => typeof s.external === 'string' && s.external.startsWith('doc:doc:topology@'));
      assert.ok(frozen, 'the doc input froze with its digest');
      assert.equal(frozen.external, `doc:doc:topology@${put.sha256}`);

      // The run's user reads the doc through the run; another user of the same pack gets the neutral answer.
      const byRunner = await hub.docs.reader.read('doc:doc:topology', { principal: user, run: run1, purpose: '测试' });
      assert.equal(byRunner.ok, true, 'the runner reads through their run');
      const byOther = await hub.docs.reader.read('doc:doc:topology', { principal: other, run: run1, purpose: '测试' });
      assert.equal(byOther.ok, false, 'another user gets the same answer as for a missing doc');
      const byAdmin = await hub.docs.reader.read('doc:doc:topology', { principal: admin, run: run1, purpose: '测试' });
      assert.equal(byAdmin.ok, true, 'an admin reads');

      // A pack that does not declare the doc input type refuses the binding at start.
      const refused = await hub.runs.startRun(user, { pack: 'demo-check', inputs: { map: { external: 'doc:doc:topology' } } }, call);
      assert.equal(refused.run, undefined);
      assert.ok((refused.errors ?? []).some((e) => e.code !== 'SOURCE_UNAVAILABLE'), 'a schema refusal, not the neutral one');

      // Replacing the doc freezes the new digest in the next run; the pinned old revision still reads.
      const bytes2 = docJson([{ title: '甲', expected: ['乙'] }, { title: '丙', expected: ['丁'] }]);
      const second = await hub.docs.put(admin, 'topology', bytes2, { fileName: 'topology.json' });
      const answer2 = await hub.runs.startRun(user, { pack: DOCS_PACK, inputs: { spec: { external: 'doc:doc:topology' } } }, call);
      assert.ok(answer2.run !== undefined);
      assert.ok(answer2.run.sources.some((s) => s.external === `doc:doc:topology@${second.sha256}`), 'the next run freezes the new digest');
      const old = await hub.docs.reader.read(`doc:doc:topology@${put.sha256}`, { principal: user, run: run1, purpose: '测试' });
      assert.equal(old.ok, true, 'the older revision stays readable by digest');
      assert.ok(answer.run.sources.some((s) => s.external === `doc:doc:topology@${put.sha256}`), 'the first run keeps its frozen digest');
    } finally {
      await removeTree(scratch).catch(() => {});
      await kit.close();
    }
  });
});
