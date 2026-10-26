// (d) Valid examples round-trip through the shapes; invalid ones are rejected. All values are synthetic (fixtures.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { z } from 'zod';
import { REFERENCE_FORMS } from '../generated/protocol.ts';
import { ITEM_HANDLING, LAYER, PARTITION, REFERENCE_SCHEME } from '../generated/vocabulary.ts';
import { Claim, ValueResolution } from './claim.ts';
import { Coverage, Envelope, JsonPointer, RecordId, RunId, SchemaId, TraceId, UserId } from './common.ts';
import { accepted, ADMIN, claim, copy, H, H2, H3, hubRun, judgment, notAccepted, partitions, RUN, runRecord, submission, summary, TRACE, USER } from './fixtures.ts';
import { SCHEMA_REGISTRY } from './index.ts';
import { RecordEnvelope } from './records.ts';
import { ExternalObjectId, Ground, MAX_REFERENCE_LENGTH, NEVER_RAW_BMP, Reference, ReferenceUri, referenceUriOf, TreePath } from './reference.ts';
import { InputBinding, RunRecord, RunSummary, SourceBinding } from './run.ts';
import { CrossItemSubmission, ItemSubmission, ReceivedSubmission, Submission } from './submission.ts';
import { LayerResult, partitionCountsOf, PartitionCounts, Partitions, ValidationResult, type Partitions as PartitionsType } from './validation.ts';

/** Parses a JSON copy and expects the very same value back. */
function roundTrips(schema: z.ZodType, value: unknown): void {
  const parsed = schema.safeParse(copy(value));
  assert.ok(parsed.success, `expected valid: ${JSON.stringify(value).slice(0, 300)}\n${parsed.error?.message}`);
  assert.deepEqual(parsed.data, value);
}
function rejects(schema: z.ZodType, value: unknown, why: string): void {
  assert.equal(schema.safeParse(value).success, false, `expected rejected (${why}): ${JSON.stringify(value).slice(0, 300)}`);
}
/** Rejected with an issue at exactly this path. */
function rejectsAt(schema: z.ZodType, value: unknown, path: (string | number)[], why: string): void {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, `expected rejected (${why})`);
  const paths = result.error.issues.map((i) => JSON.stringify(i.path));
  assert.ok(paths.includes(JSON.stringify(path)), `${why}: expected an issue at ${JSON.stringify(path)}, got ${paths.join(' ')}`);
}

describe('Reference', () => {
  test('valid objects round-trip', () => {
    for (const value of [
      { scheme: 'src', sha256: H },
      { scheme: 'src', sha256: H, parser: 'mindmap@1', selector: 'n1/children.0' },
      { scheme: 'src', sha256: H, parser: 'sheet@2', selector: 'Cases/7/C', range: [0, 12] },
      { scheme: 'tree', root: H, path: '/' },
      { scheme: 'tree', root: H, path: '/commands/show%20item', entry: H2 },
      { scheme: 'tree', root: H, path: '/手册/第一章' },
      { scheme: 'tree', root: H, path: '/a%40b' },
      { scheme: 'entry', entry: H },
      { scheme: 'rec', record: H },
      { scheme: 'rec', record: H, pointer: '/partitions/delivered/2' },
      { scheme: 'rec', record: H, pointer: '/a~1b/~0/' },
    ]) {
      roundTrips(Reference, value);
    }
  });
  test('invalid objects are rejected', () => {
    rejects(Reference, { scheme: 'src', sha256: H.toUpperCase() }, 'uppercase digest');
    rejects(Reference, { scheme: 'src', sha256: H.slice(1) }, 'short digest');
    rejects(Reference, { scheme: 'src', sha256: H, parser: 'mindmap@1' }, 'parser without selector');
    rejects(Reference, { scheme: 'src', sha256: H, selector: 'n1' }, 'selector without parser');
    rejects(Reference, { scheme: 'src', sha256: H, range: [0, 4] }, 'range without selector');
    rejects(Reference, { scheme: 'src', sha256: H, parser: 'mindmap@1', selector: 'n1', range: [4, 4] }, 'empty range');
    rejects(Reference, { scheme: 'src', sha256: H, parser: 'mindmap', selector: 'n1' }, 'parser without major');
    rejects(Reference, { scheme: 'src', sha256: H, parser: 'mindmap@01', selector: 'n1' }, 'major with a leading zero');
    rejects(Reference, { scheme: 'src', sha256: H, parser: 'mindmap@1', selector: 'a:b' }, 'raw colon in a selector: it starts the range');
    rejects(Reference, { scheme: 'src', sha256: H, parser: 'mindmap@1', selector: 'a//b' }, 'empty selector segment');
    rejects(Reference, { scheme: 'tree', root: H, path: 'commands' }, 'relative path');
    rejects(Reference, { scheme: 'tree', root: H, path: '/a//b' }, 'empty segment');
    rejects(Reference, { scheme: 'tree', root: H, path: '/a/' }, 'trailing slash');
    rejects(Reference, { scheme: 'tree', root: H, path: '/show item' }, 'raw space: canonical text percent-encodes it');
    rejects(Reference, { scheme: 'tree', root: H, path: '/a@b' }, 'raw @ in a path: it starts the entry pin');
    rejects(Reference, { scheme: 'tree', root: H, path: '/a\u{E0001}b' }, 'astral format character');
    rejects(Reference, { scheme: 'src', sha256: H, parser: 'mindmap@1', selector: 'a b' }, 'raw space in the selector');
    rejects(Reference, { scheme: 'rec', record: H, pointer: 'items/2' }, 'pointer without leading slash');
    rejects(Reference, { scheme: 'rec', record: H, pointer: '/a#b' }, 'raw # in a pointer');
    rejects(Reference, { scheme: 'rec', record: H, pointer: '/a~2' }, 'tilde escape other than ~0 and ~1');
    rejects(Reference, { scheme: 'entry' }, 'missing digest');
    rejects(Reference, { scheme: 'file', sha256: H }, 'unknown scheme');
    rejects(Reference, { scheme: 'src', sha256: H, size: 12 }, 'unknown key: object forms are strict');
  });
  test('the union covers exactly the reference_scheme vocabulary', () => {
    const schemes = Reference.options.map((o) => o.shape.scheme.value);
    assert.deepEqual(schemes, [...REFERENCE_SCHEME]);
    assert.deepEqual(Object.keys(REFERENCE_FORMS), [...REFERENCE_SCHEME]);
  });
});

describe('ReferenceUri', () => {
  const valid = [
    `src:${H}`,
    `src:${H}/mindmap@1/n1/children.0`,
    `src:${H}/sheet@2/Cases/7/C:0-12`,
    `src:${H}/kityminder@1/n/a%3Ab:3-10`,
    `tree:${H}/`,
    `tree:${H}/@${H2}`,
    `tree:${H}/commands/show`,
    `tree:${H}/commands/show@${H2}`,
    `tree:${H}/手册/第一章`,
    `tree:${H}/commands/show%20item`,
    `tree:${H}/%E2%80%AEx`,
    `tree:${H}/emoji/😀`,
    `entry:${H}`,
    `rec:${H}`,
    `rec:${H}#/partitions/delivered/2`,
    `rec:${H}#/partitions/delivered`,
    `rec:${H}#/`,
    `rec:${H}#/a~1b/~0`,
    `tree:${H}/${'a'.repeat(MAX_REFERENCE_LENGTH - `tree:${H}/`.length)}`,
  ];
  const invalid: [string, string][] = [
    [`src:${H}x`, 'junk after the digest'],
    [`src:${H}/`, 'empty tail'],
    [`src:${H}/mindmap/n1`, 'parser without major'],
    [`src:${H}/mindmap@01/n1`, 'major with a leading zero'],
    [`src:${H}/mindmap@1/`, 'empty selector'],
    [`src:${H}/mindmap@1/a//b`, 'empty selector segment'],
    [`src:${H}/mindmap@1/a b`, 'whitespace'],
    [`src:${H}/p@1/x:9-1`, 'reversed range'],
    [`src:${H}/p@1/x:4-4`, 'empty range'],
    [`src:${H}/p@1/x:01-4`, 'range with a leading zero'],
    [`src:${H}/p@1/x:4`, 'range without its end'],
    [`src:${H}/p@1/x:1-2:3-4`, 'two ranges'],
    [`tree:${H}`, 'no path'],
    [`tree:${H}//a`, 'empty segment'],
    [`tree:${H}/a/`, 'trailing slash'],
    [`tree:${H}/a@zz`, 'entry pin that is not a digest'],
    [`tree:${H}/a@`, 'empty entry pin'],
    [`tree:${H}/a@${H2}/b`, 'path after the entry pin'],
    [`tree:${H}/a‮b`, 'right-to-left override (Cf)'],
    [`tree:${H}/a⁦b`, 'left-to-right isolate (Cf)'],
    [`tree:${H}/a​b`, 'zero width space (Cf)'],
    [`tree:${H}/a\u0085b`, 'next line (C1 control)'],
    [`tree:${H}/a b`, 'no-break space (Zs)'],
    [`tree:${H}/a\u{E0001}b`, 'language tag (astral Cf)'],
    [`tree:${H}/a\u{1D173}b`, 'musical symbol begin beam (astral Cf)'],
    [`tree:${H}/a\uD800b`, 'unpaired surrogate'],
    [`tree:${H}/a%`, 'bare percent'],
    [`tree:${H}/a%zz`, 'percent without hex digits'],
    [`tree:${H}/a%2f`, 'lower-case escape: the formatter writes upper case'],
    [`entry:${H}/x`, 'entry with a path'],
    [`rec:${H}#`, 'empty fragment'],
    [`rec:${H}#items`, 'pointer without slash'],
    [`rec:${H}#/a#b`, 'raw # in the pointer'],
    [`rec:${H}#/a~2`, 'bad tilde escape'],
    [`rec:${H}\n`, 'control character'],
    [`file:${H}`, 'unknown scheme'],
    [`SRC:${H}`, 'uppercase scheme'],
    [`src:${H.slice(1)}`, 'short digest'],
    [`src:${H.toUpperCase()}`, 'uppercase digest'],
    [`tree:${H}/${'a'.repeat(MAX_REFERENCE_LENGTH)}`, 'longer than MAX_REFERENCE_LENGTH'],
    ['', 'empty'],
  ];
  test('valid URIs round-trip', () => {
    for (const uri of valid) roundTrips(ReferenceUri, uri);
  });
  test('invalid URIs are rejected', () => {
    for (const [uri, why] of invalid) rejects(ReferenceUri, uri, why);
  });
  test('referenceUriOf narrows to the given schemes and keeps every rule', () => {
    const rec = referenceUriOf('rec');
    roundTrips(rec, `rec:${H}#/partitions/delivered/0`);
    rejects(rec, `src:${H}`, 'src is not rec');
    rejects(rec, `entry:${H}`, 'entry is not rec');
    const either = referenceUriOf('src', 'tree');
    roundTrips(either, `tree:${H}/`);
    rejects(either, `rec:${H}`, 'rec is neither');
    rejects(either, `src:${H}/p@1/x:9-1`, 'reversed range');
    rejects(either, `tree:${H}/a\u{E0001}`, 'astral format character');
    assert.throws(() => referenceUriOf());
  });
  test('a knowledge entry is never a ground on its own, but stays a reference (B01 R[5])', () => {
    rejects(Ground, `entry:${H}`, 'entry as a ground');
    roundTrips(ReferenceUri, `entry:${H}`);
    for (const uri of [`src:${H}`, `tree:${H}/commands/show@${H2}`, `rec:${H}#/partitions/delivered/0`]) roundTrips(Ground, uri);
  });
  test('the never-raw ranges are exactly the BMP characters of \\p{Cc}, \\p{Cf} and \\p{Z} that hub/refs escapes', () => {
    // A Unicode update of Node that adds such a character fails here, before the published patterns fall behind hub/refs.
    const runtime = /[\p{Cc}\p{Cf}\p{Z}]/u;
    const written = new RegExp(`[${NEVER_RAW_BMP}]`);
    const differ: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCharCode(cp);
      if (runtime.test(ch) !== written.test(ch)) differ.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    assert.deepEqual(differ, []);
  });
  test('text far over the length cap is refused without running the patterns', () => {
    for (const schema of [ReferenceUri, Ground, TreePath, ExternalObjectId, JsonPointer]) {
      assert.equal(schema.safeParse(`tree:${H}/${'a'.repeat(20_000_000)}`).success, false);
      assert.equal(schema.safeParse(`/${'a'.repeat(20_000_000)}`).success, false);
    }
  });
  test('TreePath is the canonical path of a tree reference', () => {
    for (const path of ['/', '/commands/show', '/a%20b', '/手册']) roundTrips(TreePath, path);
    for (const path of ['', 'a', '/a/', '//', '/a b', '/a@b', '/a%2']) rejects(TreePath, path, `path ${JSON.stringify(path)}`);
  });
});

describe('ExternalObjectId', () => {
  test('valid identities round-trip', () => {
    for (const id of ['tracker:story:42', 'tracker:story:42@7', 'mind-map:document:90001', 'docs:page:a/b/c@2026-10-21T00:00:00Z', 'tracker:bug_report:x:y']) {
      roundTrips(ExternalObjectId, id);
    }
  });
  test('invalid identities are rejected', () => {
    for (const [id, why] of [
      ['story:42', 'two parts'],
      ['Tracker:story:1', 'uppercase system'],
      ['tracker:Story:1', 'uppercase type'],
      ['tracker::1', 'empty type'],
      ['tracker:story:', 'empty id'],
      ['tracker:story:1@', 'empty revision'],
      ['tracker:story:1 2', 'whitespace'],
      ['tracker:story:1‮2', 'format character'],
      ['tracker:story:1\u{E0020}', 'astral format character'],
      ['src:story:1', 'a reference scheme as system'],
      ['rec:x:y', 'a reference scheme as system'],
      [`src:${H}`, 'a reference'],
    ]) {
      rejects(ExternalObjectId, id, why);
    }
  });
});

describe('InputBinding', () => {
  test('exactly one of reference or external', () => {
    roundTrips(InputBinding, { reference: `src:${H}` });
    roundTrips(InputBinding, { reference: `rec:${H}#/partitions/delivered/1` });
    roundTrips(InputBinding, { external: 'tracker:story:42@3' });
    rejects(InputBinding, {}, 'neither');
    rejects(InputBinding, { reference: `src:${H}`, external: 'tracker:story:42' }, 'both');
    rejects(InputBinding, { reference: 'tracker:story:42' }, 'an identity is not a reference');
    rejects(InputBinding, { external: `src:${H}` }, 'a reference is not an identity');
    rejects(InputBinding, { reference: `src:${H}`, note: 'x' }, 'unknown key');
  });
});

describe('Claim', () => {
  test('a rule verdict, an unknown with its reason and a model judgment round-trip', () => {
    roundTrips(Claim, claim);
    roundTrips(Claim, judgment);
    roundTrips(Claim, {
      ...claim,
      statement: { text: '检查超时，结论未知', verdict: 'unknown', reason: 'timeout' },
      qualifier: { nature: 'unknown', provenance: 'projected', marks: [] },
    });
    rejects(Claim, { ...claim, statement: { text: 'x', verdict: 'unknown', reason: 'flaky' } }, 'reason outside the vocabulary');
  });
  test('values outside the vocabulary or the reference grammar are rejected', () => {
    rejects(Claim, { ...claim, qualifier: { ...claim.qualifier, nature: 'probable' } }, 'nature');
    rejects(Claim, { ...claim, qualifier: { ...claim.qualifier, marks: ['green'] } }, 'mark');
    rejects(Claim, { ...claim, qualifier: { ...claim.qualifier, collected_at: '2026-10-21T17:00:00+09:00' } }, 'time with offset');
    rejects(Claim, { ...claim, grounds: ['the manual, page 3'] }, 'ground is not a reference');
    rejects(Claim, { ...claim, statement: { ...claim.statement, verdict: 'pass' } }, 'pass is a terminal, not a verdict');
    rejects(Claim, { ...claim, warrant: { producer: 'target', id: 'device@1' } }, 'producer kind');
    rejects(Claim, { ...claim, validity: { ...claim.validity, status: 'ok' } }, 'validity status');
    rejects(Claim, { ...claim, validity: { status: 'valid', bound: ['abc'], premises: [] } }, 'bound digest');
    rejects(Claim, { ...claim, pointer: 'items/0' }, 'pointer without a leading slash');
    const { warrant: _w, ...withoutWarrant } = claim;
    rejects(Claim, withoutWarrant, 'missing warrant');
  });
  test('a knowledge entry is cited by its tree address, never as a bare entry (B01 R[5])', () => {
    rejectsAt(Claim, { ...claim, grounds: [`entry:${H}`] }, ['grounds', 0], 'entry ground');
    roundTrips(Claim, { ...claim, grounds: [`tree:${H}/commands/show@${H3}`] });
  });
  test('every object is strict: an unknown or misspelled key is an issue with a path', () => {
    rejectsAt(Claim, { ...claim, ground: [] }, [], 'misspelled key');
    rejectsAt(Claim, { ...claim, statement: { ...claim.statement, verdikt: 'refute' } }, ['statement'], 'misspelled nested key');
    rejectsAt(Claim, { ...claim, qualifier: { ...claim.qualifier, extra: 1 } }, ['qualifier'], 'unknown qualifier key');
  });
  test('each exact value sits beside what it resolved to (T04 R[1])', () => {
    const value = { pointer: '/items/0/slots/q', text: 'show item', resolution: 'resolved', references: [`tree:${H}/commands/show@${H2}`] };
    roundTrips(ValueResolution, value);
    roundTrips(ValueResolution, { ...value, resolution: 'ambiguous', references: [`tree:${H}/a`, `tree:${H}/b`] });
    roundTrips(ValueResolution, { ...value, resolution: 'unresolved', references: [] });
    rejectsAt(ValueResolution, { ...value, references: [] }, ['references'], 'resolved without a referent');
    rejectsAt(ValueResolution, { ...value, resolution: 'ambiguous' }, ['references'], 'ambiguous with one candidate');
    rejectsAt(ValueResolution, { ...value, resolution: 'unresolved' }, ['references'], 'unresolved with a referent');
    rejects(ValueResolution, { ...value, references: [`entry:${H}`] }, 'entry referent');
    rejects(ValueResolution, { ...value, text: '' }, 'empty text');
  });
});

describe('Submission', () => {
  test('a full submission and one without cross-item claims round-trip', () => {
    roundTrips(Submission, submission);
    const { cross_item: _c, ...minimal } = submission;
    roundTrips(Submission, minimal);
    roundTrips(Submission, { ...submission, items: [] });
  });
  test('the item and cross-item unions cover exactly their vocabularies', () => {
    assert.deepEqual(ItemSubmission.options.map((o) => o.shape.handling.value), [...ITEM_HANDLING]);
    assert.deepEqual(CrossItemSubmission.options.map((o) => o.shape.nature.value), ['fact', 'judgment']);
  });
  test('malformed submissions are rejected', () => {
    rejects(Submission, { ...submission, run: 'run_123' }, 'short run id');
    rejects(Submission, { ...submission, run: RUN.toUpperCase() }, 'uppercase run id');
    rejects(Submission, { ...submission, run: 'run_01jacd5z8q3w7v9h2k4m6n8p0u' }, 'u is not in the ULID alphabet');
    rejects(Submission, { ...submission, model: '' }, 'empty model');
    rejects(Submission, { ...submission, items: [{ item: 'x', handling: 'done' }] }, 'handling');
    rejects(Submission, { ...submission, items: [{ item: 'x', handling: 'handled', reuse: `src:${H}` }] }, 'reuse must be a Hub record reference');
    rejects(Submission, { ...submission, items: [{ item: '', handling: 'handled' }] }, 'empty item id');
    rejects(Submission, { ...submission, cross_item: [{ nature: 'unknown', statement: 'x', grounds: [] }] }, 'cross-item nature');
    rejects(Submission, { ...submission, cross_item: [{ nature: 'judgment', statement: 'x', grounds: [], premises: ['/items/0'] }] }, 'premise outside cross_item');
  });
  test('unknown and misspelled keys are issues with paths, never dropped (T03 R[3])', () => {
    const misspelled = { run: RUN, model: 'm', items: [{ item: 'doc:n1', handling: 'handled', slot: { findings: [] } }], cross_items: [] };
    rejectsAt(Submission, misspelled, ['items', 0], 'slot instead of slots');
    rejectsAt(Submission, misspelled, [], 'cross_items instead of cross_item');
    rejectsAt(Submission, { ...submission, cross_item: [{ ...submission.cross_item[0], premise: [] }] }, ['cross_item', 0], 'premise instead of premises');
  });
  test('a skipped item needs a reason and carries nothing else (W07 F[2])', () => {
    rejectsAt(Submission, { ...submission, items: [{ item: 'a', handling: 'skipped' }] }, ['items', 0, 'reason'], 'no reason');
    rejectsAt(Submission, { ...submission, items: [{ item: 'a', handling: 'skipped', reason: '  ' }] }, ['items', 0, 'reason'], 'blank reason');
    rejects(Submission, { ...submission, items: [{ item: 'a', handling: 'skipped', reason: 'r', slots: {} }] }, 'slots on a skipped item');
  });
  test('reuse is given instead of slots, not beside them (C08 R[4])', () => {
    rejectsAt(Submission, { ...submission, items: [{ item: 'a', handling: 'handled', slots: {}, reuse: `rec:${H}#/partitions/delivered/0` }] }, ['items', 0, 'reuse'], 'both');
  });
  test('an item is declared once', () => {
    const twice = { ...submission, items: [{ item: 'a', handling: 'handled' }, { item: 'a', handling: 'skipped', reason: '废弃' }] };
    rejectsAt(Submission, twice, ['items', 1, 'item'], 'conflicting declarations of one item');
  });
  test('a cross-item fact rests on at least one reference and on no premise', () => {
    rejectsAt(Submission, { ...submission, cross_item: [{ nature: 'fact', statement: 's', grounds: [] }] }, ['cross_item', 0, 'grounds'], 'fact without grounds');
    rejects(Submission, { ...submission, cross_item: [{ nature: 'fact', statement: 's', grounds: [`src:${H}`], premises: [] }] }, 'fact with premises');
    rejects(Submission, { ...submission, cross_item: [{ nature: 'fact', statement: 's', grounds: [`entry:${H}`] }] }, 'entry ground');
  });
  test('premises point to earlier entries only, written without leading zeros', () => {
    const fact = submission.cross_item[0];
    const judge = (premises: string[]) => ({ nature: 'judgment', statement: 's', grounds: [], premises });
    rejectsAt(Submission, { ...submission, cross_item: [judge(['/cross_item/0'])] }, ['cross_item', 0, 'premises', 0], 'itself');
    rejectsAt(Submission, { ...submission, cross_item: [fact, judge(['/cross_item/9'])] }, ['cross_item', 1, 'premises', 0], 'past the end');
    rejectsAt(Submission, { ...submission, cross_item: [fact, judge(['/cross_item/1']), fact] }, ['cross_item', 1, 'premises', 0], 'itself, not earlier');
    rejectsAt(Submission, { ...submission, cross_item: [judge(['/cross_item/1']), fact] }, ['cross_item', 0, 'premises', 0], 'a later entry');
    rejects(Submission, { ...submission, cross_item: [fact, judge(['/cross_item/00'])] }, 'leading zero');
    roundTrips(Submission, { ...submission, cross_item: [fact, fact, judge(['/cross_item/0', '/cross_item/1'])] });
  });
  test('a received submission body is any arguments object (submission-received@1)', () => {
    roundTrips(ReceivedSubmission, { run: 'run_123', items: 'x' });
    rejects(ReceivedSubmission, 'x', 'not an object');
    assert.ok(SCHEMA_REGISTRY['submission-received@1'] === ReceivedSubmission);
  });
});

describe('ValidationResult', () => {
  const item = accepted.partitions.delivered[0] as Record<string, unknown> & { requirements: unknown[] };
  const withPartitions = (filled: Parameters<typeof partitions>[0]) => ({ ...accepted, partitions: partitions(filled) });
  const withLayer = (layer: unknown, extra: Record<string, unknown> = {}) =>
    withPartitions({ delivered: [{ ...item, requirements: [{ requirement: 'r', layers: [layer], status: 'pending', claims: [], ...extra }] }] });

  test('an accepted and a not-accepted result round-trip', () => {
    roundTrips(ValidationResult, accepted);
    roundTrips(ValidationResult, notAccepted);
  });
  test('the partitions and the layer union cover exactly their vocabularies', () => {
    assert.deepEqual(Object.keys(Partitions.shape), [...PARTITION]);
    assert.deepEqual(LayerResult.options.map((o) => o.shape.layer.value), [...LAYER]);
    assert.deepEqual(Object.keys(PartitionCounts.shape), [...PARTITION, 'unknown', 'pending_unknown']);
  });
  test('wrong values are rejected', () => {
    rejects(ValidationResult, { ...accepted, schema: 'validation@2' }, 'schema');
    rejects(ValidationResult, { ...accepted, trace: '0'.repeat(32) }, 'all-zero trace');
    rejects(ValidationResult, { ...accepted, acceptance: 'partly' }, 'acceptance');
    rejects(ValidationResult, withLayer({ layer: 'static', terminal: 'fail', code: 'x' }), 'fail is a dynamic terminal');
    rejects(ValidationResult, withLayer({ layer: 'dynamic', terminal: 'violation', code: 'x' }), 'violation is a static terminal');
    rejects(ValidationResult, withLayer({ layer: 'runtime', terminal: 'pass' }), 'layer');
    rejects(ValidationResult, withLayer({ layer: 'static', terminal: 'violation', code: 'x', attribution: 'device_defect' }), 'attribution');
    rejects(ValidationResult, { ...accepted, partitions: { ...accepted.partitions, failed: [] } }, 'partition');
    rejects(ValidationResult, withPartitions({ delivered: [{ ...item, location: 'node 7' }] }), 'location is a reference');
    rejects(ValidationResult, withPartitions({ incomplete: [{ ...item, reason: 'flaky' }] }), 'reason');
    rejects(ValidationResult, withPartitions({ delivered: [{ ...item, partition: 'delivered' }] }), 'the partition is the array, not a field');
  });
  test('every item is in exactly one partition (V05 R[0])', () => {
    const twice = withPartitions({ delivered: [item], rejected: [{ ...item, code: 'review.blocked' }] });
    rejectsAt(ValidationResult, twice, ['partitions', 'rejected', 0, 'item'], 'one item in two partitions');
    rejectsAt(ValidationResult, withPartitions({ delivered: [item, item] }), ['partitions', 'delivered', 1, 'item'], 'one item twice in a partition');
  });
  test('each partition carries what V05 F[0]-F[3] say', () => {
    rejectsAt(ValidationResult, withPartitions({ rejected: [item] }), ['partitions', 'rejected', 0, 'code'], 'rejected without code');
    rejectsAt(ValidationResult, withPartitions({ incomplete: [item] }), ['partitions', 'incomplete', 0, 'reason'], 'incomplete without reason');
    rejectsAt(ValidationResult, withPartitions({ quarantined: [item] }), ['partitions', 'quarantined', 0, 'reason'], 'quarantined without reason');
    rejects(ValidationResult, withPartitions({ delivered: [{ ...item, code: 'x' }] }), 'delivered with a code');
    rejects(ValidationResult, withPartitions({ delivered: [{ ...item, reason: 'timeout' }] }), 'delivered with a reason');
    rejects(ValidationResult, withPartitions({ rejected: [{ ...item, code: 'x', reason: 'timeout' }] }), 'rejected with a reason');
    roundTrips(ValidationResult, withPartitions({ rejected: [{ ...item, code: 'review.blocked' }], quarantined: [{ ...item, item: 'q', reason: 'awaiting_step' }] }));
  });
  test('a submission that is not accepted produces no partitions, no cross-item claims and names its codes (V05 R[5], W08 R[1])', () => {
    rejectsAt(ValidationResult, { ...notAccepted, partitions: accepted.partitions }, ['partitions', 'delivered'], 'items on a not-accepted result');
    rejectsAt(ValidationResult, { ...notAccepted, cross_item: [judgment] }, ['cross_item'], 'cross-item claims on a not-accepted result');
    rejectsAt(ValidationResult, { ...notAccepted, errors: [] }, ['errors'], 'not accepted without a code');
    roundTrips(ValidationResult, { ...accepted, partitions: partitions({}), cross_item: [] });
  });
  test('layer terminals carry what V03 and V04 R[1] say', () => {
    const at = ['partitions', 'delivered', 0, 'requirements', 0, 'layers', 0];
    rejectsAt(ValidationResult, withLayer({ layer: 'static', terminal: 'violation' }), [...at, 'code'], 'violation without code');
    roundTrips(ValidationResult, withLayer({ layer: 'dynamic', terminal: 'fail' }));
    rejectsAt(ValidationResult, withLayer({ layer: 'static', terminal: 'pass', attribution: 'author_input' }, { status: 'satisfied' }), [...at, 'attribution'], 'attribution on pass');
    rejectsAt(ValidationResult, withLayer({ layer: 'static', terminal: 'judgment', attribution: 'author_input' }), [...at, 'attribution'], 'attribution on a judgment');
    rejectsAt(ValidationResult, withLayer({ layer: 'dynamic', terminal: 'pass', attribution: 'transient' }, { status: 'satisfied' }), [...at, 'attribution'], 'attribution on a dynamic pass');
    rejectsAt(ValidationResult, withLayer({ layer: 'static', terminal: 'pass', code: 'x' }, { status: 'satisfied' }), [...at, 'code'], 'pass with a code');
    rejectsAt(ValidationResult, withLayer({ layer: 'static', terminal: 'unchecked' }), [...at, 'reason'], 'unchecked without reason');
    rejectsAt(ValidationResult, withLayer({ layer: 'dynamic', terminal: 'not_run' }), [...at, 'reason'], 'not run without reason');
    rejectsAt(ValidationResult, withLayer({ layer: 'dynamic', terminal: 'no_verdict' }), [...at, 'reason'], 'no verdict without reason');
    rejectsAt(ValidationResult, withLayer({ layer: 'static', terminal: 'incomplete' }), [...at, 'reason'], 'incomplete without reason');
    roundTrips(ValidationResult, withLayer({ layer: 'static', terminal: 'unchecked', reason: 'no_check', attribution: 'data_gap', missing:'合成检查',exit:{action:'reevaluate',audience:{hub:true},due:'2026-11-01T12:00:00.000Z'} }));
    roundTrips(ValidationResult, withLayer({ layer: 'dynamic', terminal: 'not_run', reason: 'no_check',missing:'合成观察',exit:{action:'observe',audience:{hub:true},due:'2026-11-01T12:00:00.000Z'} }));
  });
  test('a requirement lists each layer once and names why it is unsatisfied', () => {
    const at = ['partitions', 'delivered', 0, 'requirements', 0];
    const pass = { layer: 'static', terminal: 'pass' };
    rejectsAt(ValidationResult, withPartitions({ delivered: [{ ...item, requirements: [{ requirement: 'r', layers: [pass, pass], status: 'satisfied', claims: [] }] }] }), [...at, 'layers', 1, 'layer'], 'two static terminals');
    rejectsAt(ValidationResult, withLayer(pass, { status: 'unsatisfied' }), [...at, 'unsatisfied_reason'], 'unsatisfied without reason');
    rejectsAt(ValidationResult, withLayer(pass, { status: 'satisfied', unsatisfied_reason: 'abandoned' }), [...at, 'unsatisfied_reason'], 'reason on a satisfied requirement');
    const twice = { ...item, requirements: [item.requirements[0], item.requirements[0]] };
    rejectsAt(ValidationResult, withPartitions({ delivered: [twice] }), ['partitions', 'delivered', 0, 'requirements', 1, 'requirement'], 'one requirement twice');
  });
  test('a carried-over item names the predecessor fragment (C08 R[4])', () => {
    rejects(ValidationResult, withPartitions({ delivered: [{ ...item, carried_over: `src:${H}` }] }), 'carry-over is a Hub record reference');
    roundTrips(ValidationResult, withPartitions({ delivered: [{ ...item, carried_over: `rec:${H}#/partitions/delivered/4` }] }));
  });
  test('rounds and coverage are consistent', () => {
    rejectsAt(ValidationResult, { ...accepted, rounds: { used: 4, max: 3 } }, ['rounds', 'used'], 'more rounds used than allowed');
    rejectsAt(ValidationResult, { ...accepted, coverage: { complete: true, examined: 2, total: 3 } }, ['coverage', 'complete'], 'complete while one is unexamined');
    rejectsAt(ValidationResult, { ...accepted, coverage: { complete: false, examined: 4, total: 3 } }, ['coverage', 'examined'], 'examined more than the total');
    roundTrips(Coverage, { complete: false, examined: 2, total: 3 });
    roundTrips(Coverage, { complete: true, examined: 2 });
  });
  test('counts are derived from the partitions: unknown counts items with an unchecked, no-verdict or not-run terminal', () => {
    const counts = partitionCountsOf(accepted.partitions as unknown as PartitionsType);
    assert.deepEqual(counts, { delivered: 2, rejected: 0, quarantined: 0, incomplete: 1, unknown: 1 });
    roundTrips(PartitionCounts, counts);
  });
});

describe('Envelope', () => {
  test('valid envelopes round-trip', () => {
    roundTrips(Envelope, { call_result: 'ok', errors: [], trace: TRACE });
    roundTrips(Envelope, { call_result: 'error', acceptance: 'not_accepted', errors: [{ code: 'CREDENTIAL_IN_UPLOAD', message: '上传里扫出明文凭据' }], trace: TRACE });
    roundTrips(Envelope, { call_result: 'ok', coverage: { complete: false, examined: 10, note: '分页未取完' }, next: 'c2', errors: [], trace: TRACE });
    roundTrips(Envelope, { call_result: 'ok', next: null, errors: [], trace: TRACE });
    roundTrips(Envelope, { call_result: 'ok', acceptance: 'accepted', errors: [{ code: 'core.coverage.shortfall', message: '未覆盖', item: 'doc-1:n2', rounds_left: 1 }], trace: TRACE });
  });
  test('invalid envelopes are rejected', () => {
    rejects(Envelope, { call_result: 'transport_failure', errors: [], trace: TRACE }, 'transport failure is never a tool result');
    rejects(Envelope, { call_result: 'ok', errors: [], trace: TRACE.toUpperCase() }, 'uppercase trace');
    rejects(Envelope, { call_result: 'ok', errors: [], trace: '0'.repeat(32) }, 'all-zero trace');
    rejects(Envelope, { call_result: 'ok', trace: TRACE }, 'errors missing');
    rejects(Envelope, { call_result: 'ok', acceptance: 'maybe', errors: [], trace: TRACE }, 'acceptance');
    rejects(Envelope, { call_result: 'ok', errors: [{ code: '', message: 'x' }], trace: TRACE }, 'empty code');
    rejects(Envelope, { call_result: 'ok', errors: [{ code: 'X', message: 'x', path: 'items/0' }], trace: TRACE }, 'path is a JSON Pointer');
    rejects(Envelope, { call_result: 'ok', errors: [], trace: TRACE, extra: 1 }, 'unknown key');
  });
  test('call_result agrees with isError and the receipt (D05 R[1])', () => {
    rejectsAt(Envelope, { call_result: 'error', errors: [], trace: TRACE }, ['errors'], 'an error without a code');
    rejectsAt(Envelope, { call_result: 'error', acceptance: 'accepted', errors: [{ code: 'X', message: 'x' }], trace: TRACE }, ['acceptance'], 'accepted but an error');
    rejectsAt(Envelope, { call_result: 'ok', acceptance: 'not_accepted', errors: [], trace: TRACE }, ['acceptance'], 'not accepted but ok');
  });
});

describe('ids, runs and records', () => {
  test('ids are a prefix and a lowercase Crockford ULID', () => {
    roundTrips(RunId, RUN);
    roundTrips(UserId, USER);
    roundTrips(RecordId, 'rcd_7zzzzzzzzzzzzzzzzzzzzzzzzz');
    for (const bad of ['run_8zzzzzzzzzzzzzzzzzzzzzzzzz', 'run_01jacd5z8q3w7v9h2k4m6n8p0i', 'run_01jacd5z8q3w7v9h2k4m6n8p0l', 'run_01jacd5z8q3w7v9h2k4m6n8p0o', USER]) {
      rejects(RunId, bad, 'not a run id');
    }
    roundTrips(TraceId, TRACE);
    roundTrips(JsonPointer, '');
    roundTrips(JsonPointer, '/a~1b/0');
    rejects(JsonPointer, 'a', 'no leading slash');
  });
  test('a run summary and a run record round-trip', () => {
    roundTrips(RunSummary, summary);
    roundTrips(RunRecord, runRecord);
    roundTrips(RunRecord, hubRun);
    rejects(RunRecord, { ...runRecord, host: 'laptop' }, 'execution host');
    rejects(RunSummary, { ...summary, sources: [{ reference: `src:${H}`, role: 'evidence' }] }, 'source role');
    rejects(SourceBinding, { reference: `src:${H}`, role: 'expected', external: 'story-42' }, 'external identity');
    rejects(RunSummary, { ...summary, items: [{ ...summary.items[0], reuse: `src:${H}` }] }, 'reuse is a Hub record reference');
    rejects(RunSummary, { ...summary, slots: { schema: {}, sha256: 'x' } }, 'slot schema digest');
    rejects(RunSummary, { ...summary, phase: 'running' }, 'phase is never stored (W06 R[2]); unknown key');
  });
  test('a run names its runner unless the Hub executes a standing obligation (W06 F[0]-F[1], W09)', () => {
    rejectsAt(RunRecord, { ...runRecord, runner: undefined }, ['runner'], 'a client run without runner');
    rejectsAt(RunRecord, { ...hubRun, runner: USER }, ['runner'], 'a Hub run with a runner');
    rejectsAt(RunRecord, { ...hubRun, trigger: 'session' }, ['trigger'], 'the Hub executes only standing obligations');
    rejectsAt(RunRecord, { ...hubRun, configurer: undefined }, ['configurer'], 'a standing obligation without configurer');
    rejectsAt(RunRecord, { ...runRecord, host: 'bot', trigger: 'event_or_schedule' }, ['configurer'], 'an event trigger without configurer');
    roundTrips(RunRecord, { ...runRecord, host: 'bot', trigger: 'event_or_schedule', configurer: USER, executors: H2 });
    assert.equal(RunRecord.safeParse({ ...hubRun, configurer: ADMIN }).success, true);
  });
  test('a client key is stored with the digest of the arguments it was bound to and its window (D05 R[4])', () => {
    const { request_digest: _d, ...withoutDigest } = runRecord;
    rejectsAt(RunRecord, withoutDigest, ['client_key'], 'key without request digest');
    const { client_key_expires_at: _e, ...withoutWindow } = runRecord;
    rejectsAt(RunRecord, withoutWindow, ['client_key'], 'key without window');
    const { client_key: _k, request_digest: _r, client_key_expires_at: _w, ...unkeyed } = runRecord;
    roundTrips(RunRecord, unkeyed);
  });
  test('the record envelope uses registered schema names', () => {
    const record = { id: 'rcd_01jacd5z8q3w7v9h2k4m6n8p0t', kind: 'validation_result', schema: 'validation@1', digest: H, provenance: 'observed', created_at: '2026-10-21T08:00:00Z', body: accepted };
    roundTrips(RecordEnvelope, record);
    for (const id of Object.keys(SCHEMA_REGISTRY)) roundTrips(RecordEnvelope, { ...record, schema: id });
    rejects(RecordEnvelope, { ...record, kind: 'note' }, 'record kind');
    rejects(RecordEnvelope, { ...record, schema: 'validation' }, 'schema without major');
    rejects(RecordEnvelope, { ...record, schema: 'validation@01' }, 'major with a leading zero');
    rejects(RecordEnvelope, { ...record, provenance: 'model' }, 'provenance type');
    rejects(RecordEnvelope, { ...record, size: 1 }, 'unknown key');
    rejects(SchemaId, 'claim@01', 'claim@01 and claim@1 cannot both exist');
    for (const id of ['claim@1', 'record@1', 'run@1', 'run-summary@1', 'pack-summary@1', 'submission@1', 'submission-received@1', 'validation@1']) assert.ok(id in SCHEMA_REGISTRY, id);
  });
});
