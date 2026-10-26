// The acceptance bed: the real Hub assembled in-process (createTestHub of hub/server/testing-real.ts) with every pack of the
// repository published through the real registry, the connectors' loopback stubs serving the synthetic fixtures of
// tests/fixtures and of the packs' testing folders, one resource per system pack, the two products synced into roots, and a
// reviewer the workflow packs are assigned to. Tests talk to it only through the MCP client of support/mcp.ts (and the
// console over HTTP); records are read back through the records kit to assert what was stored.
import assert from 'node:assert/strict';
import type { ResourceRecord } from '../../../contracts/src/resources.ts';
import type { Limits } from '../../../hub/config/index.ts';
import type { SyncReport } from '../../../hub/knowledge/api.ts';
import { startStub, type AgileOptions, type StubServer } from '../../../hub/connectors/testing/api.ts';
import { createTestHub, type TestHub, type TestUser } from '../../../hub/server/testing-real.ts';
import type { TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { AGILE_ACCOUNT, ROOTS, agileOptions } from '../../fixtures/agile/index.ts';
import { manualStoreFiles } from '../../fixtures/manual-store/index.ts';
import { plmReply } from '../../fixtures/plm/index.ts';
import { oneNameProduct, productSite, productStore, twoNameProduct, SYSTEM, WORKFLOW, type ProductPack, type ProductSite, type ProductStore } from './env.ts';
import { connect, type McpClient } from './mcp.ts';

export interface BedOptions {
  postgres: TemporaryPostgres;
  /** Build-site files (default the two-name product's synthetic site). The object stays live: tests may add files later. */
  buildSite?: Record<string, { body: Uint8Array; type: string }>;
  /** Extra files of the document store (beside the shared manual-store fixture and the single-name product's store). */
  webdav?: Record<string, string>;
  agile?: AgileOptions;
  now?: () => Date;
  /** Sync the two-name product at start (default true). Options go to the sync. */
  syncTwoName?: boolean | { options?: Record<string, unknown>; includeUnreleased?: boolean };
  /** Sync the single-name product at start (default true). */
  syncOneName?: boolean;
  /** Configure the PLM resource (default true). */
  plm?: boolean;
  /** More pack directories to publish after the repository's. */
  packs?: string[];
  limits?: Partial<Limits>;
}

export interface Bed {
  hub: TestHub;
  product: ProductPack;
  second: ProductPack;
  site: ProductSite;
  store: ProductStore;
  buildSite: Record<string, { body: Uint8Array; type: string }>;
  webdav: Record<string, string>;
  plmStub: StubServer;
  /** Requests that reached the PLM write route (must stay 0). */
  plmWrites(): number;
  resources: { agile: ResourceRecord; plm: ResourceRecord | null; site: ResourceRecord; store: ResourceRecord };
  syncs: { two: SyncReport | null; one: SyncReport | null };
  /** A user the four workflow packs of the repository are assigned to. */
  reviewer: TestUser;
  /** Creates a user and assigns the given workflow packs. */
  user(name: string, packs?: string[]): Promise<TestUser>;
  connect(user: TestUser, session?: string | { sessionId?: string; traceparent?: string }): Promise<McpClient>;
  close(): Promise<void>;
}

export async function openBed(options: BedOptions): Promise<Bed> {
  const product = await twoNameProduct();
  const second = await oneNameProduct();
  const site = await productSite();
  const store = await productStore();
  const buildSite = options.buildSite ?? site.site();
  const webdav = { ...manualStoreFiles(), ...store.files(), ...(options.webdav ?? {}) };
  const hub = await createTestHub({
    postgres: options.postgres,
    agile: options.agile ?? agileOptions(),
    buildSite,
    webdav,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.packs === undefined ? {} : { packs: options.packs }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  let plmStub: StubServer | null = null;
  const clients: McpClient[] = [];
  try {
    const stubs = hub.stubs;
    assert.ok(stubs, 'the stubs run');
    let writes = 0;
    plmStub = await startStub((request) => plmReply(request, (token) => stubs.agile.tokens.has(token), () => void (writes += 1)));
    const plm = plmStub;
    const agile = await hub.addResource({
      system_pack: SYSTEM.agile,
      credentials:{username:'DEMO_PORTAL_USER',password:'DEMO_PORTAL_PASSWORD'},
      name: '合成敏捷平台',
      environment: 'test',
      origins: { 'agile-oauth': stubs.agile.origin, 'agile-api': stubs.agile.origin },
      allow_plaintext: [stubs.agile.origin],
      settings: { roots: [ROOTS.first, ROOTS.second] },
    });
    let plmResource: ResourceRecord | null = null;
    if (options.plm !== false) {
      plmResource = await hub.addResource({
        system_pack: SYSTEM.plm,
        credentials:{username:'DEMO_PORTAL_USER',password:'DEMO_PORTAL_PASSWORD'},
        name: '合成 PLM',
        environment: 'test',
        origins: { 'plm-oauth': stubs.agile.origin, 'plm-api': plm.origin },
        allow_plaintext: [stubs.agile.origin, plm.origin],
      });
    }
    await hub.setCredential(agile.id,'username',AGILE_ACCOUNT.username);
    await hub.setCredential(agile.id,'password',AGILE_ACCOUNT.password);
    const siteResource = await hub.addResource({
      system_pack: SYSTEM.site,
      name: '合成构建站',
      environment: 'test',
      origins: { 'build-site': `${stubs.buildSite.origin}${site.SITE_BASE}` },
      settings: { index_page: 'index.html' },
    });
    const storeResource = await hub.addResource({ system_pack: SYSTEM.store, name: '合成文档库', environment: 'test', origins: { 'manual-store': stubs.webdav.origin }, settings: {spec_folders:['spec']} });

    for(const active of await hub.hub.registry.activeProducts())for(const variable of active.product.variables??[])await hub.records.variables.setVariable(hub.admin.principal,variable.name,variable.default,'合成验收显式部署设置');

    const syncs: Bed['syncs'] = { two: null, one: null };
    if (options.syncTwoName !== false) {
      const sync = typeof options.syncTwoName === 'object' ? options.syncTwoName : {};
      syncs.two = await hub.knowledgeSync(product.line, { ...(sync.options ? { options: sync.options } : {}), ...(sync.includeUnreleased ? { includeUnreleased: true } : {}) });
      assert.equal(syncs.two.error, null, JSON.stringify(syncs.two).slice(0, 2000));
    }
    if (options.syncOneName !== false) {
      syncs.one = await hub.knowledgeSync(second.line);
      assert.equal(syncs.one.error, null, JSON.stringify(syncs.one).slice(0, 2000));
    }

    const user = async (name: string, packs: string[] = Object.values(WORKFLOW)): Promise<TestUser> => {
      const created = await hub.createUser(name);
      for (const pack of packs) await hub.assignPack(created.principal, pack);
      return created;
    };
    const reviewer = await user('评审人');
    return {
      hub,
      product,
      second,
      site,
      store,
      buildSite,
      webdav,
      plmStub: plm,
      plmWrites: () => writes,
      resources: { agile, plm: plmResource, site: siteResource, store: storeResource },
      syncs,
      reviewer,
      user,
      async connect(who, session) {
        const client = await connect(hub, who.token, session);
        clients.push(client);
        return client;
      },
      async close() {
        for (const client of clients) await client.close().catch(() => undefined);
        await plm.close().catch(() => undefined);
        await hub.close();
      },
    };
  } catch (error) {
    await plmStub?.close().catch(() => undefined);
    await hub.close();
    throw error;
  }
}
