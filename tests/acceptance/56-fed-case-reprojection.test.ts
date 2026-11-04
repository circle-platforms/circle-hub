// Acceptance 56: a version line's seedling pointer moves and a story question still gets a definite answer.
// A reader feeds one synthetic mind map of 40 cases (case 0 declares story 033001, none declares another) before the line
// has a second seedling: once without a root and once under the first seedling. The admin then seeds the line again from a
// newer released build; seeding re-projects the existing fed cases onto the new root before it moves the pointer. A story
// index over the new build, narrowed by only= as the story workflow binds it, is complete by normalized id, and the
// story-traceability projection and checks answer both stories definitely: one case for 33001, none for 99 within the view.
// Before this change the same index refused with "40 个用例缺所查树苗的投影". Temporary PostgreSQL, synthetic data only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IndexView } from '../../contracts/src/views.ts';
import type { BuildInfo } from '../../contracts/src/product.ts';
import { completeKnowledgeView, createKnowledgeReader, formatSeedReport } from '../../hub/knowledge/api.ts';
import { produceSeedling, seedlingName, type SeedlingRoles } from '../../hub/knowledge/seedling.ts';
import { DEFAULT_SYNC, STATIC_PLAN_SOURCE, makeWorld, type World } from '../../hub/knowledge/test-support.ts';
import { startPostgres } from '../../hub/testing/postgres.ts';
import { boundView } from '../../packs/workflow/traceability/functions/test-support.ts';
import project from '../../packs/workflow/story-traceability/functions/project.ts';
import check from '../../packs/workflow/story-traceability/functions/check.ts';

const FAMX = new URL('../../packs/product/famx/', import.meta.url);
const LINE = '10.8.0';
const FIRST = 'Rel_FAMX-zx-u_10_8_1_1';
const SECOND = 'Rel_FAMX-zx-u_10_8_1_2';
const TREE_A = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
const TREE_B = '<commands><menu name="system"><item name="show"><arguments/></item><item name="reboot"><arguments/></item></menu></commands>';
/** The product's own projection; case 0 declares story 033001 and every other case declares none. */
const PROJECT = "import project from './feeding.ts'; export default function(input) { const out = project(input); for (const row of out.rows) if (row.body.schema === 'fed-case@1') row.body.stories = row.body.source.element === 'case-0' ? ['033001'] : []; return out; }";
/** Two manuals, each one paragraph under its own section path. */
const MANUALS = `
export function cli(input: any): unknown { return manual(input.slots.cli, 'cli'); }
export function app(input: any): unknown { return manual(input.slots.app, 'app'); }
function manual(slot: any, book: string): unknown {
  if (slot === null) return { entries: [], warnings: ['没有手册'] };
  const entries: any[] = [];
  for (const block of slot.model.blocks) if (block.kind === 'paragraph' && block.selector !== null) entries.push({ kind: 'definition', path: '/manual/' + book + '/' + block.path.map((p: string) => encodeURIComponent(p.toLowerCase())).join('/'), statement: block.text, data: {}, fragments: [{ slot: book, parser: 'markdown@1', selector: block.selector }], applicability: null });
  return { entries, warnings: [] };
}`;
const ROLES: SeedlingRoles = { 'command-tree': { producer: 'tree', slot: 'tree' }, 'cli-manual': { producer: 'cli', slot: 'cli' }, 'app-manual': { producer: 'app', slot: 'app' } };
const MAP = Buffer.from(JSON.stringify({ agile: { id: 'SYN-DOC' }, root: { data: { id: 'root', text: 'Synthetic zx-u 10.8' }, children: Array.from({ length: 40 }, (_, i) => ({ data: { id: `case-${i}`, autoid: `SYN-${i}`, text: `Synthetic case ${i}`, priority: 2, resource: ['functional'] }, children: [{ data: { id: `step-${i}`, text: 'system show' }, children: [{ data: { id: `expect-${i}`, text: `Synthetic expected ${i}` } }] }] })) } }));

function build(name: string, released: string, tree: string): BuildInfo {
  return { name, base: name, family: 'FAMX', line: LINE, platform: 'zx-u', built_at: released, released_at: released, sources: { tree } };
}

async function seedWorld(postgres: Awaited<ReturnType<typeof startPostgres>>): Promise<World> {
  const manifest = JSON.parse(readFileSync(new URL('pack.json', FAMX), 'utf8')) as { files: Array<{ path: string }> };
  const functions: Record<string, string> = Object.fromEntries(manifest.files.filter((file) => file.path.startsWith('functions/')).map((file) => [file.path.slice(10), readFileSync(new URL(file.path, FAMX), 'utf8')]));
  Object.assign(functions, { 'synthetic-tree.ts': "export {commandTree as default} from './producers.ts';", 'synthetic-plan.ts': STATIC_PLAN_SOURCE, 'manuals.ts': MANUALS, 'stories.ts': PROJECT });
  const w = await makeWorld(postgres, { pack: { id: 'famx', names: ['FAMX', 'FAMY'], functions, declaration: {
    sync: { ...DEFAULT_SYNC, plan: { module: 'functions/synthetic-plan.ts' }, options: { builds: [build(FIRST, '2026-10-02T00:00:00.000Z', 'site:tree:a'), build(SECOND, '2026-10-05T00:00:00.000Z', 'site:tree:b')] } },
    catalogs: [],
    producers: [
      { id: 'tree', title: '命令树', function: { module: 'functions/synthetic-tree.ts' }, inputs: { tree: { source: 'tree' } } },
      { id: 'cli', title: 'CLI 手册', function: { module: 'functions/manuals.ts', export: 'cli' }, inputs: { cli: { external: 'manual:cli:10_8' } } },
      { id: 'app', title: 'APP 手册', function: { module: 'functions/manuals.ts', export: 'app' }, inputs: { app: { external: 'manual:app:10_8' } } },
    ],
    feeding: { project: { module: 'functions/stories.ts' }, normalize_line: { module: 'functions/feeding.ts', export: 'normalizeLine' } },
  } } });
  w.external.set('site:tree:a', { bytes: TREE_A, mediaType: 'application/xml' });
  w.external.set('site:tree:b', { bytes: TREE_B, mediaType: 'application/xml' });
  w.external.set('manual:cli:10_8', { bytes: '# CLI 10.8\n\n## 首页\n\n合成 CLI 手册。\n', mediaType: 'text/markdown' });
  w.external.set('manual:app:10_8', { bytes: '# APP 10.8\n\n## 首页\n\n合成 APP 手册。\n', mediaType: 'text/markdown' });
  await w.knowledge.syncProduct(w.product, { by: w.admin });
  return w;
}

async function storyIndex(w: World, buildName: string, only: string) {
  const reader = createKnowledgeReader(w.knowledge);
  const context = { principal: w.user, run: null, purpose: '合成需求追溯' };
  const read = await completeKnowledgeView(`knowledge:index:famx:${buildName}?kind=case&key=stories&only=${only}&fields=document,node,stories,title`, context, reader, w.kit);
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const source = await w.kit.artifacts.source(w.user, read.artifacts[0].artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  return IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
}

test('after the seedling pointer moves, a story index answers definitely through story-traceability', { timeout: 600_000 }, async (t) => {
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const w = await seedWorld(postgres);
  t.after(async () => { await w.knowledge.feeding!.drain(); await w.close(); });
  const context = w.knowledge.__context;

  const first = await produceSeedling(context, w.knowledge, w.product, { line: LINE, build: FIRST, by: w.admin, basis: '合成第一棵树苗', roles: ROLES });
  assert.equal(first.ok, true, first.reason ?? '');
  assert.equal(first.pointer?.moved, true);
  assert.deepEqual([first.reprojection?.selected, first.reprojection?.originals], [0, 0], 'nothing was fed yet');

  // The reader feeds the mind map: once without a root, once under the first seedling.
  const visibility = { readers: [w.user.id], admins: true, packs: [], shareable: false };
  const ingest = (bytes: Uint8Array) => w.kit.artifacts.ingest({ bytes, mediaType: 'application/json', origin: { read: { object: 'agile:mindmap:SYN-DOC' } }, author: { user: null }, provenanceType: 'observed', visibility, readTier: 'model_readable' });
  const document = await ingest(MAP);
  const meta = await ingest(Buffer.from(JSON.stringify({ id: 'SYN-DOC', title: 'Synthetic doc', ancestors: ['rel_famx_10_8'], root: { id: 'synthetic-root', title: 'FAMX' } })));
  const layer = w.knowledge.feeding!;
  const scope = { product: 'famx', sourceRecord: document.digest, metaSource: meta.body.sha256 };
  assert.equal((await layer.observeSource(w.user, document.body.sha256, { ...scope, root: null, composition: null })).objects.length, 40);
  assert.equal((await layer.observeSource(w.user, document.body.sha256, { ...scope, root: first.root, composition: first.composition })).objects.length, 40);
  const before = await storyIndex(w, FIRST, '33001,99');
  assert.equal(before.only_complete, true, before.notes.join('\n'));

  // A newer released build seeds the line again: the fed cases are re-projected before the pointer moves.
  const second = await produceSeedling(context, w.knowledge, w.product, { line: LINE, build: SECOND, by: w.admin, basis: '合成第二棵树苗', roles: ROLES });
  assert.equal(second.ok, true, second.reason ?? '');
  assert.notEqual(second.root, first.root);
  assert.equal(second.pointer?.moved, true, second.pointer?.reason);
  assert.equal((await w.kit.pointers.get(seedlingName('famx', LINE)))?.target, second.root);
  assert.deepEqual([second.reprojection?.selected, second.reprojection?.already, second.reprojection?.originals, second.reprojection?.projected, second.reprojection_error], [40, 0, 1, 40, null]);
  const report = formatSeedReport({ ok: true, product: 'famx', pack: 'famx@1', line: LINE, build: SECOND, dry_run: false, root: second.root, seedling: second.seedling, composition: second.composition, sources: [], composition_revisions: [], pointer: null, missing: [], notes: [], reason: null, reprojection: second.reprojection, reprojection_error: null });
  assert.match(report, new RegExp(`重投影到根 ${second.root}：版本线 ${LINE.replaceAll('.', '\\.')} 现有 40 个喂入用例，已在该根 0 个；重读 1 份原件，投影 40 个`));

  // The story index the workflow binds over the new build: complete for the requested ids, nothing unknown.
  const after = await storyIndex(w, SECOND, '33001,99');
  assert.equal(after.build.root, second.root);
  assert.equal(after.unknown_entries, undefined, after.notes.join('\n'));
  assert.equal(after.only_complete, true, after.notes.join('\n'));
  assert.deepEqual(Object.keys(after.keys), ['033001']);
  assert.deepEqual([after.scope?.fed?.cases, after.scope?.fed?.projected, after.scope?.fed?.rootless], [40, 40, 0]);

  const output = project({ inputs: [boundView('stories', { stories: [{ id: '33001', status: 'synthetic' }, { id: '99', status: 'synthetic' }], unread: [] }, 'plm:stories:33001+99'), boundView('cases', after)] }) as { error?: { message: string }; items: Array<{ id: string; summary: string; fields: { coverage_complete: boolean; indexed_match_count: number; cases: Array<{ title: string }> } }>; groups: unknown[] };
  assert.equal(output.error, undefined, output.error?.message);
  const rows = Object.fromEntries(output.items.map((item) => [item.id, item]));
  assert.deepEqual([rows['33001'].fields.indexed_match_count, rows['33001'].fields.coverage_complete, rows['33001'].fields.cases.map((row) => row.title)], [1, true, ['Synthetic case 0']]);
  assert.deepEqual([rows['99'].fields.indexed_match_count, rows['99'].fields.coverage_complete], [0, true]);
  assert.match(rows['99'].summary, /无已索引用例（完整视图内）/);
  const outcomes = check({ subject: { items: output.items, context: { groups: output.groups } } }) as Array<{ verdict: string; statement: string }>;
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((outcome) => outcome.verdict === 'support'), JSON.stringify(outcomes));
});
