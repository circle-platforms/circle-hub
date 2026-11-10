// A satisfied plan run as the Hub exports it, for the tests of the tools that read one (assemble-delivery, download-returns).
// Synthetic only: the generation fixture's one plan, repeated for each case named.
import REQUIREMENTS from '../requirements.json' with { type: 'json' };
import { canonicalJson } from '../functions/canonical-json.ts';
import { GENERATOR, generateWorkbookSet } from '../functions/generate.ts';
import { sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { satisfiedRecipes } from '../tools/generate-workbook.ts';
import { generationFixture } from './workbook.ts';

export interface PlanRunFixture { run: string; autoids: string[]; exclude: string[]; pause?: string; contract: Uint8Array; profile: Uint8Array; inventory: Uint8Array; predecessor: string; recomposed: string }
/** A satisfied plan run over `autoids`, as the Hub exports it, with `exclude` frozen in its parameters; `pause` varies the plan (another authored round). */
export function planRunFixture({ run, autoids, exclude, pause, contract, profile, inventory, predecessor, recomposed }: PlanRunFixture) {
  const recipe = generationFixture();
  if (pause) recipe.slots.steps[2] = { ...recipe.slots.steps[2], args: [pause] };
  const items = autoids.map((autoid) => ({ id: `case-${autoid}`, fields: { ...recipe.fields, autoid, title: `合成用例 ${autoid.slice(-3)}`, path: ['合成文档', '合成分组', `合成用例 ${autoid.slice(-3)}`], steps: [{ text: '合成步骤', expected: ['合成期望'] }] } }));
  const submission = { run, model: 'synthetic-model', items: items.map((item) => ({ item: item.id, handling: 'handled', slots: { plan: [{ data: recipe.slots }] } })) };
  const record = { run, pack: 'case-compile', predecessor, pack_digest: 'b'.repeat(64), root: (recipe.fields.command_catalog as { root: string }).root, build: recipe.build, parameters: { exclude }, items, requirements: REQUIREMENTS.requirements.map((v) => ({ key: v.key, accepted_producer: v.accepted_producer })), sources: [...Object.entries({ contract, profile, inventory }).map(([slot, bytes]) => ({ slot, role: 'expected', reference: `src:${sha256(bytes)}` })), { slot: 'recomposition_result', role: 'expected', reference: recomposed }] };
  const result = { schema: 'validation@1', run, submission: sha256(canonicalJson(submission)), acceptance: 'accepted', errors: [], locks: { pack: GENERATOR, pack_digest: record.pack_digest, root: record.root }, coverage: { complete: true, examined: items.length, total: items.length }, partitions: { delivered: items.map((item) => ({ item: item.id, requirements: REQUIREMENTS.requirements.map((v) => ({ requirement: v.key, status: v.key === 'workbook_verified' ? 'unresolved' : 'satisfied', claims: v.key === 'commands_known' ? [{ statement: { verdict: 'support', data: { command_catalog: recipe.fields.command_catalog } } }] : v.key === 'contract_methods' ? [{ statement: { verdict: 'support', data: { runtime_version: recipe.contract.runtimeVersion, contract_sha256: recipe.contract.pinned.identity } } }] : [] })) })) } };
  const workbook = generateWorkbookSet(satisfiedRecipes({ run: record, result, submission, contract, profile, inventory }));
  return { record, result, submission, workbook };
}
