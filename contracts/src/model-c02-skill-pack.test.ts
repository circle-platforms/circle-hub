import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {MODEL_VERSION} from '../generated/protocol.ts';
import {PACK_KIND,labelOf} from '../generated/vocabulary.ts';
const model=JSON.parse(readFileSync(new URL('../model.json',import.meta.url),'utf8'));
const element=(id:string)=>model.elements.find((e:{id:string})=>e.id===id);

test('model 45: the generic skill pack is written into C02 and T01, and the core names the skill it used (decision 157)',()=>{
 assert.ok(model.version>=45);assert.equal(MODEL_VERSION,model.version);
 const c02=element('C02'),t01=element('T01');
 assert.ok(c02.definition.includes('通用技能包')&&c02.rules[2].includes('通用技能包'),'the generic class may land in a generic skill pack');
 const rule:string=c02.rules[3];
 assert.ok(rule.startsWith('Hub 核心不导入产品包的代码'));
 assert.ok(rule.includes('只经该通用技能包的公开入口')&&rule.includes('directory_skill')&&rule.includes('SHA-256'),'the core reaches a skill through its entry and records which one it used');
 assert.ok(rule.includes('没有过渡形态')&&rule.includes('重新产出相同的树'),'no transition form, and old product packs reproduce the same trees');
 assert.ok(rule.includes('不补写'),'productions recorded before are not rewritten');
 assert.ok(rule.includes('决定 157')&&rule.includes('issue #34'));
 assert.ok(t01.definition.includes('通用技能包'));
 assert.equal(c02.changes45.length,1);assert.equal(t01.changes45.length,1);
 // The kind was in the vocabulary already; only the prose lacked it.
 assert.ok((PACK_KIND as readonly string[]).includes('skill'));assert.equal(labelOf('pack_kind','skill'),'通用技能包');
});
