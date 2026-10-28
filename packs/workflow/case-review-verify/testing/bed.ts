import { installMindmapFixture, installWorkbookFixture, installXmlFixture, installHtmlFixture } from '../../../../hub/testing/skills.ts';
import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../../../hub/connectors/testing/credentials.ts';
// The end-to-end bed of this package (tests only, not part of a pack): the real Hub packages wired as the server wires them,
// on a temporary PostgreSQL and loopback stubs serving synthetic data.
// - records kit, an admin, a pack owner with a publish right, a reviewer the workflow packs are assigned to;
// - the real pack registry publishing staged copies of every pack of this package (workflow, product and system packs), the
//   publish check included; the two product packs activated;
// - the real connectors with one resource per system pack (agile platform, PLM, build site, document store) against stubs
//   that mirror the real structures (tests/fixtures, packs/product/*/testing);
// - the real knowledge service syncing the products through the connectors (build site, document store) into roots;
// - the real runs engine with the knowledge views routed beside the connectors.
import { join } from 'node:path';
import type { PermissionRole } from '../../../../contracts/generated/vocabulary.ts';
import { createConnectors, osIsolationAvailable, type Connectors, type ConnectorLogEvent } from '../../../../hub/connectors/api.ts';
import { startAgileStub, startBuildSiteStub, startStub, startWebDavStub, type AgileStub, type StubServer } from '../../../../hub/connectors/testing/api.ts';
import { createKnowledge, createKnowledgeReader, routeKnowledgeViews, type Knowledge, type SyncReport } from '../../../../hub/knowledge/api.ts';
import type { CallContext, PacksPort } from '../../../../hub/ports.ts';
import type { Principal } from '../../../../hub/records/api.ts';

import {
  createPackRegistry,
  createPacksPort,
  createRunsService,
  createWorkflowStore,
  temporaryDirectory,
  type AdminLogEntry,
  type PackRegistry,
  type PublishOutcome,
  type RunsEngine,
} from '../../../../hub/runs/api.ts';
import type { TemporaryPostgres } from '../../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../../hub/testing/records.ts';
import { productVariableNameAvailable } from '../../../../hub/server/variables.ts';
import { AGILE_ACCOUNT, ROOTS, agileOptions } from '../../../../tests/fixtures/agile/index.ts';
import { manualStoreFiles } from '../../../../tests/fixtures/manual-store/index.ts';
import { plmReply } from '../../../../tests/fixtures/plm/index.ts';
import { SITE_BASE, famxSite } from '../../../product/famx/testing/site.ts';
import { lumenFiles } from '../../../product/lumen-api/testing/store.ts';
import { PACK_DIRECTORIES, stagePack } from '../../case-review/packaging.ts';

export const WORKFLOW_PACKS = ['case-review', 'case-review-verify'] as const;
export const PRODUCT_PACKS = ['famx', 'lumen-api'] as const;
export const SYSTEM_PACKS = ['agile-platform', 'plm', 'build-site', 'manual-store'] as const;

export interface ReviewBed {
  kit: TestRecordsKit;
  registry: PackRegistry;
  packs: PacksPort;
  connectors: Connectors;
  knowledge: Knowledge;
  service: RunsEngine;
  admin: Principal;
  owner: Principal;
  reviewer: Principal;
  publications: Record<string, PublishOutcome>;
  syncs: Record<string, SyncReport>;
  stubs: { agile: AgileStub; plm: StubServer; site: StubServer; store: StubServer };
  connectorLog: ConnectorLogEvent[];
  adminLog: AdminLogEntry[];
  /** Plain-HTTP writes the PLM stub saw (the read-only profile must never reach its write route). */
  plmWrites(): number;
  /** Stores bytes as an upload of the user and returns src:<sha256>. */
  upload(user: Principal, bytes: Uint8Array, name: string): Promise<string>;
  call(session: string | null): CallContext;
  close(): Promise<void>;
}

let traces = 1;
const traceId = (): string => `5e${(traces++).toString(16).padStart(30, '0')}`;
const principal = (user: { id: string; name: string; role: PermissionRole }): Principal => ({ id: user.id, name: user.name, role: user.role });

export async function openReviewBed(postgres: TemporaryPostgres): Promise<ReviewBed> {
  let clock = Date.parse('2026-10-22T08:00:00.000Z');
  const now = (): Date => new Date((clock += 7));
  const kit = await openTestRecords({ postgres, now });
  const temp = await temporaryDirectory('circle-hub-review-bed-');
  const opened: Array<{ close(): Promise<void> }> = [];
  try {
    const isolation = await osIsolationAvailable();
    const admin = principal((await kit.principals.bootstrapAdmin('管理员')).user);
    const owner = principal(await kit.principals.createUser(admin, '包作者'));
    const reviewer = principal(await kit.principals.createUser(admin, '评审人'));
    await kit.authorizations.grantPublishRight(admin, owner.id);

    const registry = createPackRegistry({ records: kit, extractDir: join(temp.path, 'extracted'), now, sandbox: { requireOsIsolation: isolation }, variableNameAvailable: (name, tx) => productVariableNameAvailable(kit, name, tx) });
    await installMindmapFixture(registry, kit, admin);
    await installWorkbookFixture(registry, kit, admin);
    await installXmlFixture(registry, kit, admin);
    const parsers = await installHtmlFixture(registry, kit, admin);
    const publications: Record<string, PublishOutcome> = {};
    for (const id of [...SYSTEM_PACKS, ...PRODUCT_PACKS, ...WORKFLOW_PACKS]) {
      const staged = await stagePack(PACK_DIRECTORIES[id], join(temp.path, 'staged', id));
      publications[id] = await registry.publish(owner, staged);
      if (!publications[id].ok) throw new Error(`publishing ${id} was refused: ${JSON.stringify(publications[id]).slice(0, 2000)}`);
    }
    for (const id of PRODUCT_PACKS) await registry.activate(admin, id);
    for (const active of await registry.activeProducts()) for (const variable of active.product.variables ?? []) await kit.variables.setVariable(admin, variable.name, variable.default, '合成端到端显式部署设置');
    for (const id of WORKFLOW_PACKS) await registry.assign(admin, reviewer.id, id);
    const packs = createPacksPort(registry);

    const agile = await startAgileStub(agileOptions());
    opened.push(agile);
    let writes = 0;
    const plm = await startStub((request) => plmReply(request, (token) => agile.tokens.has(token), () => void (writes += 1)));
    opened.push(plm);
    const site = await startBuildSiteStub(famxSite());
    opened.push(site);
    const store = await startWebDavStub({ ...manualStoreFiles(), ...lumenFiles() });
    opened.push(store);

    const connectorLog: ConnectorLogEvent[] = [];
    const connectors = createConnectors({ records: kit, packs, parsers, log: (event) => void connectorLog.push(event), sandbox: { requireOsIsolation: isolation }, resourceCacheMs: 0, now });
    const add = (input: Parameters<Connectors['admin']['addResource']>[1]) => addSyntheticResource(kit, packs, connectors, admin, input);
    const agileResource = await add({ system_pack: 'agile-platform', name: '合成敏捷平台', environment: 'test', origins: { 'agile-oauth': agile.origin, 'agile-api': agile.origin }, allow_plaintext: [agile.origin], settings: { roots: [ROOTS.first, ROOTS.second] } });
    const plmResource = await add({ system_pack: 'plm', name: '合成 PLM', environment: 'test', origins: { 'plm-oauth': agile.origin, 'plm-api': plm.origin }, allow_plaintext: [agile.origin, plm.origin] });
    for (const resource of [agileResource, plmResource]) {
      await setSyntheticCredential(kit, connectors, admin, resource.id, 'username', AGILE_ACCOUNT.username);
      await setSyntheticCredential(kit, connectors, admin, resource.id, 'password', AGILE_ACCOUNT.password);
    }
    await add({ system_pack: 'build-site', name: '合成构建站', environment: 'test', origins: { 'build-site': `${site.origin}${SITE_BASE}` }, settings: { index_page: 'index.html' } });
    await add({ system_pack: 'manual-store', name: '合成文档库', environment: 'test', origins: { 'manual-store': store.origin } });

    const knowledge = createKnowledge({ records: kit, parsers, packs, external: connectors.reader, jev: null, sandbox: { requireOsIsolation: isolation }, clock: now, admin });
    const syncs: Record<string, SyncReport> = {};
    for (const id of PRODUCT_PACKS) {
      const product = await packs.productById(id);
      if (product === null) throw new Error(`product ${id} is not active`);
      syncs[id] = await knowledge.syncProduct(product, { by: admin });
    }

    const adminLog: AdminLogEntry[] = [];
    const service = createRunsService({
      parsers,
      records: kit,
      workflows: createWorkflowStore(registry),
      packs,
      knowledge,
      external: routeKnowledgeViews(createKnowledgeReader(knowledge), connectors.reader),
      sandbox: { requireOsIsolation: isolation },
      now,
      adminLog: (entry) => void adminLog.push(entry),
    });
    return {
      kit,
      registry,
      packs,
      connectors,
      knowledge,
      service,
      admin,
      owner,
      reviewer,
      publications,
      syncs,
      stubs: { agile, plm, site, store },
      connectorLog,
      adminLog,
      plmWrites: () => writes,
      async upload(user, bytes, name) {
        const artifact = await kit.artifacts.ingest({
          bytes,
          mediaType: 'application/json',
          origin: { upload: { session: 'sess-upload', message: null } },
          author: { user: user.id },
          provenanceType: 'declared',
          visibility: { readers: [user.id], admins: true, packs: [], shareable: true },
          name,
        });
        return `src:${artifact.body.sha256}`;
      },
      call(session) {
        return { traceId: traceId(), sessionId: session };
      },
      async close() {
        for (const stub of opened.reverse()) await stub.close();
        await kit.close();
        await temp.remove();
      },
    };
  } catch (error) {
    for (const stub of opened.reverse()) await stub.close().catch(() => undefined);
    await kit.close();
    await temp.remove();
    throw error;
  }
}
