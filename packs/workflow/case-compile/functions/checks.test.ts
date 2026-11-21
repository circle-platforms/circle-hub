import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCommandsKnown, checkContractShape, checkExpectedSources } from './checks.ts';
import { fixture, positiveBlocks } from '../testing/blocks.ts';
import { profileDocument } from '../testing/runtime.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import { commandSubject, quoteSubject } from './subject.ts';
import { readSlots } from './slots.ts';
import { COMMAND_CATALOG,goodData, subjectOf, CONTRACT_DOC, PROFILE_DOC, MANIFEST_DOC, COMMAND_IDENTITIES, QUOTE } from './test-support.ts';
import { replacedQuote, deniedCommand } from './addresses.ts';
const group = () => ({ kind: 'case-compile', contract: CONTRACT_DOC, profile: PROFILE_DOC, manifest: MANIFEST_DOC, leases: { now: '2026-10-23T02:00:00.000Z', entries: [] } });
test('catalog subject contains device command roles only, never host shell', () => {
  const out = commandSubject({ slots: { plan: [{ data: goodData() }] }, item: {id:'doc-1:c-1',fields:{command_identities:COMMAND_IDENTITIES}}, context: {command_policy:COMMAND_CATALOG.policy,root:COMMAND_CATALOG.root, groups: [group()] } }) as { command_identities: unknown };
  assert.deepEqual(out.command_identities, COMMAND_IDENTITIES);
});
test('quote subject uses original unmodified source text', () => {
  const out = quoteSubject({catalog:COMMAND_CATALOG.entries,catalog_complete:true, slots: { plan: [{ data: goodData() }] }, item: {id:'doc-1:c-1',fields:{command_identities:COMMAND_IDENTITIES}}, context: {command_policy:COMMAND_CATALOG.policy,root:COMMAND_CATALOG.root, groups: [group()] } }) as { quotes: unknown[] };
  assert.deepEqual(out.quotes, [QUOTE]);
});
test('grounded final expectation follows the command it judges', () => assert.equal(checkExpectedSources(subjectOf(goodData()))[0].verdict, 'support'));
for (const [name, mutate, code] of [
  ['no expectation', (v: any) => { v.expects = []; }, 'expect_without_source'],
  ['unquoted', (v: any) => { v.expects[0].quote.reference = ''; }, 'expect_without_source'],
  ['invented expectation', (v: any) => { v.expects[0].text = '模型补写的结果'; }, 'expect_not_in_quote'],
  ['after waiting', (v: any) => { v.expects[0].after = 3; }, 'expect_after'],
  ['out of range', (v: any) => { v.expects[0].after = 99; }, 'expect_after'],
] as const) test(`expectation rule: ${name}`, () => { const data = goodData(); mutate(data); assert.ok(checkExpectedSources(subjectOf(data)).some((v) => v.code === `case-compile.${code}`)); });
test('expectation is an exact fragment of the quote after address replacement', () => {
  const data = goodData(); data.replacements = [{ case: '192.0.2.200', bed: '192.0.2.90' }]; data.expects[0].quote.text = '服务器 192.0.2.200 成功'; data.expects[0].text = '192.0.2.90 成功';
  assert.equal(checkExpectedSources(subjectOf(data))[0].code, 'case-compile.expect_not_in_quote');
  assert.equal(replacedQuote('192.0.2.1 192.0.2.10', [{ case: '192.0.2.1', bed: '192.0.2.90' }]), '192.0.2.1 192.0.2.10');
});
test('repeated verification is deterministic and emits no plan artifact', () => {
  const input = subjectOf(goodData()); const first = checkContractShape(input); assert.deepEqual(first, checkContractShape(input)); assert.ok(!JSON.stringify(first).includes('"plan":'));
});
test('retired host keyword matching cannot substitute for effect authority',()=>{for(const value of ['sudo re\"bo\"ot','reboot','echo ready'])assert.throws(()=>deniedCommand(value,['reboot']));});
test('an expectation can explicitly judge a host shell command', () => {
  const data = goodData(); data.expects[0].after = 2;
  assert.equal(checkExpectedSources(subjectOf(data))[0].verdict, 'support');
});

test('expectation quotation follows contextual East Asian whitespace without joining Latin values',()=>{
 for(const [fragment,text,match] of [
  ['页面跳转到\n首页','页面跳转到首页',false],
  ['状态 为 ready','状态为ready',false],
  ['Ａ Ｂ','ＡＢ',false],
  ['set  10\t0','set 10 0',false],
  ['set 10 0','set 100',false],
  ['a+b','a +b',false],
  ['a\u0085b','a b',false],
  ['a\ufeffb','a b',false],
 ] as const){const data=goodData();data.expects[0].quote.text=fragment;data.expects[0].text=text;const results=checkExpectedSources(subjectOf(data));assert.equal(results.every(v=>v.verdict==='support'),match,JSON.stringify({fragment,text,results}));if(!match)assert.ok(results.some(v=>v.code==='case-compile.expect_not_in_quote'&&v.pointer==='/data/expects/0/text'));}
 const replaced=goodData();replaced.replacements=[{case:'192.0.2.200',bed:'192.0.2.90'}];replaced.expects[0].quote.text='服务器\n192.0.2.200 成功';replaced.expects[0].text='服务器192.0.2.90成功';assert.equal(checkExpectedSources(subjectOf(replaced))[0].code,'case-compile.expect_not_in_quote');
});

test('checkCommandsKnown also separates downstream command refutes from block observation unknowns', () => {
 const base = fixture(), doc = structuredClone(base.contractDoc) as Record<string, any>;
 doc.runtime.block_model.output_methods = [];
 const contract = signTypedRuntime(doc), profile = structuredClone(base.profileDoc) as Record<string, any>;
 profile.workbook.template = (profileDocument(contract as Parameters<typeof profileDocument>[0]) as Record<string, any>).workbook.template;
 const mixed = structuredClone(positiveBlocks().CONFIG);
 mixed.blocks.pop();
 const outcomes = checkCommandsKnown(base.subject(mixed, { contract, profile }));
 assert.equal(outcomes.length, 2, JSON.stringify(outcomes));
 const refused = outcomes.find((o) => o.verdict === 'refute');
 const unknown = outcomes.find((o) => o.verdict === 'unknown');
 assert.ok(refused && refused.code === 'case-compile.method_forbidden', JSON.stringify(outcomes));
 assert.ok(unknown && unknown.reason === 'missing_input', JSON.stringify(outcomes));
 assert.ok(((refused as any).data.problems as Array<{ verdict: string }>).every((p) => p.verdict === 'refute'));
 assert.ok(((unknown as any).data.problems as Array<{ verdict: string }>).every((p) => p.verdict !== 'refute'));
});

test('precondition_source on flat steps passes readSlots and flows into quoteSubject for Hub verbatim check, while invalid shapes refute', () => {
  const valid = goodData();
  const manualQuote = { reference: 'knowledge:manual#widget-pair', text: 'Configure widget peer and challenge on both devices' };
  (valid.steps[0] as unknown as Record<string, unknown>).precondition_source = manualQuote;
  const parsed = readSlots(valid);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) {
    assert.deepEqual(parsed.slots.steps[0].precondition_source, manualQuote);
  }
  const out = quoteSubject({
    catalog: COMMAND_CATALOG.entries,
    catalog_complete: true,
    slots: { plan: [{ data: valid }] },
    item: { id: 'doc-1:c-1', fields: { command_identities: COMMAND_IDENTITIES } },
    context: { command_policy: COMMAND_CATALOG.policy, root: COMMAND_CATALOG.root, groups: [group()] },
  }) as { quotes: Array<{ reference: string; text: string }> };
  assert.ok(out.quotes.some((q) => q.reference === QUOTE.reference && q.text === QUOTE.text), 'retains expectation quote');
  assert.ok(out.quotes.some((q) => q.reference === manualQuote.reference && q.text === manualQuote.text), 'routes step precondition_source into quote@1');

  const badEmpty = goodData();
  (badEmpty.steps[0] as unknown as Record<string, unknown>).precondition_source = { reference: 'knowledge:manual#widget-pair', text: '' };
  assert.equal(readSlots(badEmpty).ok, false);
  const badQuote = quoteSubject({
    catalog: COMMAND_CATALOG.entries,
    catalog_complete: true,
    slots: { plan: [{ data: badEmpty }] },
    item: { id: 'doc-1:c-1', fields: { command_identities: COMMAND_IDENTITIES } },
    context: { command_policy: COMMAND_CATALOG.policy, root: COMMAND_CATALOG.root, groups: [group()] },
  }) as { blocked?: Array<{ code: string; pointer: string }> };
  assert.ok(badQuote.blocked?.some((b) => b.code === 'case-compile.slots_invalid' && b.pointer.includes('/precondition_source')), JSON.stringify(badQuote));

  const badExtra = goodData();
  (badExtra.steps[0] as unknown as Record<string, unknown>).precondition_source = { reference: 'knowledge:manual#widget-pair', text: 'ok', extra: 1 };
  assert.equal(readSlots(badExtra).ok, false);
});
