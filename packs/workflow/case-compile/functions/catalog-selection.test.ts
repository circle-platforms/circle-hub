// check-plan reads the catalog the way the Hub's selection reads it, over the tree a run download holds. Each piece that mirrors Hub
// code runs here beside the Hub's own function (hub/knowledge/catalog-selection.ts, through testing/hub-side.ts) on the same tree, so
// a change on the Hub's side is a red test here, and the words copied from it are pinned to its source. Synthetic commands only.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {lockedTree,selectedCatalog,SELECTION_LIMIT,UNREADABLE_PATH,type LockedTree} from './catalog-selection.ts';
import {treeLines,lockedTreeOf,RUN,type FlatCatalog} from '../testing/locked-tree.ts';
import {hubView} from '../testing/hub-side.ts';

type Row={[key:string]:any};
const ROOT='c'.repeat(64);
const signature=(id:string,params:Row[]=[{name:'pool',type:'string',native_type:{name:'STRING',declaration:'src:'+ROOT+'/xml@1/x/arg',grammar:'synthetic-tree@1'}}])=>({id,reference:'src:'+ROOT+'/xml@1/x/'+id+'/arguments',params});
const entry=(words:string[],id='1',params?:Row[])=>({words,signatures:[signature(words.join('/')+id,params)]});

/** What both sides answer for one selection of one tree: the entries (as the view gives them) or the words of the refusal. */
async function both(lines:Row[],tree:LockedTree,selection:unknown){
 const local=selectedCatalog(tree,selection),hub=await hubView(lines,selection);
 return {local,hub:'missing' in hub?hub:{entries:hub.entries}};
}

const catalog:FlatCatalog={root:ROOT,complete:true,entries:[
 entry(['widget','health','interval'],'1',[signature('p').params[0],{name:'value',type:'int',native_type:{name:'U16',declaration:'src:'+ROOT+'/xml@1/x/arg2',grammar:'synthetic-tree@1'}}]),
 entry(['widget','health','probe']),
 entry(['widget','pool','add']),
 entry(['widget','pool']),
 entry(['show','health']),
 entry(['gadget']),
 // Two definitions of one head are one entry with both signatures.
 entry(['widget','overload'],'a'),
 entry(['widget','overload'],'b',[{name:'mode',type:'string',native_type:{name:'STRING',declaration:'src:'+ROOT+'/xml@1/x/mode',grammar:'synthetic-tree@1'}}]),
 // A definition with a word that is another head's prefix, and a head whose words are NFC and NFD of the same text.
 entry(['widget','pooling']),
 entry(['café']),
 entry(['café'],'2'),
]};
const lines=treeLines(catalog),tree=lockedTreeOf(catalog);
// Definitions written from the manual have the words and no overload list: the product's producer does not make them catalog members.
const manual=lines.find(row=>row.path==='/commands/widget/pool/add')!;
manual.entries.push({entry:'d'.repeat(64),kind:'definition',statement:'widget pool add [manual text]',reference:`tree:${ROOT}/commands/widget/pool/add@${'d'.repeat(64)}`,data:{form:'signature',manual_name:'cli',words:['widget','pool','add'],params:[]}});
// A row that is not catalog data at all: no words.
lines.find(row=>row.path==='/commands/widget/health/probe')!.entries.push({entry:'e'.repeat(64),kind:'definition',statement:'broken',reference:`tree:${ROOT}/commands/widget/health/probe@${'e'.repeat(64)}`,data:{words:[],signatures:[]}});
const withManual=(()=>{const made=lockedTree(lines,{run:RUN,root:ROOT});if(typeof made==='string')throw new Error(made);return made;})();

test('the catalog check-plan selects is the catalog the Hub\'s selection answers, entry for entry',async()=>{
 for(const selected of [
  ['widget health interval pool1 5'],
  ['widget pool add pool1','widget pool add pool1','show health pool1'],
  ['widget overload x','gadget'],
  ['widget health "interval" pool1','widget health probe pool1'],
  ['widget "health" interval pool1'],
  ['nothing here','widget','','widget pool'],
  ['widget health interval \'pool1\' 5'],
  ['widget "unterminated'],
  ['widget pooling','widget pool'],
  ['café','café'],
  [],
 ]){
  const selection={base:'/commands',lines:selected},answer=await both(lines,withManual,selection);
  assert.deepEqual(answer.local,answer.hub,JSON.stringify(selected));
 }
 // The manual's definition and the row without words are not members, and the overloads of one head are one entry.
 const answer=selectedCatalog(withManual,{base:'/commands',lines:['widget pool add p','widget overload x','widget health probe p']});
 assert.ok('entries' in answer);
 const heads=answer.entries.map(row=>row.words.join(' '));
 assert.deepEqual(heads,['widget health probe','widget overload','widget pool','widget pool add'].sort());
 assert.equal(answer.entries.find(row=>row.words.join(' ')==='widget overload')!.signatures.length,2);
 assert.equal(answer.entries.find(row=>row.words.join(' ')==='widget pool add')!.signatures.length,1,'the manual\'s definition adds no overload');
 // Nothing below an unknown base.
 const nowhere=await both(lines,withManual,{base:'/nowhere',lines:['widget']});assert.deepEqual(nowhere.local,nowhere.hub);assert.deepEqual(nowhere.local,{entries:[]});
});

test('the Hub\'s limits are the local ones, with the Hub\'s words, and a selection over a limit is refused, never trimmed',async()=>{
 const many:FlatCatalog={root:ROOT,complete:true,entries:[...Array.from({length:513},(_,index)=>entry(['many'],String(index))),entry(['widget'])]};
 const manyLines=treeLines(many),manyTree=lockedTreeOf(many);
 const tokens=Array.from({length:129},()=>'widget').join(' ');
 for(const selected of [['many'],[tokens]]){
  const answer=await both(manyLines,manyTree,{base:'/commands',lines:selected});
  assert.ok('missing' in answer.local,JSON.stringify(selected).slice(0,40));assert.deepEqual(answer.local,answer.hub,JSON.stringify(selected).slice(0,40));
 }
 // 128 lines of at most 8192 bytes: the engine refuses what the store would never see.
 const tooMany=await both(manyLines,manyTree,{base:'/commands',lines:Array.from({length:129},(_,index)=>'widget '+index)});
 const tooLong=await both(manyLines,manyTree,{base:'/commands',lines:['x'.repeat(8193)]});
 const atLimit=await both(manyLines,manyTree,{base:'/commands',lines:Array.from({length:128},(_,index)=>'widget '+index)});
 for(const answer of [tooMany,tooLong])assert.deepEqual(answer.local,{missing:SELECTION_LIMIT}),assert.deepEqual(answer.local,answer.hub);
 assert.deepEqual(atLimit.local,atLimit.hub);assert.ok('entries' in atLimit.local,'128 lines are within the limit');
 // 1 MiB of entries, and 4096 nodes on the paths of the lines.
 const wide=(index:number)=>({id:'w'+index,reference:'src:'+ROOT+'/xml@1/x/'+index,params:[{name:'note',type:'string',description:'x'.repeat(400_000),native_type:{name:'STRING',declaration:'src:'+ROOT+'/xml@1/x/arg',grammar:'synthetic-tree@1'}}]});
 const heavy:FlatCatalog={root:ROOT,complete:true,entries:[0,1,2].map(index=>({words:['heavy'+index],signatures:[wide(index)]}))};
 const heavyAnswer=await both(treeLines(heavy),lockedTreeOf(heavy),{base:'/commands',lines:['heavy0','heavy1','heavy2']});
 assert.ok('missing' in heavyAnswer.local&&heavyAnswer.local.missing.includes('1 MiB'),JSON.stringify(heavyAnswer.local).slice(0,80));assert.deepEqual(heavyAnswer.local,heavyAnswer.hub);
 const chains:FlatCatalog={root:ROOT,complete:true,entries:Array.from({length:33},(_,chain)=>({words:Array.from({length:128},(__,at)=>`c${chain}w${at}`),signatures:[]}))};
 const chainLines=Array.from({length:33},(_,chain)=>Array.from({length:128},(__,at)=>`c${chain}w${at}`).join(' '));
 const chainAnswer=await both(treeLines(chains),lockedTreeOf(chains),{base:'/commands',lines:chainLines});
 assert.ok('missing' in chainAnswer.local&&chainAnswer.local.missing.includes('4096'),JSON.stringify(chainAnswer.local).slice(0,80));assert.deepEqual(chainAnswer.local,chainAnswer.hub);
 // The words are the Hub's own: the engine's two sentences in evaluate.ts, the others in the selection itself.
 const evaluate=readFileSync(new URL('../../../../hub/runs/engine/evaluate.ts',import.meta.url),'utf8');
 const selection=readFileSync(new URL('../../../../hub/knowledge/catalog-selection.ts',import.meta.url),'utf8');
 for(const words of [SELECTION_LIMIT,UNREADABLE_PATH])assert.ok(evaluate.includes(words),words);
 for(const words of ['单条命令超过 128 个语法令牌；拆分计划后重核','目录路径超过 4096 个节点；拆分计划后重核','所选路径超过 512 个目录条目；拆分计划后重核','所选目录超过 1 MiB；拆分计划后重核'])assert.ok(selection.includes(words),words);
});

test('a path the download lost is the Hub\'s unreadable path, and a download that is not this run\'s tree is no tree',async()=>{
 const cut=structuredClone(lines.slice(1)) as Row[];
 const widget=cut.find(row=>row.path==='/commands/widget')!;
 const lost=widget.children.find((child:Row)=>child.name==='health')!;
 const rows=[lines[0],...cut.filter(row=>row.path!==lost.path)];
 rows[0]={...rows[0],nodes:rows.length-1};
 const broken=lockedTree(rows,{run:RUN,root:ROOT});assert.notEqual(typeof broken,'string');
 const answer=selectedCatalog(broken as LockedTree,{base:'/commands',lines:['widget health interval p 5']});
 assert.deepEqual(answer,{missing:UNREADABLE_PATH});
 // The same tree, the other run, another root, a node lost or a node without its children: none of them is this run's tree.
 assert.equal(typeof lockedTree(lines,{run:'run_other',root:ROOT}),'string');
 assert.equal(typeof lockedTree(lines,{run:RUN,root:'d'.repeat(64)}),'string');
 assert.equal(typeof lockedTree(lines.slice(0,-1),{run:RUN,root:ROOT}),'string');
 assert.equal(typeof lockedTree([lines[0],{...lines[1],children:undefined},...lines.slice(2)],{run:RUN,root:ROOT}),'string');
});
