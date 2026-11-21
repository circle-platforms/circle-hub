import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkCommandsKnown} from './checks.ts';
import {selectCommandCatalog} from './subject.ts';
import {inverseLine,inverseLines,readCommandPolicy} from './generated/skills/command-tools/command-check/command-policy.ts';
import {ROOT,policy,fixture,cleanup} from '../testing/authority-scope.ts';
import {PROFILE_DOC,MANIFEST_DOC} from './test-support.ts';

const withoutInverse=(lines:Parameters<typeof fixture>[0])=>{
 const value=fixture(lines);const catalog=value.input.subject.command_catalog as {entries:Array<{words:string[]}>};
 catalog.entries=catalog.entries.filter(entry=>entry.words[0]!=='no');return value;
};

test('an inverse path the locked tree lacks is unknown and names the product author, never a cleanup the plan should add',()=>{
 const rows=checkCommandsKnown(withoutInverse(['demo pool add one 10']).input);
 const row=rows.find(value=>value.statement.includes('不在锁定树里'));
 assert.ok(row,JSON.stringify(rows));
 assert.equal(row.verdict,'unknown');
 assert.match(row.statement,/\/commands\/no\/demo\/pool\/add/);
 assert.match(row.statement,/产品包作者/);
 assert.match(row.statement,/不猜逆操作，也不改用范围更大的清除；先换一种在锁定树里有逐对象逆操作的等价写法，没有这样的写法才照实报告这个缺口/);
 assert.ok(!rows.some(value=>value.statement.includes('缺同设备、逆序的清理操作')),JSON.stringify(rows));
});

test('a cleanup left out of a plan is still the plan\'s to write when the tree has the inverse',()=>{
 const rows=checkCommandsKnown(fixture(['demo pool add one 10']).input);
 assert.ok(rows.some(value=>value.verdict==='refute'&&value.statement.includes('缺同设备、逆序的清理操作')),JSON.stringify(rows));
 assert.ok(!rows.some(value=>value.statement.includes('不在锁定树里')),JSON.stringify(rows));
});

test('the declared inverse is accepted as before',()=>{
 const rows=checkCommandsKnown(fixture(['demo pool add one 10',cleanup('no demo pool add one')]).input);
 assert.ok(rows.every(value=>value.verdict==='support'),JSON.stringify(rows));
});

test('the rule\'s line is the most specific rule\'s words and the rest of the command as written',()=>{
 const rules=readCommandPolicy({schema:'command-policy@1',read_only:['/commands/show'],inverse_rules:[{source_prefix:'/commands',inverse_prefix:'/commands/no'},{source_prefix:'/commands/demo/sync/to',inverse_prefix:'/commands/demo/sync/undo/peer',leading_parameters:1}]})!;
 assert.equal(inverseLine(rules,'demo sync to all'),'demo sync undo peer all');
 assert.equal(inverseLine(rules,'demo pool add "one two" 10'),'no demo pool add "one two" 10');
 assert.equal(inverseLine(rules,'"demo" sync to all'),'no "demo" sync to all');
 assert.equal(inverseLine(rules,'demo "unbalanced'),null);
});

test('the selection reads each rule line with the plan, and all of them or none when they do not fit its limit',()=>{
 const rules=readCommandPolicy(policy)!;
 assert.deepEqual(inverseLines(rules,['demo pool add one 10']),['no demo pool add one 10']);
 assert.deepEqual(inverseLines(rules,['demo pool add one 10','no demo pool add one 10']),[],'a line the plan already sends is not read twice');
 assert.deepEqual(inverseLines(null,['demo pool add one 10']),[]);
 const many=Array.from({length:70},(_,index)=>`demo pool add n${index} ${index}`);
 assert.deepEqual(inverseLines(rules,many),[]);
 assert.equal(inverseLines(rules,many.slice(0,64)).length,64);
});

test('the catalog selection adds the rule lines to what the plan and the author send, and reads no more',()=>{
 const value=fixture(['demo pool add one 10']);
 const raw={context:{root:ROOT,command_policy:policy,groups:[{kind:'case-compile',contract:value.contract,profile:PROFILE_DOC,manifest:MANIFEST_DOC}]},item:{id:'case-1',group:'frozen',fields:{steps:[{text:'demo pool add omitted 20'}]}},slots:{plan:value.data}};
 const selected=selectCommandCatalog(raw) as {lines:string[]};
 assert.deepEqual([...selected.lines].sort(),['demo pool add omitted 20','demo pool add one 10','no demo pool add omitted 20','no demo pool add one 10'].sort());
});
