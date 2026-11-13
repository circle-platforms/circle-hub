// Request-local source reuse must preserve the deciding capture, consumer and current request's permissions.
import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { artifactShareKey, newId, withReadScope, withRequestPermissions, type ArtifactSource, type IngestInput, type Principal } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { KnowledgeContext } from './context.ts';
import { KnowledgeSpaces } from './spaces.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

async function fixture(t: TestContext) {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
  const owner = await kit.principals.createUser(admin, 'synthetic-owner');
  const other = await kit.principals.createUser(admin, 'synthetic-other');
  // Only the records port is used by source(); no product, external reader or production pipeline is involved.
  const context = { records: kit } as KnowledgeContext;
  const spaces = new KnowledgeSpaces(context, { read: async () => null, readEntry: async () => null });
  const capture = (by: Principal, session: string, bytes = Buffer.from('合成同字节来源，权限由每份捕获独立决定。'), readTier: NonNullable<IngestInput['readTier']> = 'model_readable', shareable = false) =>
    kit.artifacts.ingest({
      bytes, mediaType: 'text/plain', name: 'synthetic-source.txt', origin: { upload: { session } },
      author: { user: by.id }, provenanceType: 'declared', readTier,
      visibility: { readers: [by.id], admins: shareable, packs: [], shareable },
    });
  const artifact = await capture(owner, 'synthetic-first');
  return { kit, spaces, admin, owner, other, artifact, capture };
}

function countSources(t: TestContext, w: Awaited<ReturnType<typeof fixture>>) {
  const original = w.kit.artifacts.source.bind(w.kit.artifacts);
  const calls: Parameters<typeof original>[] = [];
  t.mock.method(w.kit.artifacts, 'source', async (...args: Parameters<typeof original>) => {
    calls.push(args);
    return original(...args);
  });
  return calls;
}

test('a clean exact capture is loaded once per request and is reloaded after that request ends', async t => {
  const w = await fixture(t), calls = countSources(t, w);
  const read = () => w.spaces.source(w.owner, w.artifact.body.sha256, undefined, 'model', w.artifact.digest);
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    const first = await read();
    assert.ok(first?.bytes);
    assert.equal(first.artifact.digest, w.artifact.digest);
    assert.deepEqual(Buffer.from(first.bytes), Buffer.from('合成同字节来源，权限由每份捕获独立决定。'));
    assert.deepEqual(await read(), first, 'reuse retains the complete deciding ArtifactSource');
    assert.equal(calls.length, 1);
  });
  assert.ok((await read())?.bytes);
  assert.ok((await read())?.bytes);
  assert.equal(calls.length, 3, 'there is no process-wide source cache outside a request');
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    assert.ok((await read())?.bytes);
    assert.ok((await read())?.bytes);
    assert.equal(calls.length, 4, 'the next request establishes its own proof');
  });
});

test('a finished permission scope cannot lend a shared source to detached work after revocation', async t => {
  const w = await fixture(t);
  const artifact = await w.capture(w.owner, 'synthetic-shared', Buffer.from('合成可撤回的共享来源。'), 'model_readable', true);
  const calls = countSources(t, w);
  const object = artifactShareKey(artifact);
  await w.kit.authorizations.share(w.admin, object, [w.other.id]);
  const read = () => w.spaces.source(w.other, artifact.body.sha256, undefined, 'model', artifact.digest);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let detached!: Promise<ArtifactSource | null>;
  await withRequestPermissions(w.kit.artifacts, w.other, async () => {
    assert.ok((await read())?.bytes);
    detached = gate.then(read);
    await w.kit.authorizations.unshare(w.admin, object, w.other.id);
    assert.ok((await read())?.bytes, 'the live request retains its start-of-request permission');
    assert.equal(calls.length, 1);
  });
  release();
  assert.equal(await detached, null, 'retained async context cannot use the ended request cache');
  assert.equal(calls.length, 2);
  await withRequestPermissions(w.kit.artifacts, w.other, async () => {
    assert.equal(await read(), null, 'the next permission snapshot observes revocation');
    assert.equal(await read(), null, 'absence does not become a cached permission decision');
  });
  assert.equal(calls.length, 4);
});

for (const readScope of [false, true]) {
  const scope = readScope ? 'a read scope and request permissions' : 'request permissions without a read scope';

  test(readScope ? `an explicit account disable retires readable source bytes inside ${scope}`
    : 'account disable reloads under frozen permission-only identity until the request ends', async t => {
    const w = await fixture(t);
    const calls = readScope ? undefined : countSources(t, w);
    const read = () => w.spaces.source(w.owner, w.artifact.body.sha256, undefined, 'model', w.artifact.digest);
    const request = () => withRequestPermissions(w.kit.artifacts, w.owner, async () => {
      assert.ok((await read())?.bytes, 'establish a successful source proof before the destructive write');
      const disabled = await w.kit.principals.setDisabled(w.admin, w.owner.id, true);
      assert.equal(disabled.disabled, true, 'the explicit write completed in this same async context');
      if (readScope) assert.equal(await read(), null, 'a disabled subject must not regain cached bytes before this request ends');
      else {
        assert.ok((await read())?.bytes, 'permission-only requests retain their start-of-request identity');
        assert.equal(calls!.length, 2, 'the destructive write clears source values, not the frozen permission snapshot');
      }
    });
    if (readScope) await withReadScope(request);
    else {
      await request();
      await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
        assert.equal(await read(), null, 'the next request must observe the disabled account');
      });
    }
  });

  test(`an explicit personal purge retires readable source bytes inside ${scope}`, async t => {
    const w = await fixture(t);
    assert.ok(w.kit.personalPayloads);
    const artifact = await w.kit.store.withTransaction(async tx => {
      const stored = await w.kit.artifacts.ingest({
        personalOwner: w.owner.id, bytes: Buffer.from('合成可清除私人原文，与独立捕获不同。'),
        mediaType: 'text/plain', name: 'synthetic-purge.txt', origin: { upload: { session: 'synthetic-purge' } },
        author: { user: w.owner.id }, provenanceType: 'declared',
        visibility: { readers: [w.owner.id], admins: false, packs: [], shareable: false },
      }, tx);
      await w.kit.store.put({
        kind: 'knowledge_space_source', schema: 'knowledge-space-source@1', provenance: 'declared',
        body: { space: w.owner.id, path: '/', sha256: stored.body.sha256, artifact: stored.digest,
          size: stored.body.size, by: w.owner.id, at: stored.created_at },
        index: [{ key: 'knowledge.space.source_hash', value: stored.body.sha256 }],
      }, tx);
      return stored;
    });
    const payloads = w.kit.personalPayloads;
    const { epoch } = await payloads.scope(w.owner.id);
    const read = () => w.spaces.source(w.owner, artifact.body.sha256, undefined, 'model', artifact.digest);
    const request = () => withRequestPermissions(w.kit.artifacts, w.owner, async () => {
      assert.ok((await read())?.bytes, 'establish the private capture proof before purge');
      await payloads.purge(w.owner, epoch);
      assert.equal(await w.kit.store.get(artifact.digest), null, 'purge really removed the logical personal capture');
      assert.equal(await w.kit.objects.get(artifact.body.sha256), null, 'no independent holder preserves these bytes');
      assert.equal(await read(), null, 'cleared private bytes must not survive in this live request cache');
    });
    if (readScope) await withReadScope(request);
    else await request();
  });
}

test('equal bytes in private captures do not share a proof across captures or actors', async t => {
  const w = await fixture(t);
  const privateOther = await w.capture(w.other, 'synthetic-second');
  assert.equal(privateOther.body.sha256, w.artifact.body.sha256);
  assert.notEqual(privateOther.digest, w.artifact.digest);
  const calls = countSources(t, w);
  const read = (by: Principal, capture: string) => w.spaces.source(by, w.artifact.body.sha256, undefined, 'model', capture);
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    assert.equal((await read(w.owner, w.artifact.digest))?.artifact.digest, w.artifact.digest);
    assert.equal(await read(w.owner, privateOther.digest), null, 'equal bytes do not authorize another private capture');
    assert.equal(await read(w.other, w.artifact.digest), null, 'a different actor cannot borrow the cached owner proof');
    await withRequestPermissions(w.kit.artifacts, w.other, async () => {
      assert.equal((await read(w.other, privateOther.digest))?.artifact.digest, privateOther.digest);
      assert.equal(await read(w.other, w.artifact.digest), null);
    });
    assert.equal((await read(w.owner, w.artifact.digest))?.artifact.digest, w.artifact.digest);
  });
  assert.equal(calls.filter(([by, , options]) => by.id === w.owner.id && options?.record === w.artifact.digest).length, 1);
  assert.ok(calls.some(([by, , options]) => by.id === w.owner.id && options?.record === privateOther.digest));
  assert.ok(calls.some(([by, , options]) => by.id === w.other.id && options?.record === w.artifact.digest));
});

test('mutating a pending source principal cannot authorize another private capture or poison the caller cache', async t => {
  const w = await fixture(t);
  const privateOther = await w.capture(w.other, 'synthetic-call-time-principal');
  assert.equal(privateOther.body.sha256, w.artifact.body.sha256);
  assert.notEqual(privateOther.digest, w.artifact.digest);
  assert.equal(await w.kit.artifacts.source(w.owner, privateOther.body.sha256, { record: privateOther.digest }), null);
  assert.ok((await w.kit.artifacts.source(w.other, privateOther.body.sha256, { record: privateOther.digest }))?.bytes);
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    const by: Principal = { id: w.owner.id, name: w.owner.name, role: w.owner.role };
    const pending = w.spaces.source(by, privateOther.body.sha256, undefined, 'model', privateOther.digest);
    by.id = w.other.id;
    by.name = w.other.name;
    by.role = w.other.role;
    const first = await pending;
    const repeated = await w.spaces.source(w.owner, privateOther.body.sha256, undefined, 'model', privateOther.digest);
    assert.deepEqual({ first, repeated }, { first: null, repeated: null },
      'authorization uses the invocation principal and the owner cache cannot retain another actor\'s private capture');
  });
});

test('a role change cannot reuse the previous role proof even for the same account and capture', async t => {
  const w = await fixture(t);
  const privateOther = await w.capture(w.other, 'synthetic-role-boundary');
  const calls = countSources(t, w);
  const elevatedInput = { ...w.owner, role: w.admin.role };
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    assert.ok((await w.spaces.source(w.owner, w.artifact.body.sha256, undefined, 'model', w.artifact.digest))?.bytes);
    assert.ok((await w.spaces.source(elevatedInput, w.artifact.body.sha256, undefined, 'model', w.artifact.digest))?.bytes);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0].role, w.owner.role);
    assert.equal(calls[1][0].role, elevatedInput.role);
    assert.equal(await w.spaces.source(elevatedInput, privateOther.body.sha256, undefined, 'model', privateOther.digest), null,
      'a supplied role never replaces the account permissions when another capture is selected');
  });
});

test('different source bytes cannot borrow another hash proof in the same request', async t => {
  const w = await fixture(t);
  const second = await w.capture(w.owner, 'synthetic-distinct', Buffer.from('合成另一份原文字节。'));
  assert.notEqual(second.body.sha256, w.artifact.body.sha256);
  const calls = countSources(t, w);
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    for (const artifact of [w.artifact, second]) {
      const first = await w.spaces.source(w.owner, artifact.body.sha256);
      const again = await w.spaces.source(w.owner, artifact.body.sha256);
      assert.equal(first?.sha256, artifact.body.sha256);
      assert.equal(first?.artifact.digest, artifact.digest);
      assert.deepEqual(again, first);
    }
    assert.equal(calls.length, 2);
  });
});

test('run-bound and unbound source reads have separate request proofs', async t => {
  const w = await fixture(t), calls = countSources(t, w);
  const firstRun = newId('run'), secondRun = newId('run');
  const read = (run?: string) => w.spaces.source(w.owner, w.artifact.body.sha256, run, 'model', w.artifact.digest);
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    for (const run of [firstRun, secondRun, undefined]) {
      assert.ok((await read(run))?.bytes);
      assert.ok((await read(run))?.bytes);
    }
    assert.equal(calls.length, 3, 'a readable direct capture still has a proof scoped to each requested run');
  });
});

test('function-only bytes cached for a function never become readable by the model', async t => {
  const w = await fixture(t);
  const artifact = await w.capture(w.owner, 'synthetic-function-only', Buffer.from('合成函数专用原文。'), 'function_bytes_only');
  const calls = countSources(t, w);
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    const read = (consumer: Parameters<KnowledgeSpaces['source']>[3]) => w.spaces.source(w.owner, artifact.body.sha256, undefined, consumer, artifact.digest);
    assert.ok((await read('function'))?.bytes);
    const withheld = await read('model');
    assert.ok(withheld);
    assert.equal(withheld.bytes, null);
    assert.equal(withheld.readTier, 'function_bytes_only');
    assert.ok((await read('function'))?.bytes);
    assert.equal(calls.length, 2);
    assert.equal((await read('model'))?.bytes, null);
    assert.equal(calls.length, 3, 'withheld bytes are not cached as a reusable successful read');
  });
});

test('a null source is retried and does not conceal a later successful read', async t => {
  const w = await fixture(t), original = w.kit.artifacts.source.bind(w.kit.artifacts);
  let calls = 0;
  t.mock.method(w.kit.artifacts, 'source', async (...args: Parameters<typeof original>) => ++calls === 1 ? null : original(...args));
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    const read = () => w.spaces.source(w.owner, w.artifact.body.sha256, undefined, 'model', w.artifact.digest);
    assert.equal(await read(), null);
    assert.ok((await read())?.bytes);
    assert.ok((await read())?.bytes);
    assert.equal(calls, 2);
  });
});

test('an exception is not cached and the next successful source can be reused', async t => {
  const w = await fixture(t), original = w.kit.artifacts.source.bind(w.kit.artifacts);
  let calls = 0;
  const failure = new Error('synthetic source load failure');
  t.mock.method(w.kit.artifacts, 'source', async (...args: Parameters<typeof original>) => {
    if (++calls === 1) throw failure;
    return original(...args);
  });
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    const read = () => w.spaces.source(w.owner, w.artifact.body.sha256, undefined, 'model', w.artifact.digest);
    await assert.rejects(read(), error => error === failure);
    assert.ok((await read())?.bytes);
    assert.ok((await read())?.bytes);
    assert.equal(calls, 2);
  });
});

const uncacheable: Array<{ name: string; change: (source: ArtifactSource) => ArtifactSource }> = [
  { name: 'acceptance', change: source => ({ ...source, acceptance: { kind: 'derived', acceptance: { sources: [] } } }) },
  { name: 'findings', change: source => ({ ...source, artifact: { ...source.artifact, body: { ...source.artifact.body,
    scan: { ...source.artifact.body.scan, clean: false, findings: [{ detector: 'synthetic-finding', offset: 0, line: 1, column: 1 }] },
  } } }) },
  { name: 'truncated scan', change: source => ({ ...source, artifact: { ...source.artifact, body: { ...source.artifact.body,
    scan: { ...source.artifact.body.scan, clean: false, truncated: true },
  } } }) },
  { name: 'uninspected scan', change: source => ({ ...source, artifact: { ...source.artifact, body: { ...source.artifact.body,
    scan: { ...source.artifact.body.scan, inspected: false, clean: false },
  } } }) },
  { name: 'null bytes', change: source => ({ ...source, bytes: null, note: '合成当前读取档位不提供字节' }) },
];

for (const { name, change } of uncacheable) test(`a source with ${name} is rechecked rather than cached`, async t => {
  const w = await fixture(t);
  const source = await w.kit.artifacts.source(w.owner, w.artifact.body.sha256, { record: w.artifact.digest });
  assert.ok(source?.bytes);
  let calls = 0;
  // Inject current port outcomes only; no altered scan, acceptance or old record is persisted.
  t.mock.method(w.kit.artifacts, 'source', async () => ({ ...change(source), note: `合成第${++calls}次取值` }));
  await withRequestPermissions(w.kit.artifacts, w.owner, async () => {
    const read = () => w.spaces.source(w.owner, w.artifact.body.sha256, undefined, 'model', w.artifact.digest);
    const first = await read(), second = await read();
    assert.ok(first && second);
    assert.equal(first.artifact.digest, w.artifact.digest);
    assert.equal(second.artifact.digest, w.artifact.digest);
    assert.equal(first.note, '合成第1次取值');
    assert.equal(second.note, '合成第2次取值');
    assert.equal(calls, 2);
  });
});
