// The marks of a check by where its samples come from (T02 R[1]) reach the claims the run records: a fact claim of a
// check with only author samples carries author_samples_only in its qualifier and shows the label; a check with an
// external sample carries no such mark; when several checks support one requirement the marks union (the vocabulary
// order); a model judgment never carries it (the mark speaks about a rule's samples, not about a model's statement).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness, type HarnessOptions } from './testing/harness.ts';
import { standardDocument, toyMap, ITEM } from './testing/mindmap.ts';
import { QUALIFIER_MARK } from '../../../contracts/generated/vocabulary.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();

before(async function beforeHook() {
  postgres = await startPostgres();
});
after(async function afterHook() {
  await postgres?.stop();
});

const IDS = [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4];

/** An accepted review run over the standard map; returns its stored validation result. */
async function reviewed(options: HarnessOptions = {}): Promise<{ h: Harness; result: ValidationResult }> {
  const h = await openHarness(postgres, options);
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call());
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const answer = await h.service.submitResult(
    h.alice,
    {
      run: started.run!.run,
      model: 'model-a',
      items: IDS.map((id) => ({ item: id, handling: 'handled', slots: { findings: [] } })),
      cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
    },
    h.call(),
  );
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  return { h, result: answer.result! };
}

/** The claims of one requirement of one item, from the stored result. */
function claimsOf(result: ValidationResult, item: string, requirement: string): Array<{ qualifier: { nature: string; marks: string[] } }> {
  for (const entries of Object.values(result.partitions)) {
    const found = (entries as Array<{ item: string; requirements: Array<{ requirement: string; claims: unknown[] }> }>).find((it) => it.item === item);
    if (found === undefined) continue;
    const row = found.requirements.find((r) => r.requirement === requirement);
    return (row?.claims ?? []) as Array<{ qualifier: { nature: string; marks: string[] } }>;
  }
  throw new Error(`item ${item} is in no partition`);
}

describe('the only-author-samples mark on fact claims (T02 R[1])', { skip }, () => {
  test('a check without samples (author-only by T02 R[1]) marks the facts it supports, in the vocabulary order', async (t) => {
    // toy-review's structure check ships no samples at all — none is author-only too (marks.ts).
    const { h, result } = await reviewed();
    t.after(() => h.close());
    const claims = claimsOf(result, ITEM.c1, 'structure');
    assert.ok(claims.length > 0, 'the structure requirement records its fact claim');
    for (const claim of claims) {
      assert.ok(claim.qualifier.marks.includes('author_samples_only'), JSON.stringify(claim.qualifier.marks));
      assert.deepEqual(claim.qualifier.marks, [...claim.qualifier.marks].sort((a, b) => vocabOrder(a) - vocabOrder(b)), 'vocabulary order');
    }
  });

  test('a check with an externally retained sample carries no mark', async (t) => {
    // The findings requirement rests on four quote checks; one retained-delivery sample for each clears them all.
    const { h, result } = await reviewed({ review: { externalSamples: ['findings_quotes', 'findings_catalog', 'findings_rank', 'findings_grounds'] } });
    t.after(() => h.close());
    const claims = claimsOf(result, ITEM.c1, 'findings');
    const facts = claims.filter((c) => c.qualifier.nature === 'fact');
    assert.ok(facts.length > 0, 'the findings requirement records fact claims');
    for (const claim of facts) assert.ok(!claim.qualifier.marks.includes('author_samples_only'), JSON.stringify(claim.qualifier.marks));
  });

  test('a requirement supported by several checks takes the union: one author-only check marks every fact of it', async (t) => {
    // The findings requirement rests on four quote checks; one external sample clears only findings_quotes — the other
    // three stay author-only, so the requirement's facts carry the mark (a union over the checks that support it).
    const { h, result } = await reviewed({ review: { externalSamples: ['findings_quotes'] } });
    t.after(() => h.close());
    const claims = claimsOf(result, ITEM.c1, 'findings');
    const facts = claims.filter((c) => c.qualifier.nature === 'fact');
    assert.equal(facts.length, 4, 'one fact claim per check of the requirement');
    // The three author-only checks carry the mark; the one with an external sample does not.
    assert.equal(facts.filter((c) => c.qualifier.marks.includes('author_samples_only')).length, 3, JSON.stringify(facts.map((c) => c.qualifier.marks)));
  });

  test('a model judgment never carries the mark (it speaks about a rule\'s samples)', async (t) => {
    const { h, result } = await reviewed();
    t.after(() => h.close());
    const cross = result.cross_item as Array<{ qualifier: { nature: string; marks: string[] } }>;
    const judgment = cross.find((c) => c.qualifier.nature === 'judgment');
    assert.ok(judgment !== undefined, 'the submitted level judgment is recorded');
    assert.ok(!judgment.qualifier.marks.includes('author_samples_only'), JSON.stringify(judgment.qualifier.marks));
  });
});

/** The position of a qualifier mark in the vocabulary's own order (QUALIFIER_MARK). */
function vocabOrder(mark: string): number {
  const at = QUALIFIER_MARK.indexOf(mark as (typeof QUALIFIER_MARK)[number]);
  return at === -1 ? QUALIFIER_MARK.length : at;
}
