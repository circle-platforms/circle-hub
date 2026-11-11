// The extraction of a stored result's grounds is kept by the record's digest (issue 200): what is kept is exactly what a
// fresh extraction gives, only for a body the store read and verified, and never the answer to who may read a ground.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { accepted, claim as fixtureClaim, partitions, runRecord } from '../../../contracts/src/fixtures.ts';
import { RunRecord } from '../../../contracts/src/run.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import { verifiedBodyDigest } from '../../records/api.ts';
import { openTestRecords, type TestRecordsKit } from '../../testing/records.ts';
import type { EngineContext } from './deps.ts';
import { forgetExtractedGrounds, groundsOf, groundsReadableBy } from './grounds.ts';

let kit: TestRecordsKit;
before(async () => { kit = await openTestRecords(); });
after(async () => { await kit?.close(); });

const ref = (digit: string) => 'rec:' + digit.repeat(64);
/** A result that names grounds in its claims, as a stored validation result. */
function resultWith(...references: string[]) {
  const result = ValidationResult.parse(accepted);
  result.cross_item[0].statement.data = { cited: references };
  return result;
}
/** Counts the full parses of a result: the costly first step of every extraction. */
function countingParses(t: { after(fn: () => void): void }): () => number {
  const original = ValidationResult.safeParse;
  let calls = 0;
  ValidationResult.safeParse = ((...args: Parameters<typeof original>) => { calls++; return original.apply(ValidationResult, args); }) as typeof original;
  t.after(() => { ValidationResult.safeParse = original; });
  return () => calls;
}

test('a body the store read is known by the digest it was verified under; a copy, a new value and a put record are not', async () => {
  const stored = await kit.store.put({ kind: 'validation_result', schema: 'validation-result@1', provenance: 'projected', body: resultWith(ref('a')) });
  const read = await kit.store.get(stored.digest);
  assert.ok(read !== null);
  assert.equal(verifiedBodyDigest(read.body), stored.digest);
  assert.equal(verifiedBodyDigest(structuredClone(read.body)), undefined, 'a copy was not verified');
  assert.equal(verifiedBodyDigest({ ...(read.body as object) }), undefined);
  assert.equal(verifiedBodyDigest(stored.body), undefined, 'what a caller handed to put was not read back');
  for (const value of [null, undefined, 'rec:' + 'a'.repeat(64), 7, []]) assert.equal(verifiedBodyDigest(value), undefined);
});

test('the grounds of a stored result are extracted once and are what a fresh extraction gives, in the same order', async (t) => {
  const first = await kit.store.put({ kind: 'validation_result', schema: 'validation-result@1', provenance: 'projected', body: resultWith(ref('a'), ref('b'), 'src:' + 'c'.repeat(64)) });
  const other = await kit.store.put({ kind: 'validation_result', schema: 'validation-result@1', provenance: 'projected', body: resultWith(ref('d')) });
  forgetExtractedGrounds();
  const parses = countingParses(t);
  // Two reads of one record are two objects of one digest.
  const one = (await kit.store.get(first.digest))!.body, again = (await kit.store.get(first.digest))!.body;
  assert.notEqual(one, again);
  const fresh = groundsOf(structuredClone(one));
  assert.equal(parses(), 1, 'a copy is extracted, not looked up');
  const kept = groundsOf(one);
  assert.equal(parses(), 2);
  assert.deepEqual(kept, fresh, 'the same grounds in the same order');
  assert.ok(kept.includes(ref('a')) && kept.includes(ref('b')) && kept.includes('src:' + 'c'.repeat(64)));
  assert.deepEqual(groundsOf(again), fresh);
  assert.deepEqual(groundsOf(one), fresh);
  assert.equal(parses(), 2, 'the second read of the record and the same object again cost no parse');
  // What a caller does to the list it got does not reach the next caller.
  kept.length = 0; kept.push('rec:' + 'f'.repeat(64));
  assert.deepEqual(groundsOf(again), fresh);
  // Another record is another extraction, and a list of bodies is walked as before, uncached.
  const second = (await kit.store.get(other.digest))!.body;
  assert.ok(groundsOf(second).includes(ref('d')) && !groundsOf(second).includes(ref('a')));
  assert.equal(parses(), 3);
  const both = groundsOf([one, second]);
  assert.equal(parses(), 5, 'two bodies in a list are parsed as a list is');
  assert.deepEqual(new Set(both), new Set([...fresh, ...groundsOf(second)]));
  assert.deepEqual(both, groundsOf(structuredClone([one, second])), 'and the list gives what it always gave');
  forgetExtractedGrounds();
  groundsOf(one);
  assert.equal(parses(), 8, 'after forgetting, the record is extracted again');
});

test('who may read a ground is asked on every call: only the extraction is kept', async (t) => {
  const by = { id: 'usr_' + '0'.repeat(26), name: '合成读者', role: 'user' as const };
  const run = RunRecord.parse({ ...runRecord, sources: [] });
  const tree = `tree:${'9'.repeat(64)}/synthetic/folder`;
  // A result whose one ground is that folder, so the answer below turns on nothing else.
  const only = ValidationResult.parse({ ...accepted, partitions: partitions({}), cross_item: [{ ...fixtureClaim, resolutions: [], grounds: [tree], validity: { status: 'valid', bound: [], premises: [] } }] });
  const stored = await kit.store.put({ kind: 'validation_result', schema: 'validation-result@1', provenance: 'projected', body: only });
  // The ground is a folder of a knowledge space: whether this reader may read it is the space's answer at the time of the call.
  let readable = true, asked = 0;
  const spaces = { version: async () => ({ body: { space: 'team', entries: [] } }), mayRead: async () => { asked++; return readable; } };
  const ctx = { deps: { records: { store: kit.store, artifacts: {} }, knowledge: { spaces } } } as unknown as EngineContext;
  forgetExtractedGrounds();
  const parses = countingParses(t);
  const body = () => kit.store.get(stored.digest).then((record) => record!.body);
  assert.equal(await groundsReadableBy(ctx, run, await body(), by, { trustedResult: true }), true);
  const parsedOnce = parses(), askedOnce = asked;
  assert.ok(parsedOnce > 0 && askedOnce > 0, 'the result was parsed and the space was asked');
  assert.equal(await groundsReadableBy(ctx, run, await body(), by, { trustedResult: true }), true);
  assert.equal(parses(), parsedOnce, 'the second call parsed nothing');
  assert.equal(asked, askedOnce * 2, 'and asked the space again');
  readable = false;
  assert.equal(await groundsReadableBy(ctx, run, await body(), by, { trustedResult: true }), false, 'a ground that can no longer be read refuses the result, whatever was kept');
  assert.equal(parses(), parsedOnce);
  // Another run of the same content is another answer to keep: the sources a result binds are its run's.
  const elsewhere = RunRecord.parse({ ...runRecord, run: 'run_' + '1'.repeat(26), sources: [] });
  readable = true;
  assert.equal(await groundsReadableBy(ctx, elsewhere, await body(), by, { trustedResult: true }), true);
  assert.equal(parses(), parsedOnce, 'the grounds of the body are known; only the binding to that run was worked out');
});
