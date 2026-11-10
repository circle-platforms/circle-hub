// The grouped console preview and the host command's paragraph describe the same deletion; neither may drop a consequence.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {uiLabelOf} from '../../contracts/generated/vocabulary.ts';
import {DELETION_EFFECT,DELETION_EFFECT_GROUPS} from './member-deletion.ts';

// Each consequence the paragraph states, as the phrase the grouped preview must also carry.
const CONSEQUENCES=[
 '私人知识、原文和记忆','现有私人分享失效','转给执行删除的管理员','分享不随之转移','团队已取得的独立内容保留',
 '运行引用过的私人知识原文一并清除','根据不可用','待验证','旧密码、令牌、会话和同步请求均不能恢复该账户','此操作不可撤销',
];

test('the grouped preview keeps every consequence of the host command paragraph',()=>{
 const grouped=DELETION_EFFECT_GROUPS.flatMap(group=>[group.title,...group.items]).join('\n');
 for(const phrase of CONSEQUENCES){
  assert.ok(grouped.includes(phrase),`grouped preview lacks: ${phrase}`);
  if(phrase!=='待验证'&&phrase!=='根据不可用')assert.ok(DELETION_EFFECT.includes(phrase),`the paragraph no longer states: ${phrase} (update the list together with both texts)`);
 }
 // Formal labels come from the vocabulary in both forms, never from hand-written copies.
 for(const label of [uiLabelOf('pack_kind','workflow'),uiLabelOf('pack_kind','skill'),uiLabelOf('validity_status','grounds_purged'),uiLabelOf('knowledge_entry_status','unverified')]){
  assert.ok(grouped.includes(label),`grouped preview lacks the label ${label}`);
  assert.ok(DELETION_EFFECT.includes(label),`the paragraph lacks the label ${label}`);
 }
});

test('the grouped preview names who acts, what is removed, what stays and what cannot be undone, in short scannable items',()=>{
 assert.deepEqual(DELETION_EFFECT_GROUPS.map(group=>group.title),['将清除','将转移','将保留','引用和分享的影响','账户和登录','不可撤销']);
 for(const group of DELETION_EFFECT_GROUPS){
  assert.ok(group.items.length>0,group.title);
  for(const item of group.items)assert.ok(item.length<=60,`one item, one fact: ${item}`);
 }
 // The ambiguous "本机" is not used for the member's own copy: it names the device it means.
 assert.ok(!DELETION_EFFECT_GROUPS.flatMap(group=>group.items).some(item=>item.includes('本机')));
});
