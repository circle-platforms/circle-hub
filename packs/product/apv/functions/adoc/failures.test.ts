import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compileAdoc } from './index.ts';
import { verifyOrigin } from './origins.ts';

const group = (files: Record<string, string>, attributes = {}) => ({ main: 'book.adoc', revision: '42', attributes, files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: createHash('sha256').update(text).digest('hex') }])) });

test('missing includes, options, inactive conditional includes, URI and traversal all reject the whole group', async () => {
  for (const text of ['include::missing.adoc[]', 'include::a.adoc[lines=1..2]', 'include::a.adoc[tags=x]', 'include::a.adoc[leveloffset=+1]', 'ifdef::missing[]\ninclude::a.adoc[]\nendif::missing[]', 'include::https://192.0.2.1/a.adoc[]', 'include::/a.adoc[]', 'include::../a.adoc[]', 'include::dir\\a.adoc[]', 'include::{undefined}[]']) {
    const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\n' + text, 'a.adoc': '== Included\n\nContent.' }));
    assert.equal(out.ok, false, text); assert.equal('model' in out, false); assert.equal('composition' in out, false);
    if (!out.ok) assert.match(out.error.next_action, /重跑/);
  }
});
test('cycles, depth, repeated include count and expanded byte limits are independent failures', async () => {
  const cyclic = await compileAdoc(group({ 'book.adoc': 'include::a.adoc[]', 'a.adoc': 'include::book.adoc[]' }));
  assert.ok(!cyclic.ok && cyclic.error.code.endsWith('include_cycle'));
  const deep = await compileAdoc(group({ 'book.adoc': 'include::a.adoc[]', 'a.adoc': 'include::b.adoc[]', 'b.adoc': 'End.' }), { includeDepth: 2 });
  assert.ok(!deep.ok && deep.error.code.endsWith('include_depth'));
  const repeated = group({ 'book.adoc': 'include::a.adoc[]\ninclude::a.adoc[]', 'a.adoc': 'Some content.' });
  assert.equal((await compileAdoc(repeated, { includes: 1 })).ok, false);
  assert.equal((await compileAdoc(repeated, { expandedBytes: 10 })).ok, false);
});
test('one revision or digest mismatch, even in an unreferenced supplied file, fails closed', async () => {
  const input = group({ 'book.adoc': '= Synthetic\n\nGood.', 'other.adoc': 'Unused.' });
  const revision = structuredClone(input); revision.files['other.adoc'].revision = '43';
  const digest = structuredClone(input); digest.files['other.adoc'].sha256 = '0'.repeat(64);
  for (const bad of [revision, digest]) assert.equal((await compileAdoc(bad)).ok, false);
});
test('time attributes are rejected in definitions, references, conditions and declarations', async () => {
  for (const text of ['{docdate}', '{localtime}', ':docyear: 2040', 'ifdef::docdatetime[]\nText.\nendif::docdatetime[]', 'ifndef::localyear[]\nText.\nendif::localyear[]']) {
    const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\n' + text }));
    assert.ok(!out.ok && out.error.code.endsWith('clock_attribute'), text);
  }
  assert.equal((await compileAdoc(group({ 'book.adoc': 'Text.' }, { localdate: '' }))).ok, false);
});
test('malformed and unsupported condition syntax cannot silently remove content', async () => {
  for (const text of ['ifdef::flag[]\nMissing end.', 'endif::flag[]', 'ifdef::flag[]\nWrong end.\nendif::other[]', 'ifeval::[1 == 1]\nText.\nendif::[]']) {
    assert.equal((await compileAdoc(group({ 'book.adoc': text }))).ok, false, text);
  }
});
test('source mapping cites one line only: the cursor decides between identical lines, and the reread of the original stays independent', () => {
  const input = group({ 'book.adoc': 'same\nsame\nactual' });
  const rows = [{ file: 'book.adoc', line: 1, text: 'same' }, { file: 'book.adoc', line: 2, text: 'same' }];
  // Two adjacent lines hold this exact text, so both are reachable from the cursor: the engine's own cursor says which
  // one the block came from, and the report says a choice was made among candidates.
  const first = verifyOrigin('same', 'paragraph', 1, rows, new Set([0, 1]), input);
  assert.deepEqual(first.origins.map((origin) => origin.selector), ['l/1']);
  assert.equal(first.chosenAmong, 2);
  assert.deepEqual(verifyOrigin('same', 'paragraph', 2, rows, new Set([0, 1]), input).origins.map((origin) => origin.selector), ['l/2']);
  // A candidate the cursor cannot reach — a line of prose between them — is another block's line and is not cited.
  const apart = [
    { file: 'book.adoc', line: 1, text: 'same' },
    { file: 'book.adoc', line: 2, text: '别的正文' },
    { file: 'book.adoc', line: 3, text: 'same' },
  ];
  const reached = verifyOrigin('same', 'paragraph', 1, apart, new Set([0, 1, 2]), input);
  assert.deepEqual(reached.origins.map((origin) => origin.selector), ['l/1']);
  assert.equal(reached.chosenAmong, 1, 'the unreachable twin is filtered out before the count, so nothing is disclosed as a choice');
  // Two reachable candidates and a cursor on neither: the choice stays open and nothing is cited.
  const control = [
    { file: 'book.adoc', line: 1, text: 'same' },
    { file: 'book.adoc', line: 2, text: 'ifdef::brand[]' },
    { file: 'book.adoc', line: 3, text: 'same' },
  ];
  const open = verifyOrigin('same', 'paragraph', 2, control, new Set([0, 2]), input);
  assert.deepEqual(open.origins, []);
  assert.match(open.reason, /候选行不唯一/);
  const forged = verifyOrigin('forged', 'paragraph', 1, [{ file: 'book.adoc', line: 3, text: 'forged' }], new Set([0]), input);
  assert.deepEqual(forged.origins, []);
  assert.match(forged.reason, /原件/);
});

test('overlong headings are reported as source problems and are not promoted to sections', async () => {
  const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\n======= Not a legal heading\n\nA paragraph.' }));
  assert.ok(out.ok, JSON.stringify(out)); assert.equal(out.report.invalid_headings.length, 1);
  assert.ok(!out.model.blocks.some((b) => b.kind === 'section' && b.title === 'Not a legal heading'));
});
test('input key ordering does not change the composed identity or output bytes', async () => {
  const a = group({ 'book.adoc': '= Synthetic\n\ninclude::a.adoc[]', 'a.adoc': '== A\n\nText.' }, { z: 'last', a: 'first' });
  const b = { ...a, files: Object.fromEntries(Object.entries(a.files).reverse()), attributes: { a: 'first', z: 'last' } };
  assert.equal(JSON.stringify(await compileAdoc(a)), JSON.stringify(await compileAdoc(b)));
});

test('a later chapter with an unterminated block cannot yield an applicable partial group', async () => {
  const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\ninclude::good.adoc[]\ninclude::bad.adoc[]', 'good.adoc': '== Good\n\nVerified text.\n\n', 'bad.adoc': '== Bad\n\n----\nUnterminated.' }));
  assert.ok(!out.ok && out.error.code.endsWith('engine_parse'), JSON.stringify(out));
  assert.equal('model' in out, false); assert.equal('composition' in out, false);
});
