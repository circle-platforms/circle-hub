import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {CSS} from './console/style.ts';
import {DESIGN_CSS} from './console/style.generated.ts';

const long='会话超时后需要重新认证，已建立的权限范围不随重试扩大；令牌撤销后的后续调用应重新检查当前权限，不能沿用撤销前缓存的结论。';

test('a knowledge folder names its scope, content and location, and its entries are cells that name their columns around a statement the layout can wrap',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());
 const owner=await hub.createUser('合成列表作者'),spaces=hub.hub.knowledge.spaces!,client=await openConsole(hub,owner.token);
 await spaces.ensure(owner.principal,owner.user.id);
 await spaces.write(owner.principal,{path:'/方法/认证',kind:'observation',statement:`${long}（第 1 条）`});
 await spaces.write(owner.principal,{path:'/方法/认证',kind:'pitfall',statement:`${long}（第 2 条）`});
 const reply=await client.get('/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,path:'/方法/认证',scope:'personal'}));
 assert.equal(reply.status,200);
 // The line that stays the same on every folder page, whatever the width: where the reader is, what is listed, and in which folder.
 assert.match(reply.body,/<p class="ch-meta" data-knowledge-context>范围：我的 · 内容：知识 · 位置：方法 › 认证<\/p>/);
 // The entry table is a view of its own: one statement per row, and every other cell names its column for the narrow layout.
 const table=/<table class="ch-table" data-view="knowledge-entries">([\s\S]*?)<\/table>/.exec(reply.body);assert.ok(table,'the entries are the knowledge-entries table');
 const rows=[...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(match=>match[1]).filter(row=>row.includes('data-statement'));
 assert.equal(rows.length,2,'both entries are rows');
 for(const row of rows){
  assert.equal((row.match(/data-statement/g)??[]).length,1,'one statement per row');
  for(const label of ['类型','分享范围','状态','被引用'])assert.ok(row.includes(`<span data-label="${label}">`),`${label} is labelled in each row`);
  assert.ok(row.includes('name="selected_entry"')||row.includes('aria-label="无法选择条目"'),'the selection control stays in the row');
  assert.ok(row.includes('会话超时后需要重新认证'),'the statement text is complete, not cut at the server');
 }
});

test('the knowledge list rules fit the table into its box and make rows of its cells on a narrow screen, in the console sheet and not in the shared design bundle',()=>{
 for(const rule of [
  '.ch-table[data-view="knowledge-entries"] { width: 100%; }',
  '.ch-table[data-view="knowledge-entries"] td:has([data-statement]) { white-space: normal; min-width: 14rem; }',
  '.ch-table[data-view="knowledge-entries"] thead { display: none; }',
  '.ch-table[data-view="knowledge-entries"] [data-label]::before { content: attr(data-label) "："; color: var(--text-tertiary); }',
 ])assert.ok(CSS.includes(rule),rule);
 const narrow=/@media \(max-width: 760px\) \{\n \.ch-table\[data-view="knowledge-entries"\] thead/.exec(CSS);assert.ok(narrow,'the row layout starts at the existing narrow breakpoint');
 assert.ok(!DESIGN_CSS.includes('knowledge-entries'),'the generated shared design bundle stays untouched');
});
