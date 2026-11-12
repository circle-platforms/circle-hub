// Model 48 (issue 241): the mark of a layer that never ran, and what stands in place of an absent value.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {MODEL_VERSION} from '../generated/protocol.ts';
import {EXIT_NOT_RECORDED} from './validation.ts';
const model=JSON.parse(readFileSync(new URL('../model.json',import.meta.url),'utf8'));

test('model 48: an unknown keeps its own mark and colour; a layer that never ran has a mark of its own, not the question mark',()=>{
 assert.ok(model.version>=48);assert.equal(MODEL_VERSION,model.version);
 const rule:string=model.displayRules[5].rule;
 assert.ok(rule.startsWith('“未知”有自己的符号与颜色，不得显示为失败或成功'));
 assert.ok(rule.includes('动态层没有运行也是未知，用未知的颜色和它自己的符号'));
 assert.ok(rule.includes('问号只用于看过而没有结论的情形，不用于没有运行'));
 // The rule names the notice of an older result by the words the code writes (decision 158, W22).
 assert.ok(rule.includes(`显示“${EXIT_NOT_RECORDED}”，不补造`));assert.ok(!rule.includes('出口未写'));
});

test('model 48: an absent value says why it is absent and is never a dash',()=>{
 const rule:string=model.displayRules[21].rule;
 for(const part of ['缺失的值写明原因，不写破折号','“未记录”','“不适用”','“暂无数据”','分不清是哪一种时写“未知”，不猜','issue #241'])assert.ok(rule.includes(part),part);
 assert.equal(model.displayRules.length,22);
});
