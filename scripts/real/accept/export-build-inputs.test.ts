import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { caseCommandsGold } from '../gold/case-commands.ts';
import { compareCommandIndex } from './command-index.ts';
import { exportBuild, createDeps, main, prepareOutput, ExportError, type Deps, type ViewRead } from './export-build-inputs.ts';
import { openBed } from '../../../tests/acceptance/support/hub.ts';
import { agileOptions } from '../../../tests/fixtures/agile/index.ts';
import { productSite, twoNameProduct } from '../../../tests/acceptance/support/env.ts';
import { startPostgres } from '../../../hub/testing/postgres.ts';
import type { TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { memoryOperatorTokens } from '../../../hub/server/assemble/operator-token.ts';
import { CliError } from '../../../hub/server/errors.ts';
import { adminCommands } from '../../../hub/server/cli-admin.ts';
import type { CliContext } from '../../../hub/server/api.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, DEFAULT_SYNC, catalogXml, extraProducer, makeWorld, type World } from '../../../hub/knowledge/test-support.ts';
import { createKnowledgeReader } from '../../../hub/knowledge/api.ts';
import { FacetView, IndexView } from '../../../contracts/src/views.ts';
import type { KnownBuild } from '../../../contracts/src/product.ts';

const sha = (s: Uint8Array) => createHash('sha256').update(s).digest('hex');
const root = 'a'.repeat(64), id = 'b'.repeat(64);

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

/** A facet row list: `[value, entries]`, the null group last like the Hub sorts it. */
type FacetRows = Array<[string | number | boolean | null, number]>;
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'export-inputs-'));t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { token: 'synthetic-token-must-not-print', product: 'synthetic-product', build: 'synthetic-build', out: join(dir, 'out') };
  const entry = (digest: string, document: string | number) => ({entry:digest,kind:'case',statement:'',reference:`tree:${root}/@${digest}`,data:{commands:[],document,node:'synthetic-node'}});
  const view = (document = 'synthetic-doc') => ({schema:'index-view@1',kind:'case',key:'document',product:options.product,build:{root,build:options.build},unversioned:null,next:null,keys:{[document]:[id]},entries:{[id]:entry(id,document)},total_keys:1,total_entries:1,truncated:false,cut_keys:[],skipped:0,notes:[]});
  const facet = (rows: FacetRows, total: number, empty = 0) => ({schema:'facet-view@1',kind:'case',by:['document'],product:options.product,build:{root,build:options.build},unversioned:null,next:null,rows:rows.map(([document,count])=>({values:{document},count})),total,totals:{empty:{document:empty}},truncated:false,skipped:0,notes:[]});
  const map = Buffer.from('{"root":{"data":{"id":"synthetic-root","text":"Synthetic"}}}'),tree=Buffer.from('<synthetic/>');
  const list = (external:string, bytes:Buffer) => `${external}\t${sha(bytes)}\t${bytes.length} 字节\t2026-01-01T00:00:00.000Z\n`;
  const calls:string[][]=[];
  const deps:Deps = { index:async()=>({view:view(),root}), facets:async()=>({view:facet([['synthetic-doc',1]],1),root}), cli:async args=>{
    calls.push(args);
    if(args[1]==='export'){writeFileSync(args[4],args[2]===sha(map)?map:tree,{mode:0o600});return '';}
    if(args[3]==='buildsite:file:')return list(`buildsite:file:/synthetic/command_tree-${options.build}.xml`,tree);
    if(args[3]==='agile:case:synthetic-doc')return list('agile:case:synthetic-doc-extra',tree)+list('agile:case:synthetic-doc',map);
    return '';
  }};
  return {dir,options,deps,view,facet,entry,calls,map,tree,list};
}
/** Serves a synthetic mind-map original for every named document, plus the build's command tree. */
function serveMaps(f: ReturnType<typeof fixture>, documents: readonly string[]) {
  const cli = f.deps.cli;
  const mapOf = (document: string) => Buffer.from(JSON.stringify({ root: { data: { id: document, text: 'Synthetic' } } }));
  f.deps.cli = async args => {
    if (args[1] === 'list' && typeof args[3] === 'string' && args[3].startsWith('agile:case:')) {
      const document = args[3].slice('agile:case:'.length);
      return documents.includes(document) ? f.list(args[3], mapOf(document)) : '';
    }
    if (args[1] === 'export') for (const document of documents) if (args[2] === sha(mapOf(document))) { writeFileSync(args[4], mapOf(document), { mode: 0o600 }); return ''; }
    return cli(args);
  };
}

test('exports exact latest originals and compatible private manifests without identifiers on screen', async t=>{
  const f=fixture(t);const lines=await exportBuild(f.options,f.deps);
  assert.equal(readFileSync(join(f.options.out,'map-1.json'),'utf8'),f.map.toString());
  assert.equal(readFileSync(join(f.options.out,'command-tree.xml'),'utf8'),f.tree.toString());
  assert.equal(readFileSync(join(f.options.out,'maps.txt'),'utf8'),`${join(realpathSync(f.options.out),'map-1.json')}:synthetic-doc\n`);
  assert.equal(statSync(join(f.options.out,'index-1.json')).mode&0o777,0o600);
  assert.ok(!lines.join('\n').includes('synthetic'));assert.ok(!lines.join('\n').includes(f.options.token));
});
test('preserves the response original while decoding the map data string for the gold input',async t=>{
  const f=fixture(t),raw=Buffer.from(JSON.stringify({code:1000,data:f.map.toString('utf8')}));const cli=f.deps.cli;
  f.deps.cli=async args=>{
    if(args[1]==='list'&&args[3]==='agile:case:synthetic-doc')return f.list(args[3],raw);
    if(args[1]==='export'&&args[2]===sha(raw)){writeFileSync(args[4],raw,{mode:0o600});return '';}
    return cli(args);
  };
  await exportBuild(f.options,f.deps);
  assert.deepEqual(readFileSync(join(f.options.out,'original-map-1.json')),raw);
  assert.deepEqual(readFileSync(join(f.options.out,'map-1.json')),f.map);
});

/**
 * A truncated first page and the shards behind it: `shards` names every document with its entries, so the fixture can
 * serve the discovery view (a prefix of the keys) and one complete `only=` shard per document.
 */
function paged(f: ReturnType<typeof fixture>, shards: Record<string, string[]>, totals: { keys: number; entries: number }, listed: string[]) {
  const entries: Record<string, unknown> = {};
  const keys: Record<string, string[]> = {};
  for (const [document, ofDocument] of Object.entries(shards)) {
    keys[document] = [...ofDocument];
    for (const digest of keys[document]) entries[digest] = f.entry(digest, document);
  }
  const shardOf = (document: string) => ({
    schema: 'index-view@1', kind: 'case', key: 'document', product: f.options.product, build: { root, build: f.options.build }, unversioned: null, next: null,
    keys: { [document]: keys[document] }, entries: Object.fromEntries(keys[document].map(digest => [digest, entries[digest]])),
    only: [document], total_keys: 1, total_entries: shards[document].length, truncated: false, cut_keys: [], skipped: 0, notes: [],
  });
  /** One page of the discovery read: the named documents, the totals of the whole scan and the continuation it offers. */
  const pageOf = (documents: string[], page: { next?: string | null; truncated?: boolean; totals?: { keys: number; entries: number } }) => ({
    schema: 'index-view@1', kind: 'case', key: 'document', product: f.options.product, build: { root, build: f.options.build }, unversioned: null,
    next: page.next ?? null, truncated: page.truncated ?? false,
    keys: Object.fromEntries(documents.map(document => [document, keys[document]])),
    entries: Object.fromEntries(documents.flatMap(document => keys[document]).map(digest => [digest, entries[digest]])),
    total_keys: page.totals?.keys ?? totals.keys, total_entries: page.totals?.entries ?? totals.entries,
    cut_keys: [], skipped: 0, notes: page.truncated ? ['本页在取值 synthetic-zzz 处停止，按 next 续读剩余条目'] : [],
  });
  const whole = pageOf(listed, { truncated: true });
  const rows: FacetRows = Object.entries(shards).map(([document, ofDocument]) => [document, ofDocument.length] as [string, number]);
  return { shardOf, pageOf, whole, rows };
}

test('enumerates the complete key list from the facets view when the index page is truncated', async t=>{
  const f=fixture(t);
  // Two documents the truncated first page still lists, one it cut: its only entry was left unplaced at the root, so no
  // walk of the tree would ever name it (get_nodes lists the entries hung on nodes).
  const shards={ 'synthetic-doc':[id,'e'.repeat(64)], 'synthetic-other':['c'.repeat(64)], 'synthetic-unplaced':['d'.repeat(64)] };
  const p=paged(f,shards,{keys:3,entries:4},['synthetic-doc','synthetic-other']);
  const facetRows: FacetRows=[...p.rows,[null,1]];
  let reads=0,facets=0;
  f.deps.index=async external=>{reads++;const at=external.indexOf('&only=');return {view:at<0?p.whole:p.shardOf(decodeURIComponent(external.slice(at+6))),root};};
  f.deps.facets=async()=>{facets++;return {view:f.facet(facetRows,5,1),root};};
  const cli=f.deps.cli;const mapOf=(document:string)=>Buffer.from(JSON.stringify({root:{data:{id:document,text:'Synthetic'}}}));
  f.deps.cli=async args=>{
    if(args[1]==='list'&&typeof args[3]==='string'&&args[3].startsWith('agile:case:'))return f.list(args[3],mapOf(args[3].slice('agile:case:'.length)));
    if(args[1]==='export'){for(const document of Object.keys(shards))if(args[2]===sha(mapOf(document)))  {writeFileSync(args[4],mapOf(document),{mode:0o600});return '';}return cli(args);}
    return cli(args);
  };
  const lines=await exportBuild(f.options,f.deps);
  assert.equal(facets,1,'one facets read replaces the walk of every tree node');
  assert.equal(reads,4,'the discovery read and one shard per document');
  const saved=readdirSync(f.options.out).filter(n=>n.startsWith('index-')).sort();
  assert.deepEqual(saved,['index-1.json','index-2.json','index-3.json']);
  for(const name of saved){const view=IndexView.parse(JSON.parse(readFileSync(join(f.options.out,name),'utf8')));assert.equal(view.truncated,false);assert.deepEqual(Object.keys(view.keys).length,1);}
  assert.equal(readFileSync(join(f.options.out,'maps.txt'),'utf8').trim().split('\n').length,3);
  assert.match(lines[0],/索引 3 份；文档 3 份；用例 4 条；命令树 1 份/);
  assert.ok(!lines.join('\n').includes('synthetic'));assert.ok(!lines.join('\n').includes(f.options.token));
});

test('pages the index by its own continuation until the last page and cross-checks the facets view', async t=>{
  const f=fixture(t);
  // Page 1 lists one document and names a continuation; page 2 lists the other two, one of them carried only by an entry
  // the production left unplaced at the root, which no walk of the tree would ever name.
  const shards={ 'synthetic-doc':[id,'e'.repeat(64)], 'synthetic-other':['c'.repeat(64)], 'synthetic-unplaced':['d'.repeat(64)] };
  const p=paged(f,shards,{keys:3,entries:4},['synthetic-doc']);
  const nextId=`knowledge:index:synthetic-product:synthetic-build?kind=case&key=document&fields=commands,document,node&after=c3ludGhldGlj@${root}`;
  const pages=[p.pageOf(['synthetic-doc'],{next:nextId,truncated:true}),p.pageOf(['synthetic-other','synthetic-unplaced'],{next:null,truncated:false})];
  let indexReads=0,facetReads=0;
  f.deps.index=async external=>{indexReads++;const at=external.indexOf('&only=');return {view:at<0?pages.shift()!:p.shardOf(decodeURIComponent(external.slice(at+6))),root};};
  f.deps.facets=async()=>{facetReads++;return {view:f.facet([...p.rows,[null,1]],5,1),root};};
  serveMaps(f,Object.keys(shards));
  const lines=await exportBuild(f.options,f.deps);
  assert.equal(indexReads,5,'two discovery pages and one shard per document');
  assert.equal(facetReads,1,'the facets view is the cross-check, not the enumeration route');
  const saved=readdirSync(f.options.out).filter(n=>n.startsWith('index-')).sort();
  assert.deepEqual(saved,['index-1.json','index-2.json','index-3.json']);
  const views=saved.map(name=>IndexView.parse(JSON.parse(readFileSync(join(f.options.out,name),'utf8'))));
  assert.deepEqual(views.flatMap(view=>Object.keys(view.keys)).sort(),Object.keys(shards).sort());
  assert.ok(views.every(view=>view.truncated===false&&view.next===null));
  assert.equal(new Set(views.flatMap(view=>Object.keys(view.entries))).size,4);
  assert.match(lines[0],/索引 3 份；文档 3 份；用例 4 条；命令树 1 份/);
  assert.ok(!lines.some(line=>/续页/.test(line)),'every page was served, so no stopped-page fact');
});

test('finishes from the facets view when the Hub refuses a continuation page and says so', async t=>{
  const f=fixture(t);
  // The Hub refuses an `after` read of a page whose entries have unaccepted credential hits: the key list then comes from
  // the facets view, and the stopped page is reported instead of being guessed away.
  const shards={ 'synthetic-doc':[id], 'synthetic-other':['c'.repeat(64)], 'synthetic-unplaced':['d'.repeat(64)] };
  const p=paged(f,shards,{keys:3,entries:3},['synthetic-doc']);
  let indexReads=0;
  f.deps.index=async external=>{
    indexReads++;
    const at=external.indexOf('&only=');
    if(at>=0)return {view:p.shardOf(decodeURIComponent(external.slice(at+6))),root};
    if(external.includes('&after='))throw new ExportError('成功的管理员视图读取','核对产品、构建、管理员令牌和权限');
    return {view:p.pageOf(['synthetic-doc'],{next:`knowledge:index:x:x?kind=case&key=document&after=second@${root}`,truncated:true}),root};
  };
  f.deps.facets=async()=>({view:f.facet(p.rows,3),root});
  serveMaps(f,Object.keys(shards));
  const lines=await exportBuild(f.options,f.deps);
  assert.equal(indexReads,5,'the refused continuation, then one shard per document');
  assert.equal(readdirSync(f.options.out).filter(n=>n.startsWith('index-')).length,3);
  assert.match(lines[0],/索引 3 份；文档 3 份；用例 3 条/);
  assert.match(lines[1],/读不出的续页 1 次/,'the stopped page is a stated fact');
  assert.match(lines[1],/下一步|管理员/);
});

test('accepts zero documents only on answers that declare themselves complete and empty', async t=>{
  // A locked product-wide root may legitimately be empty: no case entries at all, both views complete.
  const empty=fixture(t);
  empty.deps.index=async()=>({view:{...empty.view(),keys:{},entries:{},total_keys:0,total_entries:0},root});
  empty.deps.facets=async()=>({view:empty.facet([],0),root});
  const lines=await exportBuild(empty.options,empty.deps);
  assert.match(lines[0],/索引 1 份；文档 0 份；用例 0 条；命令树 1 份/);
  assert.equal(readFileSync(join(empty.options.out,'maps.txt'),'utf8'),'');
  assert.ok(readFileSync(join(empty.options.out,'command-tree.xml')).length);
  assert.equal(JSON.parse(readFileSync(join(empty.options.out,'index-1.json'),'utf8')).total_keys,0);

  // Case entries that carry no document key at all: still a complete empty answer, and the count is stated.
  const noKeys=fixture(t);
  noKeys.deps.index=async()=>({view:{...noKeys.view(),keys:{},entries:{},total_keys:0,total_entries:0},root});
  noKeys.deps.facets=async()=>({view:noKeys.facet([[null,2]],2,2),root});
  const stated=await exportBuild(noKeys.options,noKeys.deps);
  assert.match(stated[0],/文档 0 份（有 2 条用例没有文档键）/);
});

test('refuses an empty answer that is not declared complete and empty', async t=>{
  const emptyIndex=()=>({keys:{},entries:{},total_keys:0,total_entries:0});
  // The facets view says it is truncated: its rows are not a complete enumeration, so zero keys proves nothing.
  const cut=fixture(t);
  cut.deps.index=async()=>({view:{...cut.view(),...emptyIndex()},root});
  cut.deps.facets=async()=>({view:{...cut.facet([],0),truncated:true,notes:['取值组合有 3 种，只列出按取值排序的前 0 种']},root});
  await assert.rejects(exportBuild(cut.options,cut.deps),e=>e instanceof ExportError&&e.missing==='确认完整且为空的文档键'&&/空答复不等于空根/.test(e.action)&&/受理凭据命中|修复来源/.test(e.action));

  // A continuation the Hub refused: the index may hold keys the export never saw.
  const stopped=fixture(t);
  stopped.deps.index=async external=>external.includes('&after=')
    ?Promise.reject(new ExportError('成功的管理员视图读取','核对权限'))
    :{view:{...stopped.view(),...emptyIndex(),truncated:true,next:`knowledge:index:x:x?kind=case&key=document&after=second@${root}`},root};
  stopped.deps.facets=async()=>({view:stopped.facet([],0),root});
  await assert.rejects(exportBuild(stopped.options,stopped.deps),e=>e instanceof ExportError&&e.missing==='确认完整且为空的文档键'&&/读不出的续页 1 次/.test(e.action));

  // An unauthorized facets read is never an empty answer.
  const denied=fixture(t);
  denied.deps.index=async()=>({view:{...denied.view(),...emptyIndex()},root});
  denied.deps.facets=async()=>{throw new ExportError('成功的管理员视图读取','核对权限');};
  await assert.rejects(exportBuild(denied.options,denied.deps),e=>e instanceof ExportError&&e.missing==='成功的管理员视图读取');

  // A note claiming an empty root is not evidence: the counts must say so.
  const noted=fixture(t);
  noted.deps.index=async()=>({view:{...noted.view(),...emptyIndex(),notes:['不分版本的根为空（清单完整，规格 0 份）']},root});
  noted.deps.facets=async()=>({view:{...noted.facet([],0),truncated:true},root});
  await assert.rejects(exportBuild(noted.options,noted.deps),e=>e instanceof ExportError&&e.missing==='确认完整且为空的文档键');
});

test('counts the entries the credential scan withheld and says so instead of refusing the export', async t=>{
  const f=fixture(t);
  // One document, two carriers: the Hub counts both and lists one, because the other's own text has a scan hit.
  const kept='c'.repeat(64), withheld='d'.repeat(64);
  const shard={...f.view('synthetic-doc'),keys:{'synthetic-doc':[kept]},entries:{[kept]:f.entry(kept,'synthetic-doc')},total_keys:1,total_entries:2,truncated:true,notes:['1 个条目的文字有凭据扫描命中，没有放进这个视图']};
  f.deps.index=async external=>({view:external.includes('&only=')?shard:{...shard,truncated:true},root});
  f.deps.facets=async()=>({view:f.facet([['synthetic-doc',2]],2),root});
  const cli=f.deps.cli;f.deps.cli=async args=>args[3]==='agile:case:synthetic-doc'?f.list(args[3],f.map):cli(args);
  const lines=await exportBuild(f.options,f.deps);
  assert.match(lines[0],/用例 1 条（另有 1 条被凭据扫描排除，没有进输入）/);
  assert.equal(JSON.parse(readFileSync(join(f.options.out,'index-1.json'),'utf8')).total_entries,2,'the shard keeps the total it was counted with');
});

test('refuses with the two counts when the facets view does not account for total_keys', async t=>{
  const f=fixture(t);
  const p=paged(f,{'synthetic-doc':[id],'synthetic-other':['c'.repeat(64)]},{keys:3,entries:2},['synthetic-doc']);
  f.deps.index=async()=>({view:p.whole,root});
  // The third key is missing from the rows: a value the facet view left out (its own notes say why).
  f.deps.facets=async()=>({view:{...f.facet(p.rows,2),truncated:true,notes:['2 种取值组合的文字有凭据扫描命中，没有列出']},root});
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&/total_keys/.test(e.missing)&&/索引 3 个/.test(e.missing)&&/分面/.test(e.action)&&!/重新生产并导出$/.test(e.action));
});

test('refuses when the entry totals of the two views do not agree', async t=>{
  const f=fixture(t);
  const p=paged(f,{'synthetic-doc':[id]},{keys:1,entries:3},['synthetic-doc']);
  f.deps.index=async()=>({view:p.whole,root});
  f.deps.facets=async()=>({view:f.facet(p.rows,9,1),root});
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&/total_entries 3/.test(e.missing)&&/同一快照|混着空的列表/.test(e.action));
});

test('refuses a document key that cannot be asked for or listed, naming the value class', async t=>{
  for(const [document,missing] of [['','可导出的文档键'],['__proto__','可列出的文档键']] as Array<[string,string]>){
    const f=fixture(t);
    f.deps.index=async()=>({view:{...f.view(),truncated:true,total_keys:1,total_entries:1},root});
    f.deps.facets=async()=>({view:f.facet([[document,1]],1),root});
    await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing===missing&&!!e.action);
  }
});

test('refuses a facets view of another snapshot, of another field or with unread sources', async t=>{
  for(const change of [{build:{root:'c'.repeat(64),build:'synthetic-build'}},{skipped:1},{by:['node']},{schema:'index-view@1'}]){
    const f=fixture(t);
    f.deps.index=async()=>({view:{...f.view(),truncated:true},root});
    f.deps.facets=async()=>({view:{...f.facet([['synthetic-doc',1]],1),...change},root:'build' in change?(change as any).build.root:root});
    await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&!!e.missing&&!!e.action);
  }
});

test('refuses a view whose deduplicated entry counts differ from the first page', async t=>{
  const f=fixture(t);
  const counts={total:4,placed:3,unplaced:1};
  f.deps.index=async()=>({view:{...f.view(),totals:{entry_counts:counts}},root});
  f.deps.facets=async()=>({view:{...f.facet([['synthetic-doc',1]],1),totals:{empty:{document:0},entry_counts:{...counts,total:9}}},root});
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing.startsWith('同一快照的条目计数')&&/重新生产或同步/.test(e.action));
});

test('stops on snapshot changes between index shards',async t=>{
  const f=fixture(t);let reads=0;
  f.deps.facets=async()=>({view:f.facet([['synthetic-doc',1]],1),root});
  f.deps.index=async()=>({view:++reads===1?{...f.view(),truncated:true}:{...f.view(),build:{root:'d'.repeat(64),build:f.options.build}},root:reads===1?root:'d'.repeat(64)});
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing==='同一快照的全部索引分片');
});

test('fails with a fixed missing fact and action for skipped sources, cut keys and root drift',async t=>{
  for(const change of [{skipped:1},{cut_keys:['synthetic-doc']},{build:{root:'c'.repeat(64),build:'synthetic-build'}}]){
    const f=fixture(t);f.deps.index=async()=>({view:{...f.view(),...change},root});
    await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&!!e.missing&&!!e.action);
  }
});
test('missing exact map fails rather than borrowing a prefix match',async t=>{
  const f=fixture(t);const cli=f.deps.cli;
  f.deps.cli=async args=>args[1]==='list'&&args[3]==='agile:case:synthetic-doc'?f.list('agile:case:synthetic-doc-extra',f.tree):cli(args);
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing.includes('1 份'));
});
test('rejects multiple command-tree paths without selecting one',async t=>{
  const f=fixture(t),cli=f.deps.cli;
  f.deps.cli=async args=>args[3]==='buildsite:file:'?f.list(`buildsite:file:/first/command_tree-${f.options.build}.xml`,f.tree)+f.list(`buildsite:file:/second/command_tree-${f.options.build}.xml`,f.tree):cli(args);
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing.includes('1 份'));
});
test('refuses modified original bytes and repository destinations including symlink ancestors',async t=>{
  const f=fixture(t);const cli=f.deps.cli;f.deps.cli=async args=>{const result=await cli(args);if(args[1]==='export')writeFileSync(args[4],'changed');return result;};
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing.includes('摘要'));
  assert.throws(()=>prepareOutput(join(process.cwd(),'synthetic-export')));
  const link=join(f.dir,'linked');symlinkSync(process.cwd(),link);assert.throws(()=>prepareOutput(join(link,'synthetic-export')));
});
test('argument and IO failures never print untrusted values or token file contents',async()=>{
  const lines:string[]=[];assert.equal(await main(['--token-file','sensitive-unreadable-name','--product','private-title','--build','private-build','--out','unused'],{out:s=>lines.push(s),error:s=>lines.push(s)}),1);
  assert.ok(!lines.join('').includes('private'));assert.ok(!lines.join('').includes('sensitive'));assert.match(lines.join(''),/下一步/);
  const refused:string[]=[];assert.equal(await main(['--token-file','x','--url','http://127.0.0.1:1/mcp','--product','p','--build','b','--out','unused'],{out:s=>refused.push(s),error:s=>refused.push(s)}),1);
  assert.match(refused.join(''),/完整命令参数/,'the retired --url flag is refused, not ignored');
});

// ---------------------------------------------------------------- against the real Hub views (synthetic data)

const BUILD = 'Rel_ACME_1_2_15';
function knownBuild(sources: Record<string, string | string[]>): KnownBuild {
  return { name: BUILD, family: 'ACME', line: '1.2', base: BUILD, platform: null, built_at: '2026-01-02T10:00:00.000Z', released_at: '2026-01-05T00:00:00.000Z', sources, root: null };
}
/** Reads a knowledge view the way the administrator CLI does: the reader's own bytes, parsed. */
async function viewRead(w: World, external: string): Promise<ViewRead> {
  const read = await createKnowledgeReader(w.knowledge).read(external, { principal: w.admin, run: null, purpose: '合成验收导出' });
  assert.equal(read.ok, true, read.ok ? '' : read.reason);
  if (!read.ok) throw new Error('unreachable');
  const original = read.artifacts.find(a => a.name === 'original');
  assert.ok(original);
  const source = await w.kit.artifacts.source(w.admin, original.artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  const view = JSON.parse(new TextDecoder().decode(source.bytes));
  return { view, root: view?.build?.root, unversioned: view?.unversioned?.root };
}

test('exports a truncated build whose entries are unplaced, withheld by the scan and without a document key', { timeout: 300_000 }, async t=>{
  const fragment=[{parser:'xml@1',selector:'x/catalog/group[1]'}];
  const caseEntries: Array<Record<string, unknown>>=[];
  const documents=Array.from({length:20},(_,d)=>`doc-${String(d).padStart(2,'0')}`);
  for(const document of documents)caseEntries.push({kind:'case',path:'/commands/system/reboot',statement:`用例 ${document}`,data:{document,node:`n-${document}`,commands:['/commands/system/reboot']},fragments:fragment,applicability:null});
  // A second carrier of the first document whose own text has a credential scan hit: counted, never listed.
  caseEntries.push({kind:'case',path:'/commands/net/ping',statement:'含凭据命中的用例',data:{document:documents[0],node:'DB_PASSWORD=synthetic-secret-1',commands:[]},fragments:fragment,applicability:null});
  // A document carried only by an entry the production left unplaced at the root (no command resolved, no placer model).
  caseEntries.push({kind:'case',path:null,statement:'没有命令的用例',data:{document:'zzz-unplaced',node:'n-loose',commands:[]},fragments:fragment,applicability:null});
  // An entry with no document key at all: the facets null group, never an index key.
  caseEntries.push({kind:'case',path:null,statement:'没有文档键的用例',data:{node:'n-none',commands:[]},fragments:fragment,applicability:null});
  // A byte budget that lists part of the keys only: the branch this test is about.
  const w=await makeWorld(postgres,{pack:{declaration:{producers:[DEFAULT_PRODUCERS[0],extraProducer('other',{entries:caseEntries})]}},knowledge:{limits:{maxViewBytes:64*1024+4000}}});
  t.after(()=>w.close());
  w.external.set(`site:tree:${BUILD}`,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  const produced=await w.knowledge.produceTree({product:w.product,build:knownBuild({tree:`site:tree:${BUILD}`})});
  assert.equal(produced.ok,true,produced.ok?'':produced.reason ?? '');
  assert.equal(produced.unplaced,2,'the two entries without a path stay unplaced at the root');
  const knowledgeRoot=produced.root as string;
  const options={token:'synthetic-token',product:w.product.id,build:BUILD,out:join(w.dir,'export-out')};

  const indexId=`knowledge:index:${options.product}:${options.build}?kind=case&key=document&fields=commands,document,node`;
  const first=IndexView.parse((await viewRead(w,indexId)).view);
  assert.equal(first.truncated,true,'the byte budget truncates the discovery read');
  assert.equal(first.total_keys,documents.length+1);
  assert.equal(first.total_entries,documents.length+2);
  assert.deepEqual(first.totals?.entry_counts,{total:23,placed:21,unplaced:2},'the structured counts: every case entry, placed on the tree or not');
  assert.ok(!Object.keys(first.keys).includes('zzz-unplaced'),'the cut key is not on the first page');
  // The fact the old route got wrong: no walk of the tree names the unplaced entry, however deep it goes.
  const walked=new Set<string>();
  const pending=['/'];
  while(pending.length){
    const path=pending.shift() as string;
    const page=await w.knowledge.getNodes({root:knowledgeRoot,paths:[path],depth:0},w.admin);
    for(const node of page?.nodes??[]){
      for(const entry of node.entries)if(entry.kind==='case'&&typeof entry.data?.document==='string')walked.add(entry.data.document);
      for(const child of node.children)pending.push(child.path);
    }
  }
  assert.ok(!walked.has('zzz-unplaced'),'get_nodes never lists an entry the production left unplaced');
  const facets=FacetView.parse((await viewRead(w,`knowledge:facets:${options.product}:${options.build}?kind=case&by=document`)).view);
  assert.equal(facets.truncated,false);
  assert.equal(facets.total-first.total_entries,facets.totals.empty.document,'total_entries is total minus the null group');
  assert.ok(facets.rows.some(row=>row.values.document==='zzz-unplaced'),'the facets view lists the unplaced document');

  const tree=Buffer.from('<synthetic/>');
  const mapOf=(document:string)=>Buffer.from(JSON.stringify({root:{data:{id:document,text:'Synthetic'}}}));
  const list=(external:string,bytes:Buffer)=>`${external}\t${sha(bytes)}\t${bytes.length} 字节\t2026-01-01T00:00:00.000Z\n`;
  const byDigest=new Map<string,Buffer>([[sha(tree),tree],...documents.map(document=>[sha(mapOf(document)),mapOf(document)] as [string,Buffer]),[sha(mapOf('zzz-unplaced')),mapOf('zzz-unplaced')]]);
  const reads:string[]=[];
  const readView=async(external:string)=>{reads.push(external);return viewRead(w,external);};
  const lines=await exportBuild(options,{
    index:readView,facets:readView,
    cli:async args=>{
      if(args[1]==='export'){const bytes=byDigest.get(args[2]);assert.ok(bytes,`no original for ${args[2]}`);writeFileSync(args[4],bytes,{mode:0o600});return '';}
      if(args[3]==='buildsite:file:')return list(`buildsite:file:/synthetic/command_tree-${options.build}.xml`,tree);
      if(typeof args[3]==='string'&&args[3].startsWith('agile:case:')){const document=args[3].slice('agile:case:'.length);return byDigest.has(sha(mapOf(document)))?list(args[3],mapOf(document)):'';}
      return '';
    },
  });
  const saved=readdirSync(options.out).filter(name=>name.startsWith('index-'));
  assert.equal(saved.length,first.total_keys,'one shard per document key the Hub counts');
  assert.equal(reads.filter(external=>external.startsWith('knowledge:facets:')).length,1);
  // A page whose entries have unaccepted credential hits offers no continuation (the Hub clears `next`), so the first page
  // is partial and the facets cross-check supplies the rest of the key list.
  assert.equal(first.next,null);
  assert.ok(Object.keys(first.keys).length<first.total_keys,'the first page does not list every key');
  assert.ok(!reads.some(external=>external.includes('&after=')),'no continuation was offered, so none was followed');
  const shards=saved.map(name=>IndexView.parse(JSON.parse(readFileSync(join(options.out,name),'utf8'))));
  const listed=new Set(shards.flatMap(shard=>Object.keys(shard.entries)));
  assert.equal(listed.size+1,first.total_entries,'every carrier except the one the scan withheld');
  assert.deepEqual(shards.flatMap(shard=>Object.keys(shard.keys)).sort(),[...documents,'zzz-unplaced'].sort());
  assert.match(lines[0],/用例 21 条（另有 1 条被凭据扫描排除，没有进输入）/);
  assert.ok(readFileSync(join(options.out,'maps.txt'),'utf8').trim().split('\n').length===documents.length+1);
  assert.ok(!lines.join('\n').includes('doc-00')&&!lines.join('\n').includes(options.token),'no identifier or token on screen');
});

test('refuses a real build whose facets view cannot account for the index totals', { timeout: 300_000 }, async t=>{
  const fragment=[{parser:'xml@1',selector:'x/catalog/group[1]'}];
  const caseEntries: Array<Record<string, unknown>>=Array.from({length:8},(_,d)=>({kind:'case',path:'/commands/system/reboot',statement:`用例 ${d}`.padEnd(120,'x'),data:{document:`doc-${String(d).padStart(2,'0')}`,node:`n${d}`.padEnd(60,'y'),commands:[]},fragments:fragment,applicability:null}));
  caseEntries.push({kind:'case',path:null,statement:'没有命令的用例',data:{document:'zzz-unplaced',node:'n-loose',commands:[]},fragments:fragment,applicability:null});
  const w=await makeWorld(postgres,{pack:{declaration:{producers:[DEFAULT_PRODUCERS[0],extraProducer('other',{entries:caseEntries})]}},knowledge:{limits:{maxViewBytes:64*1024+1500}}});
  t.after(()=>w.close());
  w.external.set(`site:tree:${BUILD}`,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  const produced=await w.knowledge.produceTree({product:w.product,build:knownBuild({tree:`site:tree:${BUILD}`})});
  assert.equal(produced.ok,true,produced.ok?'':produced.reason ?? '');
  const options={token:'synthetic-token',product:w.product.id,build:BUILD,out:join(w.dir,'export-refused')};
  const readView=(external:string)=>viewRead(w,external);
  // The index page lost keys and offers no continuation, and the facets view lost rows: the key identity stops the export.
  const partialIndex=async(external:string)=>{
    const read=await readView(external);
    if(!external.startsWith('knowledge:index:')||external.includes('&only='))return read;
    const view=IndexView.parse(read.view);
    const keptKey=Object.keys(view.keys)[0];
    return {view:{...view,keys:{[keptKey]:view.keys[keptKey]},entries:{[view.keys[keptKey][0]]:view.entries[view.keys[keptKey][0]]},truncated:true,next:null},root:read.root,unversioned:read.unversioned};
  };
  const shortFacets=async(external:string)=>{const read=await readView(external);const view=FacetView.parse(read.view);return {view:{...view,rows:view.rows.slice(0,1)},root:read.root,unversioned:read.unversioned};};
  await assert.rejects(exportBuild({...options,out:join(w.dir,'export-refused-keys')},{index:partialIndex,facets:shortFacets,cli:async()=>''}),
    (e:unknown)=>e instanceof ExportError&&/索引 9 个/.test(e.missing)&&/分页列出 1 个/.test(e.missing)&&/分面非空取值 1 行/.test(e.missing)&&/分面/.test(e.action));
  // The entry totals of the two views disagree: the second identity stops the export and names both sides.
  const wrongTotal=async(external:string)=>{const read=await readView(external);const view=FacetView.parse(read.view);return {view:{...view,total:view.total+3},root:read.root,unversioned:read.unversioned};};
  await assert.rejects(exportBuild({...options,out:join(w.dir,'export-refused-totals')},{index:readView,facets:wrongTotal,cli:async()=>''}),
    (e:unknown)=>e instanceof ExportError&&/total_entries 9/.test(e.missing)&&/分面 total 12/.test(e.missing)&&/同一快照|混着空的列表/.test(e.action));
});

test('a shard of the same product-wide composition passes although only= filters its unversioned totals', async t=>{
  const f=fixture(t);
  const scopeRoot='f'.repeat(64),composition='9'.repeat(64);
  const shards={ 'synthetic-doc':[id,'e'.repeat(64)], 'synthetic-other':['c'.repeat(64)] };
  const p=paged(f,shards,{keys:2,entries:3},['synthetic-doc']);
  // The product-wide root contributes one entry: the discovery read counts it, a shard asked for one build document does
  // not, so the summaries differ while both read the same composition (hub/knowledge/views.ts filters them by only).
  const scoped=(view:any,entries:number,documents:number)=>({...view,unversioned:{root:scopeRoot,composition,build:null,skipped_sources:0,totals:{entries,documents}}});
  const cli=f.deps.cli;const mapOf=(document:string)=>Buffer.from(JSON.stringify({root:{data:{id:document,text:'Synthetic'}}}));
  f.deps.cli=async args=>{
    if(args[1]==='list'&&typeof args[3]==='string'&&args[3].startsWith('agile:case:'))return f.list(args[3],mapOf(args[3].slice('agile:case:'.length)));
    if(args[1]==='export'){for(const document of Object.keys(shards))if(args[2]===sha(mapOf(document))){writeFileSync(args[4],mapOf(document),{mode:0o600});return '';}}
    return cli(args);
  };
  f.deps.facets=async()=>({view:scoped(f.facet(p.rows,3),1,1),root,unversioned:scopeRoot});
  let drift=false;
  f.deps.index=async external=>{
    const at=external.indexOf('&only=');
    if(at<0)return {view:scoped(p.whole,1,1),root,unversioned:scopeRoot};
    const shard=scoped(p.shardOf(decodeURIComponent(external.slice(at+6))),0,0);
    return {view:drift?{...shard,unversioned:{...shard.unversioned,composition:'8'.repeat(64)}}:shard,root,unversioned:scopeRoot};
  };
  const lines=await exportBuild(f.options,f.deps);
  assert.match(lines[0],/索引 2 份；文档 2 份；用例 3 条/);
  drift=true;
  f.options.out=join(f.dir,'out-drift');
  await assert.rejects(exportBuild(f.options,f.deps),e=>e instanceof ExportError&&e.missing==='同一快照的全部索引分片');
});

test('exports a truncated build that also reads a product-wide root and unplaced entries', { timeout: 300_000 }, async t=>{
  const fragment=[{parser:'xml@1',selector:'x/catalog/group[1]'}];
  const caseEntries: Array<Record<string, unknown>>=Array.from({length:12},(_,d)=>{
    const document=`doc-${String(d).padStart(2,'0')}`;
    return {kind:'case',path:'/commands/system/reboot',statement:`用例 ${document}`,data:{document,node:`n-${document}`,commands:[]},fragments:fragment,applicability:null};
  });
  caseEntries.push({kind:'case',path:null,statement:'没有命令的用例',data:{document:'zzz-unplaced',node:'n-loose',commands:[]},fragments:fragment,applicability:null});
  const scopeBuild={name:'Synthetic_10_6',base:'Synthetic_10_6',family:'ACME',line:'10.6',platform:null,built_at:null,released_at:'2026-10-24T00:00:00.000Z',sources:{tree:'site:tree:synthetic'}};
  const w=await makeWorld(postgres,{
    pack:{
      functions:{
        'plan.ts':`export default input => ({fetch:[],builds:[${JSON.stringify(scopeBuild)}],...(input.options.scope === false ? {} : {scope:{docs:'site:tree:scope'}}),done:true});`,
        'scope.ts':`export default input => ({entries:[{path:'/docs',kind:'case',statement:'合成产品级用例',data:{document:'synthetic-scope-document',module:'network'},fragments:[{slot:'docs',parser:'xml@1',selector:'x/catalog'}],applicability:null}],warnings:[]});`,
      },
      declaration:{
        sync:{...DEFAULT_SYNC,options:{scope:true}},
        producers:[...DEFAULT_PRODUCERS,{id:'docs',title:'文档',unversioned:true,function:{module:'functions/scope.ts'},inputs:{docs:{source:'docs'}}},extraProducer('other',{entries:caseEntries})],
      },
    },
    knowledge:{limits:{maxViewBytes:64*1024+2500}},
  });
  t.after(()=>w.close());
  w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  w.external.set('site:tree:scope',{bytes:'<catalog/>',mediaType:'application/xml'});
  await w.knowledge.syncProduct(w.product);
  const options={token:'synthetic-token',product:w.product.id,build:scopeBuild.name,out:join(w.dir,'export-scope')};
  const indexId=`knowledge:index:${options.product}:${options.build}?kind=case&key=document&fields=commands,document,node`;
  const first=IndexView.parse((await viewRead(w,indexId)).view);
  assert.equal(first.truncated,true,'the byte budget truncates the discovery read');
  assert.ok(first.unversioned?.root,'the product-wide root is part of the same scan');
  assert.equal(first.total_keys,14,'twelve build documents, the unplaced one and the product-wide one');
  const facets=FacetView.parse((await viewRead(w,`knowledge:facets:${options.product}:${options.build}?kind=case&by=document`)).view);
  assert.equal(facets.rows.length,14);
  assert.equal(facets.total,first.total_entries,'every carrier of a document key, placed, unplaced and product-wide');

  const tree=Buffer.from('<synthetic/>');
  const mapOf=(document:string)=>Buffer.from(JSON.stringify({root:{data:{id:document,text:'Synthetic'}}}));
  const list=(external:string,bytes:Buffer)=>`${external}\t${sha(bytes)}\t${bytes.length} 字节\t2026-01-01T00:00:00.000Z\n`;
  const byDigest=new Map<string,Buffer>([[sha(tree),tree]]);
  const reads:string[]=[];
  const readView=async(external:string)=>{reads.push(external);return viewRead(w,external);};
  const lines=await exportBuild(options,{
    index:readView,facets:readView,
    cli:async args=>{
      if(args[1]==='export'){const bytes=byDigest.get(args[2]);assert.ok(bytes);writeFileSync(args[4],bytes,{mode:0o600});return '';}
      if(args[3]==='buildsite:file:')return list(`buildsite:file:/synthetic/command_tree-${options.build}.xml`,tree);
      if(typeof args[3]==='string'&&args[3].startsWith('agile:case:')){const bytes=mapOf(args[3].slice('agile:case:'.length));byDigest.set(sha(bytes),bytes);return list(args[3],bytes);}
      return '';
    },
  });
  const saved=readdirSync(options.out).filter(name=>name.startsWith('index-'));
  assert.equal(saved.length,first.total_keys,'one shard per document key, product-wide and unplaced ones included');
  assert.equal(reads.filter(external=>external.startsWith('knowledge:facets:')).length,1);
  assert.ok(reads.some(external=>external.startsWith('knowledge:index:')&&external.includes('&after=')),'the discovery read follows the index continuation');
  const shards=saved.map(name=>IndexView.parse(JSON.parse(readFileSync(join(options.out,name),'utf8'))));
  assert.equal(new Set(shards.flatMap(shard=>Object.keys(shard.entries))).size,first.total_entries);
  assert.ok(shards.every(shard=>Object.keys(shard.keys).length===1&&!shard.truncated));
  assert.ok(shards.some(shard=>JSON.stringify(shard.unversioned)!==JSON.stringify(first.unversioned)),'only= filters the product-wide summary, so the snapshot check compares roots and compositions, not summaries');
  assert.match(lines[0],/索引 14 份；文档 14 份；用例 14 条；命令树 1 份/);
  assert.ok(!lines.join('\n').includes('doc-00')&&!lines.join('\n').includes(options.token));
});

test('accepts a locked product-wide root whose own answer declares it complete and without case documents', { timeout: 300_000 }, async t=>{
  const scopeBuild={name:'Synthetic_10_6',base:'Synthetic_10_6',family:'ACME',line:'10.6',platform:null,built_at:null,released_at:'2026-10-24T00:00:00.000Z',sources:{tree:'site:tree:synthetic'}};
  const w=await makeWorld(postgres,{pack:{
    functions:{
      'plan.ts':`export default input => ({fetch:[],builds:[${JSON.stringify(scopeBuild)}],...(input.options.scope === false ? {} : {scope:{docs:'site:tree:scope'}}),done:true});`,
      // The product-wide producer yields a definition, so the locked scope root exists and holds no case entry at all.
      'scope.ts':`export default input => ({entries:[{path:'/docs',kind:'definition',statement:'合成产品级说明',data:{module:'network'},fragments:[{slot:'docs',parser:'xml@1',selector:'x/catalog'}],applicability:null}],warnings:[]});`,
    },
    declaration:{sync:{...DEFAULT_SYNC,options:{scope:true}},producers:[...DEFAULT_PRODUCERS,{id:'docs',title:'文档',unversioned:true,function:{module:'functions/scope.ts'},inputs:{docs:{source:'docs'}}}]},
  }});
  t.after(()=>w.close());
  w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  w.external.set('site:tree:scope',{bytes:'<catalog/>',mediaType:'application/xml'});
  await w.knowledge.syncProduct(w.product);
  const options={token:'synthetic-token',product:w.product.id,build:scopeBuild.name,out:join(w.dir,'export-empty-scope')};
  const read=(external:string)=>viewRead(w,external);
  const first=IndexView.parse((await read(`knowledge:index:${options.product}:${options.build}?kind=case&key=document&fields=commands,document,node`)).view);
  assert.ok(first.unversioned?.root,'the product-wide root is part of the locked snapshot');
  assert.equal(first.total_keys,0);assert.equal(first.total_entries,0);
  assert.equal(first.truncated,false,'the answer declares itself complete');
  assert.equal(first.next,null);assert.equal(first.skipped,0);
  const facets=FacetView.parse((await read(`knowledge:facets:${options.product}:${options.build}?kind=case&by=document`)).view);
  assert.deepEqual(facets.rows,[]);assert.equal(facets.total,0);assert.equal(facets.totals.empty.document,0);
  assert.equal(facets.truncated,false);assert.equal(facets.next,null);assert.equal(facets.skipped,0);
  const treeBytes=Buffer.from('<synthetic/>');
  const lines=await exportBuild(options,{index:read,facets:read,cli:async args=>{
    if(args[1]==='export'){writeFileSync(args[4],treeBytes,{mode:0o600});return '';}
    if(args[3]==='buildsite:file:')return `buildsite:file:/synthetic/command_tree-${options.build}.xml\t${sha(treeBytes)}\t${treeBytes.length} 字节\t2026-01-01T00:00:00.000Z\n`;
    return '';
  }});
  assert.match(lines[0],/索引 1 份；文档 0 份；用例 0 条；命令树 1 份/);
  assert.equal(readFileSync(join(options.out,'maps.txt'),'utf8'),'');
  assert.deepEqual(readdirSync(options.out).filter(name=>name.startsWith('index-')),['index-1.json']);
  assert.equal(JSON.parse(readFileSync(join(options.out,'index-1.json'),'utf8')).total_keys,0);
});

test('administrator knowledge view and original export operate against the synthetic acceptance Hub', {timeout:180_000}, async t=>{
  const product=await twoNameProduct(),site=await productSite();
  const match=/_(\d+)_(\d+)_(\d+)_/.exec(site.RELEASED)!;
  const agile=JSON.parse(JSON.stringify(agileOptions()).replaceAll('ORBIT',product.names[0]).replaceAll('COMET',product.names[1]).replaceAll('7.1',match.slice(1).join('.')));
  // 喂入改造拿掉了构建根上的 cases 生产器。case_index 仍打开，用来确认文档读到了、只是不再写成 kind=case 条目。
  const bed=await openBed({postgres,syncOneName:false,syncTwoName:{options:{case_index:true}},agile});t.after(()=>bed.close());
  const dir=mkdtempSync(join(tmpdir(),'export-bed-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const kit=bed.hub.records,db=kit.database;
  const runsBefore=await kit.store.list({kind:'run',limit:1});
  const options={token:bed.hub.admin.token,product:bed.product.line,build:bed.site.RELEASED,out:join(dir,'out')};
  const context=(token:string,stdout:string[]):CliContext=>({
    io:{cwd:dir,stdout:s=>stdout.push(s),stderr:()=>{},env:{CIRCLE_HUB_TOKEN:token}},
    config:()=>({...kit.config,database:db,dataDir:kit.dataDir,logDir:join(kit.dataDir,'logs'),host:'127.0.0.1',port:0,keychain:{service:'synthetic',account:'synthetic'}}),
    records:async()=>kit,deps:async()=>{throw new Error('unused');},actingAdmin:async()=>bed.hub.admin.principal,
  });
  const commands=adminCommands();
  const runner:Parameters<typeof createDeps>[1]=async(args,env)=>{
    assert.equal(args[0],'bin/circle-hub');
    assert.ok(!args.includes(options.token));
    const stdout:string[]=[];
    const command=commands.find(c=>c.name===args[1]);assert.ok(command);
    const status=await command.run(args.slice(2),context(env.CIRCLE_HUB_TOKEN!,stdout));
    return {status,stdout:stdout.join('\n')};
  };
  const deps=createDeps(options,runner);
  const lines=await exportBuild(options,deps);
  assert.ok(readdirSync(options.out).some(n=>n.startsWith('index-')));
  assert.equal(readFileSync(join(options.out,'maps.txt'),'utf8'),'');
  assert.ok(readFileSync(join(options.out,'command-tree.xml')).length);
  const gold=caseCommandsGold(readFileSync(join(options.out,'command-tree.xml'),'utf8'),[]);
  assert.equal(gold.cases.length,0);
  const views=readdirSync(options.out).filter(n=>n.startsWith('index-')).map(n=>JSON.parse(readFileSync(join(options.out,n),'utf8')));
  assert.equal(views.length,1);
  assert.equal(views[0].total_keys,0);
  assert.equal(views[0].truncated,false);
  const comparison=compareCommandIndex(gold,views);
  assert.equal(comparison.verdict,'相等',JSON.stringify(comparison));
  assert.match(lines[0],/索引 1 份；文档 0 份；用例 0 条；命令树 1 份/);

  assert.ok(!lines.join('\n').includes(options.token));assert.ok(!lines.join('\n').includes(options.build));
  const viewCommand=commands.find(c=>c.name==='knowledge')!;
  const external=`knowledge:index:${options.product}:${options.build}?kind=case&key=document`;
  const document='synthetic-document';
  const output=join(dir,'view.json'),summary:string[]=[];
  await viewCommand.run(['view',external,'--only',encodeURIComponent(document),'--out',output],context(options.token,summary));
  const written=readFileSync(output),view=JSON.parse(written.toString('utf8'));
  assert.deepEqual(view.only,[document]);
  assert.deepEqual((await kit.store.list({kind:'run',limit:1})).items,runsBefore.items,'view export never creates a run');
  assert.equal(statSync(output).mode&0o777,0o600);
  assert.ok(summary.join('\n').includes(sha(written)));
  assert.ok(summary.join('\n').includes(JSON.stringify(view.totals)));
  assert.match(summary.join('\n'),/截断：否.*跳过：0/);
  for(const privateValue of [document,options.build,options.product,options.token])assert.ok(!summary.join('\n').includes(privateValue));
  await assert.rejects(viewCommand.run(['view',external,'--out',output],context(options.token,[])),/已存在/);
  assert.deepEqual(readFileSync(output),written);
  await assert.rejects(viewCommand.run(['view','knowledge:index:synthetic-private-original:synthetic-build?kind=case&key=document','--out',join(dir,'missing.json')],context(options.token,[])),(e:any)=>!!e.hint&&!e.message.includes('synthetic-private-original'));
  await assert.rejects(viewCommand.run(['view',external+'&only=x','--only','y','--out',join(dir,'duplicate.json')],context(options.token,[])),/不能同时/);

  const secondAdmin=await bed.hub.createUser('合成第二管理员','admin');
  const choose=commands.find(c=>c.name==='knowledge')!;
  const noToken=context('',[]);noToken.io.env={};
  noToken.actingAdmin=async as=>{if(as===undefined)throw new CliError('有多位管理员，要用 --as 指明', '加 --as 后重试');assert.equal(as,secondAdmin.principal.id);return secondAdmin.principal;};
  const noTokenCommand=adminCommands({tokens:()=>memoryOperatorTokens()}).find(c=>c.name==='knowledge')!;
  await assert.rejects(noTokenCommand.run(['view',external,'--out',join(dir,'ambiguous.json')],noToken),/多位管理员/);
  await noTokenCommand.run(['view',external,'--as',secondAdmin.principal.id,'--out',join(dir,'selected.json')],noToken);
  assert.ok(readFileSync(join(dir,'selected.json')).length);
  const brokenTokenStore=memoryOperatorTokens();brokenTokenStore.read=async()=>{throw new Error('synthetic-private-original http://192.0.2.12/internal');};
  const warnings:string[]=[];noToken.io.stderr=line=>warnings.push(line);
  await adminCommands({tokens:()=>brokenTokenStore}).find(c=>c.name==='knowledge')!.run(['view',external,'--as',secondAdmin.principal.id,'--out',join(dir,'token-read-fallback.json')],noToken);
  assert.deepEqual(warnings,[],'view export never relays token-store exception messages');

  await assert.rejects(choose.run(['view',external,'--as',secondAdmin.principal.id,'--out',join(dir,'other.json')],context(options.token,[])),/不能|不一致|只能/);
  // The added read command is administrator-only even if a caller can read the product through MCP.
  const reader=await bed.user('合成非管理员',[]);
  await assert.rejects(commands.find(c=>c.name==='knowledge')!.run(['view',`knowledge:index:${options.product}:${options.build}?kind=case&key=document`,'--out',join(dir,'denied.json')],context(reader.token,[])),/管理员/);
});
