import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {createTestParserRegistry} from '../../testing/parsers.ts';
import {createParserRegistry,type Parser,type ParsedDocument} from '../../refs/api.ts';
import {openRetryHarness} from './testing/retry-harness.ts';
import {sandboxSkip} from './testing/harness.ts';
import {standardDocument,toyMap} from './testing/mindmap.ts';

test('start_run prefetches forty projected locations of one document in one batch',{skip:await sandboxSkip()},async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());
 const original=createTestParserRegistry();let batches:string[][]=[],singles=0;
 const wrap=(doc:ParsedDocument):ParsedDocument=>{const loaded=new Set<string>();return {...doc,async prefetch(selectors){const wanted=[...new Set(selectors)].filter(selector=>!loaded.has(selector));if(wanted.length){batches.push(wanted);for(const selector of wanted)loaded.add(selector);}},async locate(selector){if(!loaded.has(selector))singles++;return doc.locate(selector);}};};
 const parsers=createParserRegistry(original.list().map((parser:Parser)=>parser.id==='kityminder'?{...parser,parse:(bytes,options)=>wrap(parser.parse(bytes,options))}:parser));
 const h=await openRetryHarness(pg,{parsers});t.after(()=>h.close());
 const doc=standardDocument();doc.groups=[{...doc.groups[0],cases:Array.from({length:40},(_,i)=>({id:'synthetic-case-'+i,title:'Synthetic case '+i,tags:['function'],expected:['Synthetic expected']}))}];
 const source=await h.upload(h.alice,toyMap(doc));
 const answer=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:source}}},h.call());
 assert.ok(answer.run,JSON.stringify(answer.errors));assert.equal(answer.run.items.length,40);
 assert.ok(batches.some(batch=>batch.length===40),'one invocation receives all forty location selectors');
 assert.equal(singles,0,'item location verification does not start selector-by-selector calls');
});
