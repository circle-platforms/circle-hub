import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandTokens } from '../../../../../contracts/generated/command-grammar.ts';
import { startPostgres } from '../../../../../hub/testing/postgres.ts';
import { temporaryDirectory, writePack } from '../../../../../hub/runs/api.ts';
import { createCatalogView, osIsolationAvailable } from '../../../../../hub/rules/api.ts';
import { INDEX } from '../../../../../hub/runs/engine/store.ts';
import { call, openHub } from '../../testing/hub.ts';
import { stageRecompose } from '../../testing/stage-recompose.ts';
import { fixture as unitFixture } from '../../testing/recompose.ts';
import { knowledgeNodes, syntheticMindMap } from '../../testing/recompose-frozen.ts';
import { checkRecordTarget } from './check-record.ts';
import { submissionFor } from './submit-records.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';

type Row = { [key: string]: any };
interface Said { item: string; code: string; message: string }
const order = (rows: Said[]): Said[] => [...rows].sort((a, b) => (a.item + '\0' + a.code + '\0' + a.message < b.item + '\0' + b.code + '\0' + b.message ? -1 : 1));

const SCHEMA = 'SUBMISSION_SCHEMA_VIOLATION';
const hubSaid = (errors: Row[]): Said[] =>
  order(errors.filter((e) => e.requirement === 'record').map((e) => ({ item: e.item, code: e.code, message: e.code === SCHEMA ? String(e.path).replace(/^\/items\/\d+/, '') : e.message })));
const localSaid = (report: Awaited<ReturnType<typeof checkRecordTarget>>): Said[] =>
  order(report.problems.filter((p: Row) => p.check === 'record' || p.check === 'slots').map((p: Row) => ({ item: p.item, code: p.code, message: p.code === SCHEMA ? p.pointer : p.message })));

const method = (item: Row, sources?: string[]) => ({ kind: 'declared', text: '合成方法', sources: sources ?? [item.fields.atoms[0].reference], basis: '合成依据' });
const adapted = (atom: string, commands: string[], ref: string, action = 'parameter_change') => ({ atom, action, text: '合成改写', commands, equivalence_reason: '合成等价说明', equivalence_refs: [ref] });
const gap = { missing: '合成缺口', next_action: '合成下一步', audience: '编写模型', due: '脚本编写之前' };

test('check-record reports what the Hub validation says, for each of a set of records', { skip }, async () => {
  const postgres = await startPostgres();
  const temp = await temporaryDirectory('recompose-check-record-hub-');
  let h: Awaited<ReturnType<typeof openHub>> | undefined;
  try {
    h = await openHub(postgres);
    const f = unitFixture();
    const build = { name: 'Rel_ORBIT_10_8_0_30', family: 'ORBIT', line: '10.8', base: 'Rel_ORBIT_10_8_0_30', platform: null, built_at: null, released_at: null, sources: {}, root: f.context.root };
    const info = { root: f.context.root, composition: 'c'.repeat(64), product: 'orbit', build, produced_at: '2026-10-27T00:00:00Z', command_policy: { schema: 'command-policy@1' as const, read_only: ['/commands/show'], inverse_rules: [{ source_prefix: '/commands/widget', inverse_prefix: '/commands/no/widget', leading_parameters: 1 }] } };
    h.knowledge.builds = async () => [build];
    h.knowledge.resolveBuild = async () => build;
    h.knowledge.currentRoot = async () => info;
    h.knowledge.rootOfBuild = async () => info;
    h.knowledge.rootInfo = async () => [info];
    const view = (entries: Row[]) => createCatalogView(entries, { reference: 'tree:' + build.root + '/commands', complete: true, caseSensitive: true });
    h.knowledge.catalog = async (_root: string, _id: string, selection?: { base: string; lines: string[] }) =>
      view(selection === undefined ? f.catalog.entries : f.catalog.entries.filter((entry: Row) => selection.lines.some((line) => { const tokens = commandTokens(line); return tokens !== null && entry.words.every((word: string, index: number) => tokens[index]?.value === word && !tokens[index].quoted); })));

    const productDir = (await writePack(join(temp.path, 'product'), { id: 'orbit', version: '1.0.0', kind: 'product', title: 'ORBIT / COMET', description: 'synthetic product', files: { 'product.json': { schema: 'product@1', id: 'orbit', title: 'ORBIT', names: ['ORBIT', 'COMET'], catalogs: [{ id: 'commands@1', entry_kind: 'definition', complete: true, case_sensitive: true }], producers: [] } } })).dir;
    const product = await h.registry.publish(h.alice, productDir);
    assert.equal(product.ok, true, JSON.stringify(product));
    if (!product.ok) return;
    await h.registry.activate(h.admin, 'orbit');
    const published = await h.registry.publish(h.alice, await stageRecompose('recompose', join(temp.path, 'recompose')));
    assert.equal(published.ok, true, JSON.stringify(published));
    if (!published.ok) return;
    for (const user of [h.admin, h.alice]) await h.registry.assign(h.admin, user.id, published.version.id);

    const map = syntheticMindMap();
    const external = 'agile:mindmap:synthetic-check-record';
    h.external.put(external, { bytes: Buffer.from(map.bytes), mediaType: 'application/json' });
    const tree = (path: string) => `tree:${build.root}/commands/${path}@${'1'.repeat(64)}`;

    const scenarios: Array<{ name: string; refusedByStructure?: boolean; files: (items: Row[]) => Row[] }> = [
      { name: 'both cite their original sentences by reference', files: ([a, b]) => [{ item: a.id, method: method(a) }, { item: b.id, method: method(b) }] },
      { name: 'the first cites the original sentences by their words', files: ([a, b]) => [{ item: a.id, method: method(a, a.fields.atoms.map((atom: Row) => atom.text)) }, { item: b.id, method: method(b) }] },
      { name: 'a reference outside the run, and a tree reference of another root', files: ([a, b]) => [{ item: a.id, method: method(a, ['src:' + 'e'.repeat(64) + '/kityminder@1/n/zzz']) }, { item: b.id, method: method(b, [tree('widget/pool/add'), `tree:${'d'.repeat(64)}/commands/widget@${'2'.repeat(64)}`]) }] },
      { name: 'a missing method without a way out, and a missing slot without a proposal', files: ([a, b]) => [{ item: a.id, method: { kind: 'missing', text: '无', sources: [], basis: '无' } }, { item: b.id, method: method(b), slots: [{ atom: b.fields.atoms[1].id, knowledge_location: 'genuinely_missing', evidence: [], proposal: null }] }] },
      { name: 'a parameter change the catalog allows, and a command that was dropped', files: ([a, b]) => [{ item: a.id, method: method(a), adapted: [adapted('a1', ['widget health interval pool1 6'], tree('widget/health/interval'))] }, { item: b.id, method: method(b), adapted: [adapted('a1', [], tree('widget/pool/add'), 'structural_completion')] }] },
      { name: 'a value outside the declared range, and a command the tree does not have', files: ([a, b]) => [{ item: a.id, method: method(a), adapted: [adapted('a1', ['widget health interval pool1 999'], tree('widget/health/interval'))] }, { item: b.id, method: method(b), adapted: [adapted('a1', ['gadget frobnicate x'], tree('widget/pool/add'))] }] },
      { name: 'a placeholder left in a command, and a prerequisite the model found', files: ([a, b]) => [{ item: a.id, method: method(a), adapted: [adapted('a1', ['widget health interval <arg1:string> 5'], tree('widget/health/interval'))] }, { item: b.id, method: method(b), states: [{ atom: 'a1', state: 'missing_prerequisite', reason: '功能默认关闭', prerequisites: ['先打开功能'] }] }] },
      { name: 'a value outside the closed set of the record shape, and a conflict nobody signed', refusedByStructure: true, files: ([a, b]) => [{ item: a.id, method: method(a), slots: [{ atom: a.fields.atoms[1].id, knowledge_location: 'unspecified', evidence: [], proposal: null }] }, { item: b.id, method: method(b), states: [{ atom: 'a1', state: 'conflict', reason: '合成冲突', conflicts: ['x', 'y'], conflict_field: 'f' }], unknowns: [gap] }] },
      { name: 'a rewritten step without its reason, and a gap row with a field the shape does not have', refusedByStructure: true, files: ([a, b]) => [{ item: a.id, method: method(a), adapted: [{ atom: 'a1', action: 'parameter_change', text: '改参数', commands: ['widget health interval pool1 6'], equivalence_refs: [tree('widget/health/interval')] }] }, { item: b.id, method: method(b), unknowns: [{ ...gap, owner: '重组模型' }] }] },
    ];

    const exercised = new Set<string>();
    const sealed: Array<{ name: string; hub: unknown; local: string[] | undefined }> = [];
    for (const scenario of scenarios) {
      const started = await h.service.startRunDetailed(h.alice, { product: 'orbit', build: build.name, pack: 'recompose', inputs: { subject: { external } }, parameters: { case_depths: [1] } }, call());
      assert.equal(started.answer.call_result, 'ok', `${scenario.name}: ${JSON.stringify(started.answer.errors)}`);
      const runId = started.answer.run!.run;
      const stored = (await h.kit.store.find({ kind: 'run', key: INDEX.runId, value: runId })).items[0];
      const frozen = stored.body as Row;
      assert.equal(frozen.items.length, 2, scenario.name);

      const dir = join(temp.path, `scenario-${exercised.size}`);
      await mkdir(join(dir, 'run', 'knowledge'), { recursive: true });
      await mkdir(join(dir, 'records'));
      await writeFile(join(dir, 'run', 'run.json'), JSON.stringify(frozen));
      await writeFile(join(dir, 'run', 'knowledge', 'nodes.jsonl'), knowledgeNodes(frozen.root, runId, f.catalog.entries));
      const files = scenario.files(frozen.items);
      for (const [index, file] of files.entries()) await writeFile(join(dir, 'records', `${index}.json`), JSON.stringify(file));

      const local = await checkRecordTarget({ file: join(dir, 'records'), run: join(dir, 'run') });
      const submitted = await h.service.submitResult(h.alice, submissionFor(frozen, files, 'scripted-recomposer') as any, call());
      assert.equal(submitted.acceptance, scenario.refusedByStructure === true ? 'not_accepted' : 'accepted', `${scenario.name}: ${JSON.stringify(submitted.errors)}`);

      const hub = hubSaid(submitted.errors as Row[]);
      assert.deepEqual(localSaid(local), hub, `${scenario.name}\nlocal: ${JSON.stringify(localSaid(local), null, 1)}\nhub:   ${JSON.stringify(hub, null, 1)}`);
      assert.equal(local.ok, hub.length === 0, scenario.name);
      if (scenario.refusedByStructure !== true) sealed.push({ name: scenario.name, hub: submitted.result!.cross_item.find((c: Row) => c.requirement === 'full_set')?.statement.verdict, local: (local as Row).hub_checks?.checks });
      for (const said of hub) exercised.add(said.code);
      await rm(dir, { recursive: true, force: true });
    }
    for (const row of sealed) {
      assert.equal(row.hub, 'support', row.name);
      assert.ok(row.local?.includes('full_set'), row.name);
    }
    for (const code of ['missing_input', 'recompose.missing_without_exit', 'recompose.command_syntax', 'recompose.atom_dropped', 'recompose.candidate_signed', SCHEMA])
      assert.ok(exercised.has(code), `no scenario drew ${code} from the Hub; drew ${[...exercised].join(', ')}`);
  } finally {
    await h?.close();
    await temp.remove();
    await postgres.stop();
  }
});
