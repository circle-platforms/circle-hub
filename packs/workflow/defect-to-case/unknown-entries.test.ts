// The real run engine with the published pack: start_run binds a case index truncated only by unknown entries because
// indexed_cases declares unknown_entries: disclose, start_run returns the gap, and the dedup claim of a draft with no
// visible duplicate stays unknown with the count. A case index truncated for any other reason is still refused.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { INDEX_UNKNOWN_ENTRIES } from './functions/expected.ts';
import { FIX_REF, SYNTHETIC_INDEX_VIEW, UNKNOWN_COMMANDS_NOTE, UNKNOWN_ONLY_INDEX_VIEW, expectedFor, makeGoodDraft } from './testing/fixtures.ts';
import { BUILD, call, openHub, type Hub } from './testing/hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
const INDEX = 'knowledge:index:apv:Rel_APV_10_6_1_57?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure';
let postgres: TemporaryPostgres;
let hub: Hub;

before(async () => {
  postgres = await startPostgres();
  if (!skip) hub = await openHub(postgres);
});
after(async () => {
  await hub?.close();
  await postgres?.stop();
});

/** Every index spelling the fake knowledge reader answers (the bound view and the engine's narrowed read) gets this view. */
function serve(view: unknown): void {
  const bytes = Buffer.from(JSON.stringify(view));
  for (const key of hub.external.objects.keys()) if (key.startsWith('knowledge:index:')) hub.external.put(key, { bytes, mediaType: 'application/json' });
  hub.external.put(INDEX, { bytes, mediaType: 'application/json' });
}

const start = (session: string) => hub.service.startRunDetailed(hub.alice, { pack: 'defect-to-case', product: BUILD.family, build: BUILD.name, inputs: { defects: [{ external: 'plm:bug:74001' }], indexed_cases: { external: INDEX } } }, call(session));

describe('defect-to-case with a case index truncated by unknown entries', { skip }, () => {
  it('binds the unknown-only index, returns the gap, and keeps "no duplicate" unknown with the count', async () => {
    // The start_run binding is the index without only=; the engine's narrowed read slices it by the draft's command.
    const { only: _narrowed, ...unnarrowed } = UNKNOWN_ONLY_INDEX_VIEW;
    serve(unnarrowed);
    const detail = await start('unknown-only-start');
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const gap = detail.gaps?.find(row => row.code === INDEX_UNKNOWN_ENTRIES);
    assert.ok(gap, JSON.stringify(detail.gaps));
    assert.match(gap.message, /只因 2 个用例缺查询所需的事实而截断/);
    assert.ok(gap.message.includes(UNKNOWN_COMMANDS_NOTE));
    const run = detail.answer.run!;
    const bug = run.sources.find(source => source.slot === 'defects')!;
    const quote = { reference: `${bug.reference}/json@1/p/fields/fix`, text: '健康检查间隔设置成功' };
    const draft = { ...makeGoodDraft({ ref: FIX_REF }), title: '合成未知条目回归', expected: [expectedFor(quote.text, FIX_REF)] };
    const answer = await hub.service.submitResult(hub.alice, { run: run.run, model: 'synthetic-model', items: [{ item: '74001', handling: 'handled', slots: { cases: [{ text: draft.title, quotes: [quote], data: draft }] } }] }, call('unknown-only-submit'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const result = answer.result as ValidationResult;
    const claims = Object.values(result.partitions).flat().flatMap(item => item.requirements).filter(requirement => requirement.requirement === 'not_duplicate').flatMap(requirement => requirement.claims);
    assert.equal(claims.length, 1, JSON.stringify(claims));
    const [claim] = claims;
    assert.equal(claim.statement.verdict, 'unknown', JSON.stringify(claim.statement));
    assert.match(claim.statement.text, /源索引有 2 个用例缺本次查询所需的事实/);
    assert.match(claim.statement.text, /不能当作没有用例或没有重复/);
    assert.ok(claim.statement.text.includes(UNKNOWN_COMMANDS_NOTE));
    assert.equal(claim.statement.data?.unknown_entries, 2);
    // The engine read the draft's command at the bound revision; the narrowed view still carried the unknown entries.
    assert.ok(hub.external.reads.some(id => id.includes('only=%2Fcommands%2Fwidget%2Fhealth%2Finterval@')));
  });

  for (const [name, changes] of [
    ['truncated with neither field', { truncated: true }],
    ['unknown entries next to other truncation (no unknown_only)', { truncated: true, unknown_entries: 2 }],
  ] as const) it(`refuses a case index ${name} at start_run`, async () => {
    serve({ ...structuredClone(SYNTHETIC_INDEX_VIEW), ...changes, notes: [UNKNOWN_COMMANDS_NOTE] });
    const detail = await start(`refused-${name.length}`);
    assert.equal(detail.answer.call_result, 'error');
    const error = detail.answer.errors.find(row => row.path === '/inputs/indexed_cases');
    assert.ok(error, JSON.stringify(detail.answer.errors));
    assert.match(error.message, /未交付/);
    assert.equal(detail.answer.run, undefined);
  });
});
