import assert from 'node:assert/strict';
import {test} from 'node:test';
import {criterionReviewInstruction} from './criterion-changes.ts';
test('tree review inputs disclose a named capability gap instead of an impossible start command',()=>{
 const tree='tree:'+'a'.repeat(64)+'/manual@'+'b'.repeat(64),change={item:'one',criterion:tree,assertion:'合成声明',old:'旧',new:'新',grounds:[{reference:tree,quote:'依据'}]},instruction=criterionReviewInstruction('run_01m5pndtg70000000000000001','c'.repeat(64),change,'usr_01m5pndtg70000000000000001');
 assert.deepEqual(instruction.unsupported,[tree]);assert.ok(instruction.next_action.includes('能力缺口'));for(const text of [tree,'usr_01m5pndtg70000000000000001','rec:'+'c'.repeat(64),'run_01m5pndtg70000000000000001'])assert.ok(instruction.next_action.includes(text));assert.ok(!instruction.next_action.includes('start_run {'));assert.ok(instruction.next_action.includes('修复后'));
});
