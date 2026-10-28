import { labelOf } from '../../../contracts/generated/vocabulary.ts';
// Assembly insurance of the owner decision of 2026-10-22 (docs/hub-r4-tasks/no-judgment-in-hub.md): even with a key
// of the judgment service left in the vault from before the removal, the assembled Hub builds no placement client,
// nothing reads that vault entry, a knowledge sync of a product whose producer declared its path-less entries
// placeable makes no outbound call to the judgment service (every recorded call goes to a loopback stub), the entries
// stay at the root marked unplaced and the production records placement.spans 0.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { TreeRootBody } from '../../../contracts/src/knowledge.ts';
import { startBuildSiteStub, type StubServer } from '../../connectors/testing/api.ts';
import { osIsolationAvailable } from '../../rules/api.ts';
import { writePack } from '../../runs/api.ts';
import { installHtmlFixture, installXmlFixture } from '../../testing/skills.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openTestRecords } from '../../testing/records.ts';
import type { HubConfig } from '../../config/index.ts';
import { removeTree } from './files.ts';
import { assembleHub } from './hub.ts';
import { PRODUCT_PACK, SITE_PACK, productPack, sitePack, syncSiteFiles } from './test-packs.ts';

/** The vault entry the judgment service's key was read from before the removal. */
const LEGACY_ENTRY = 'jev.api-key';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

test('a legacy key in the vault buys no client and no outbound call; declared path-less entries stay unplaced at the root', async () => {
  const kit = await openTestRecords({ postgres });
  const scratch = await mkdtemp(join(tmpdir(), 'circle-hub-nojudge-'));
  const stub: StubServer = await startBuildSiteStub(syncSiteFiles());
  try {
    await kit.vault.put(LEGACY_ENTRY, 'test-only-key-left-behind-1');
    // Every read of the legacy entry is counted: the assembly and the sync must make none.
    const reads: string[] = [];
    const vault = new Proxy(kit.vault, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'has' && property !== 'getText') return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        return async (name: string, ...rest: unknown[]) => {
          if (name === LEGACY_ENTRY) reads.push(String(property));
          return (value as (n: string, ...r: unknown[]) => Promise<unknown>).call(target, name, ...rest);
        };
      },
    });
    // Every outbound call the connectors make is recorded.
    const outbound: string[] = [];
    const recordingFetch: typeof globalThis.fetch = (input, init) => {
      outbound.push(String(input));
      return globalThis.fetch(input, init);
    };
    const config: HubConfig = {
      dataDir: kit.dataDir,
      logDir: join(kit.dataDir, 'logs'),
      host: '127.0.0.1',
      port: 0,
      database: kit.database,
      keychain: { service: 'circle-hub-test', account: 'vault' },
      limits: { ...kit.config.limits },
    };
    const hub = await assembleHub(config, { ...kit, vault }, { requireOsIsolation: await osIsolationAvailable(), fetch: recordingFetch, log: () => {}, resourceCacheMs: 0, extractDir: join(scratch, 'extracted') });
    assert.ok(!('jev' in hub), 'the assembled Hub has no judgment client field');
    assert.equal(hub.knowledge.placement.model, null, 'no placer');

    const boot = await kit.principals.bootstrapAdmin('管理员');
    const admin = { id: boot.user.id, name: boot.user.name, role: boot.user.role };
    await kit.authorizations.grantPublishRight(admin, boot.user.id, '装配保险测试发布任务包');
    await installXmlFixture(hub.registry, kit, admin);
    await installHtmlFixture(hub.registry, kit, admin);
    const site = await writePack(join(scratch, SITE_PACK), await sitePack());
    const product = await writePack(join(scratch, PRODUCT_PACK), productPack('1.0.0', { unplaced: true }));
    for (const directory of [site.dir, product.dir]) {
      const outcome = await hub.registry.publish(admin, directory);
      assert.ok(outcome.ok, JSON.stringify(outcome.ok ? [] : outcome.problems).slice(0, 400));
    }
    await hub.registry.activate(admin, PRODUCT_PACK);
    await hub.connectors.admin.addResource(admin, {
      system_pack: SITE_PACK,
      name: '合成构建站',
      environment: 'test',
      origins: { 'build-site': stub.origin },
    });

    const handle = await hub.packs.productByName('DEMO');
    assert.ok(handle !== null, 'the product is published');
    const report = await hub.knowledge.syncProduct(handle, { by: admin });
    const produced = report.builds.find((build) => build.outcome === 'produced');
    assert.ok(produced?.root, JSON.stringify(report.builds.map((b) => [b.name, b.outcome, b.reason])));
    assert.ok((produced.entry_counts?.unplaced ?? 0) > 0);
    assert.ok(produced.reason.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ` ${produced.entry_counts!.unplaced} 个，留在根下`), 'the report names and counts missing tree positions');
    assert.doesNotMatch(produced.reason, /判断服务|模型归类/, 'no judgment-service wording in the report');

    // The production records no judged span; the declared path-less entries are unplaced rows at the root.
    const action = await hub.knowledge.store.latestProduction(PRODUCT_PACK, produced.name);
    assert.ok(action !== null, 'the production action is recorded');
    assert.equal(action.detail.placement?.spans, 0, 'no span was handed to any judge');
    const rootRecord = await kit.store.get(produced.composition as string);
    const body = TreeRootBody.parse(rootRecord?.body);
    assert.ok(body.unplaced.length > 0, 'the notes producer emitted path-less entries');
    for (const row of body.unplaced) {
      assert.equal(row.stopped_at, '/', 'stays at the root');
      assert.deepEqual(row.judgments, [], 'no judgment');
      assert.match(row.note, /未归位/);
    }

    assert.deepEqual(reads, [], 'nothing read the legacy vault entry');
    assert.ok(outbound.length > 0, 'the sync read the build site');
    for (const url of outbound) {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+/, `only loopback stubs are called: ${url}`);
      assert.doesNotMatch(url, /typesafe/i);
    }
  } finally {
    await stub.close();
    await kit.close();
    await removeTree(scratch);
  }
});
