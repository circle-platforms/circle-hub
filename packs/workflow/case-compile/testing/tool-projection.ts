import assert from 'node:assert/strict';
import { projectItems } from '../functions/project.ts';
import { CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC } from '../functions/test-support.ts';
import projectRecompose from '../recompose/functions/project.ts';
import recompose from '../recompose/pack.json' with { type: 'json' };
import { DEFAULT_DOCS } from '../tools/open-compile.ts';
import { boundRecord } from './late-binding.ts';
import { mindmapSubject } from './parsed-mindmap.ts';

type Row = Record<string, any>;
const recomposeRun = 'run_01recomposerecompose00';
const SUBJECT = 'agile:mindmap:900001';
export function compileMindmap(autoids: string[]) {
  return mindmapSubject(autoids.map((autoid, i) => ({
    id: String(i + 1), autoid, title: `合成用例 ${i + 1}`, step: '检查状态', expect: '状态正确',
  })));
}

export function compileProjection(autoids: string[], extra: Record<string, Row> = {}) {
  const subject = compileMindmap(autoids);
  const documents: Record<string, Row> = {
    [SUBJECT]: { ...subject, external: SUBJECT }, [`src:${subject.sha256}`]: subject,
    [DEFAULT_DOCS.contract]: { model: CONTRACT_DOC }, 'doc:doc:other-contract': { model: CONTRACT_DOC },
    [DEFAULT_DOCS.inventory]: { model: MANIFEST_DOC }, [`doc:doc:other-inventory@${'d'.repeat(64)}`]: { model: MANIFEST_DOC },
    [DEFAULT_DOCS.profile]: { model: PROFILE_DOC }, 'doc:doc:other-profile': { model: PROFILE_DOC },
    ...extra,
  };
  const context = { product: 'widget', root: 'b'.repeat(64), product_pack_digest: 'c'.repeat(64) };
  const previous = projectRecompose({ inputs: [{ slot: 'subject', ...subject }], context: { ...context, run: recomposeRun } });
  const recordOf = (projection: typeof previous, digest: string) => boundRecord('recomposition_run', 'run', JSON.parse(JSON.stringify({
    ...context, run: recomposeRun, pack: `recompose@${recompose.version}`, pack_digest: 'd'.repeat(64), predecessor: null,
    items: projection.items, groups: projection.groups,
  })), digest);
  for (const prefix of ['a', 'c']) documents['rec:' + prefix.repeat(64)] = recordOf(previous, prefix.repeat(64));

  return (args: Row) => {
    const inputs: Row[] = [], late: Row[] = [];
    for (const [slot, binding] of Object.entries(args.inputs as Record<string, Row>)) {
      if (slot === 'recomposition_result') {
        assert.deepEqual(binding, { run: recomposeRun });
        late.push({ slot, run: recomposeRun });
        continue;
      }
      const [key] = Object.values(binding);
      const form = slot === 'plan_result' ? 'run' : key.startsWith('src:') || key.startsWith('rec:') ? 'reference' : 'external';
      assert.deepEqual(binding, { [form]: key });
      assert.ok(Object.hasOwn(documents, key), `unknown synthetic input ${slot}: ${key}`);
      inputs.push({ ...documents[key], slot });
    }
    const input = { inputs, parameters: args.parameters, context: { ...context, product: args.product, line: args.version ?? null, build: args.build, predecessor: args.predecessor ?? null, late_inputs: late } };
    if (args.pack === 'recompose') {
      const projected = projectRecompose({ ...input, context: { ...input.context, run: recomposeRun } });
      assert.equal(projected.error, undefined, JSON.stringify(projected.error));
      documents['rec:' + 'a'.repeat(64)] = recordOf(projected, 'a'.repeat(64));
      return projected.items!;
    }
    assert.equal(args.pack, 'case-compile');
    const projected = projectItems(input) as { error?: unknown; items: Row[] };
    assert.equal(projected.error, undefined, JSON.stringify(projected.error));
    return projected.items;
  };
}
