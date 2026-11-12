import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parse,type DefaultTreeAdapterMap} from 'parse5';
import {html,table} from './html.ts';
import {technical,sourceBlock} from './presentation.ts';
import type {PageContext} from './pages.ts';

type Node=DefaultTreeAdapterMap['node'];
const text=(node:Node):string=>'value' in node?node.value:'childNodes' in node?node.childNodes.map(text).join(''):'';
const visible=(node:Node):string=>{
 if('tagName' in node&&node.tagName==='details'&&!node.attrs.some(a=>a.name==='open'))return node.childNodes.filter(child=>'tagName' in child&&child.tagName==='summary').map(text).join('');
 return 'value' in node?node.value:'childNodes' in node?node.childNodes.map(visible).join(''):'';
};

test('technical identifiers require an explicit view while the table retains a named scrolling region and selected canonical links',()=>{
 const hash='a'.repeat(64),url='/console/knowledge/space?scope=personal&root='+hash+'&entry='+hash;
 const source=table(['名称','版本'],[['合成知识',technical(html`<code>${hash}</code>`,'查看')]],'',undefined,{selected:0,hrefs:[url]}).text;
 assert.doesNotMatch(visible(parse(source)),new RegExp(hash));
 assert.match(visible(parse(source)),/合成知识查看/);
 assert.match(source,/class="ch-table-wrap" tabindex="0" role="region" aria-label="表格"/);
 assert.match(source,/class="is-selected" aria-selected="true"/);
 assert.match(source,/data-row-href="\/console\/knowledge\/space\?scope=personal&amp;root=/);
 assert.match(source,/<th scope="col">名称<\/th>/);
});

test('source panels use authorized readable names and exact quotations, with references behind view entries',async()=>{
 const sha='b'.repeat(64),quote='<合成逐字引文>';
 const ctx={principal:{id:'reader'},deps:{knowledge:{spaces:{source:async(_who:unknown,digest:string)=>{assert.equal(digest,sha);return {artifact:{body:{name:'合成来源.txt'}}};}}}}} as unknown as PageContext;
 const rendered=(await sourceBlock(ctx,'src:'+sha,quote)).text;
 // The link names the original it opens, in text kept for screen readers: several sources on a page carry the same words.
 assert.match(visible(parse(rendered)),/合成来源.txt打开原文：合成来源.txt<合成逐字引文>查看引用/);
 assert.ok(rendered.includes('打开原文<span class="ch-visually-hidden">：合成来源.txt</span></a>'));
 assert.doesNotMatch(visible(parse(rendered)),new RegExp(sha));
 assert.match(rendered,/&lt;合成逐字引文&gt;/);
 ctx.deps.knowledge.spaces!.source=async()=>null;
 const unavailable=(await sourceBlock(ctx,'src:'+sha)).text;
 assert.match(visible(parse(unavailable)),/无法打开/);assert.doesNotMatch(visible(parse(unavailable)),new RegExp(sha));
 assert.doesNotMatch(unavailable,/合成来源.txt|打开原文/);
});
