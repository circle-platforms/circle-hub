import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REASON } from '../../../contracts/generated/vocabulary.ts';
import { LayerResult } from '../../../contracts/src/validation.ts';
import { bindRecovery, EXIT_BY_REASON } from './terminals.ts';

const context = { runner: 'usr_00000000000000000000000001', owner: 'usr_00000000000000000000000002', administrator: 'usr_00000000000000000000000003', due: '2026-10-25T00:00:00.000Z', location: 'item-a / requirement-a' };
test('every transitional reason has a complete named exit at the delivery boundary', () => {
  assert.deepEqual(Object.keys(EXIT_BY_REASON).sort(), [...REASON].sort());
  for (const reason of REASON) {
    const layer = bindRecovery({ layer:'static', terminal:'unchecked', reason }, context);
    assert.ok(layer.missing?.includes(context.location));
    assert.ok(LayerResult.safeParse(layer).success, reason);
    assert.equal(layer.exit?.due, context.due);
    assert.equal(layer.exit?.action, 'request');
  }
});
test('recovery retains every distinct missing fact and binds Hub-owned audiences rather than trusting a pack exit', () => {
  const layer=bindRecovery({layer:'static',terminal:'unchecked',reason:'missing_input'},context,[
    {verdict:'unknown',reason:'missing_input',missing:'缺少条目 A 的正文',statement:'未读正文',tier:'advisory',grounds:[]},
    {verdict:'unknown',reason:'integrity_unproven',missing:'缺少原件摘要相符的字节',statement:'摘要不符',tier:'advisory',grounds:[]},
  ]);
  assert.equal(layer.missing,'缺少条目 A 的正文');
  assert.deepEqual(layer.exit?.audience,{user:context.runner});
  assert.equal(layer.gaps?.[0].missing,'缺少原件摘要相符的字节');
  assert.deepEqual(layer.gaps?.[0].exit.audience,{user:context.administrator});
});

test('settled violations retain other unresolved causes rather than hiding their missing facts',()=>{
  const layer=bindRecovery({layer:'static',terminal:'violation',code:'core.structure.required_empty'},context,[{verdict:'unknown',reason:'missing_input',missing:'缺少第二份原件',statement:'缺第二份',grounds:[],tier:'advisory'}]);
  assert.equal(layer.terminal,'violation');
  assert.equal(layer.gaps?.[0].missing,'缺少第二份原件');
});
