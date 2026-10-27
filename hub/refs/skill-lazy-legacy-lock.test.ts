import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../testing/postgres.ts';
import {openPackTestbed} from '../runs/packs/testing/setup.ts';
import type {PackDescription} from '../runs/packs/testing/builder.ts';
import {sourceReader} from '../runs/engine/readers.ts';
import {newId} from '../records/api.ts';
import {runRecord} from '../../contracts/src/fixtures.ts';
import {RunRecord} from '../../contracts/src/run.ts';
import {createSkillParserRegistry} from './skills.ts';
import {parseDocument, resolveReference} from './api.ts';

const BASE = {
  parser: 'synthetic@1', media_types: ['text/plain'],
  limits: {maxBytes: 1024, maxDepth: 10, maxNodes: 20},
  function: {module: 'functions/parser.ts', export: 'default'},
};
const oldFunction = `
const q={stream:'synthetic',units:[{selector:'n/item',text:'synthetic',byteRange:[0,9],parent:-1,start:0,end:9}]};
export default function parse() {
 return {document:{parser:'synthetic@1',model:{generation:'old'},summary:{},selectors:['n/item'],properties:['n/item'],
 fragments:[{lookup:'n/item',selector:'n/item',text:'synthetic',byteRange:[0,9],data:{generation:'old'}}],
 quotation:{plain:q,properties:q}}};
}`;
const newFunction = `
const q={stream:'synthetic',units:[{selector_index:0,byteRange:[0,9],parent:-1,start:0,end:9}]};
export default function parse() {
 return {document:{parser:'synthetic@1',model:{generation:'new'},summary:{},
 selectors:{encoding:'prefix-delta@1',entries:[[0,'n/item']]},properties:{encoding:'prefix-delta@1',entries:[[0,'n/item']]},
 quotation:{plain:q,properties:q}}};
}
export function locate(input: {selectors: string[]}) {
 return {fragments:input.selectors.filter(s=>s==='n/item').map(lookup=>({lookup,selector:lookup,text:'synthetic',byteRange:[0,9],data:{generation:'new'}}))};
}`;

function pack(version: string, modern: boolean): PackDescription {
  return {id:'synthetic-format',version,kind:'skill',title:'合成格式',description:'旧格式与新格式锁定测试',files:{
    'SKILL.md':'# 合成技能\n测试新旧传输格式。\n',
    'skill.json':{schema:'skill@1',parsers:[{...BASE,...(modern?{locate:{module:'functions/parser.ts',export:'locate'}}:{})}]},
    'functions/parser.ts':modern?newFunction:oldFunction,
  }};
}

test('a published old eager skill remains bound to its original run digest after a new lazy format is installed', {timeout:120_000}, async t => {
  const postgres=await startPostgres();t.after(()=>postgres.stop());
  const bed=await openPackTestbed({postgres});t.after(()=>bed.close());
  const first=await bed.publish(bed.alice,pack('1.0.0',false));
  await bed.registry.install(bed.admin,'synthetic-format@1.0.0');
  const options={registry:bed.registry,records:bed.kit,sandbox:{requireOsIsolation:false}};
  const frozen=await createSkillParserRegistry(options).freeze!([]);
  assert.deepEqual(frozen.skills,[{pack:'synthetic-format',version:'1.0.0',digest:first.version.digest}]);

  const bytes=Buffer.from('synthetic');
  const artifact=await bed.kit.artifacts.ingest({bytes,mediaType:'text/plain',origin:{upload:{session:'synthetic-session',message:null}},author:{user:bed.bob.id},provenanceType:'declared',visibility:{readers:[bed.bob.id],admins:true,packs:[],shareable:true},name:'synthetic.txt'});
  const reference=`src:${artifact.body.sha256}/synthetic@1/n/item`;
  const run=RunRecord.parse({...runRecord,run:newId('run'),runner:bed.bob.id,skills:frozen.skills,items:[],sources:[{reference,role:'subject',slot:'target',artifact:artifact.digest}]});
  const saved=await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'projected',body:run,index:[{key:'runs.id',value:run.run}]});

  const second=await bed.publish(bed.alice,pack('1.0.1',true));
  assert.notEqual(first.version.digest,second.version.digest);
  await bed.registry.uninstall(bed.admin,'synthetic-format');
  await bed.registry.install(bed.admin,'synthetic-format@1.0.1');
  const restarted=createSkillParserRegistry({...options,registry:bed.second()});
  const old=await restarted.forRun!(run.run);
  assert.equal(old.get('synthetic@1')?.skill_digest,first.version.digest);
  const eager=await parseDocument(old.get('synthetic@1')!,bytes);
  assert.equal(eager.prefetch,undefined,'historical skill has no locate declaration');
  assert.deepEqual((await eager.locate('n/item'))?.data,{generation:'old'});
  const resolved=await resolveReference(reference,{parsers:restarted,reader:{user:bed.bob.id,role:'user',run:run.run},sources:sourceReader(bed.kit.artifacts,'model')});
  assert.ok(resolved.resolved);assert.equal(resolved.text,'synthetic');
  assert.deepEqual(resolved.fragment?.data,{generation:'old'});

  const current=await restarted.freeze!([]);
  assert.equal(current.parsers.get('synthetic@1')?.skill_digest,second.version.digest);
  const lazy=await parseDocument(current.parsers.get('synthetic@1')!,bytes);
  assert.equal(typeof lazy.prefetch,'function');
  assert.deepEqual((await lazy.locate('n/item'))?.data,{generation:'new'});
  const after=(await bed.kit.store.find({kind:'run',key:'runs.id',value:run.run,limit:2})).items;
  assert.equal(after.length,1);assert.equal(after[0].digest,saved.digest,'the run remains the same content-addressed record');
  assert.deepEqual((await bed.kit.store.get(saved.digest))?.body,run);
});
