// Writes tests/fixtures/frozen/upgrade-records.json: the records database and object bytes that the Hub before the operation lease binding
// (the tree of aecc1a9, the parent of the lease work) leaves after one knowledge-contribution run with a legacy operation
// record. Run once by hand against an extracted old tree whose node_modules points at this checkout's:
//   git archive <old revision> | tar -x -C <dir> && ln -s "$PWD/node_modules" <dir>/node_modules
//   node hub/knowledge/testing/frozen/generate-upgrade-records.ts <dir> <old revision>
// Only the old tree's code writes the records; this checkout supplies the temporary PostgreSQL and reads the result back.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Database, createPool } from '../../../records/db.ts';
import { startPostgres } from '../../../testing/postgres.ts';
import { FROZEN_KNOWLEDGE_CONTRIBUTION } from './knowledge-contribution.ts';
import { UPGRADE_BUILD, UPGRADE_CALL, UPGRADE_ECHO, dumpRecords } from './upgrade-records.ts';

const oldTree = process.argv[2];
const revision = process.argv[3];
if (oldTree === undefined || revision === undefined) throw new Error('usage: generate-upgrade-records.ts <extracted old tree> <its revision>');
// Old modules are loaded at run time from the extracted tree, so their types are not known here.
const load = async (path: string): Promise<any> => import(pathToFileURL(join(oldTree, path)).href);
const support = await load('hub/knowledge/test-support.ts');
const engine = await load('hub/runs/engine/api.ts');
const workflowsModule = await load('hub/runs/engine/testing/workflows.ts');
const parsers = await load('hub/testing/parsers.ts');
const runsApi = await load('hub/runs/api.ts');

const postgres = await startPostgres();
try {
  const w = await support.makeWorld(postgres);
  try {
    w.external.set(UPGRADE_BUILD.sources.tree, { bytes: new TextEncoder().encode(support.catalogXml(support.BASE_CATALOG)), mediaType: 'application/xml' });
    const produced = await w.knowledge.produceTree({ product: w.product, build: UPGRADE_BUILD });
    if (!produced.ok) throw new Error(`old Hub could not produce the tree: ${produced.reason}`);
    const workflows = new workflowsModule.FakeWorkflowStore();
    const oldPack = await workflows.add(join(oldTree, 'packs/workflow/knowledge-contribution'));
    if (oldPack.pack.digest !== FROZEN_KNOWLEDGE_CONTRIBUTION.digest) throw new Error(`the old tree's pack is not ${FROZEN_KNOWLEDGE_CONTRIBUTION.ref} as frozen here`);
    const service = engine.createRunsService({ records: w.kit, packs: w.packs, knowledge: w.knowledge, external: w.external, workflows, parsers: parsers.createTestParserRegistry() });
    const visibility = { readers: [w.admin.id], admins: true, packs: [], shareable: false };
    const origin = { upload: { session: UPGRADE_CALL.sessionId, message: null } };
    const manifest = await w.kit.artifacts.ingest({ bytes: new TextEncoder().encode(JSON.stringify({ items: [{ id: 'assertion', title: 'assertion' }] })), mediaType: 'application/json', origin, author: { user: w.admin.id }, provenanceType: 'declared', visibility });
    const captured = await w.kit.artifacts.ingest({ bytes: new TextEncoder().encode(UPGRADE_ECHO), mediaType: 'text/plain', origin, author: { user: w.admin.id }, provenanceType: 'client_captured', visibility });
    const composition = await w.knowledge.store.composition(produced.composition);
    const tree = composition.sources[0].sha256;
    const started = await service.startRun(w.admin, { pack: 'knowledge-contribution', product: 'Acme', build: UPGRADE_BUILD.name, inputs: { subject: { reference: `src:${manifest.body.sha256}` }, originals: [{ reference: `src:${tree}` }, { reference: `src:${captured.body.sha256}` }] } }, UPGRADE_CALL);
    if (started.call_result !== 'ok') throw new Error(`old Hub refused the run: ${JSON.stringify(started.errors)}`);
    const run = (await service.getRun(w.admin, started.run.run)).run;
    const quoted = { reference: `src:${captured.body.sha256}/text@1/l/1`, quote: '合成旧回显' };
    const submission = {
      run: run.run, model: 'integration-synthetic@1',
      items: [{ item: 'assertion', handling: 'handled', slots: { contribution: [{ code: 'assertion', text: '冻结旧记录', data: {
        root: produced.root, path: '/commands/system/show', source: quoted,
        feeding: { schema: 'fed-observation@1', product: run.product, root: produced.root, path: '/commands/system/show', source: { system: 'upload', bytes: captured.body.sha256 }, action: '冻结旧操作', result: { reference: quoted.reference, text: quoted.quote } },
      } }] } }],
    };
    const accepted = await service.submitResult(w.admin, submission, UPGRADE_CALL);
    if (accepted.acceptance !== 'accepted') throw new Error(`old Hub refused the result: ${JSON.stringify(accepted.errors)}`);
    const receipt = accepted.result.contributions.stored[0];
    const view = await w.knowledge.layers.contributions.readView(receipt.record, w.admin);
    const db = new Database(createPool(w.kit.database, 1));
    let dump;
    try {
      dump = await dumpRecords(db, w.kit.objects);
    } finally {
      await db.end();
    }
    const fixture = {
      written_by: { revision, pack: `${oldPack.pack.id}@${oldPack.pack.version}`, pack_digest: runsApi.manifestDigest(oldPack.manifest) },
      principals: { admin: w.admin.id, user: w.user.id, outsider: w.outsider.id },
      product: { digest: w.product.digest },
      root: produced.root,
      run: run.run,
      submission,
      result: accepted.result,
      receipt: receipt.record,
      view,
      ...dump,
    };
    await writeFile(fileURLToPath(new URL('../../../../tests/fixtures/frozen/upgrade-records.json', import.meta.url)), `${JSON.stringify(fixture, null, 1)}\n`);
  } finally {
    await w.close();
  }
} finally {
  await postgres.stop();
}
