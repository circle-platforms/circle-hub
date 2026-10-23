import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LinkDeclaration} from '../../contracts/src/product.ts';
import {relationFacts,resolveLiteral} from './links.ts';
const rule=LinkDeclaration.parse({id:'mentions',field:'mentions',namespace:'/terms',match:'longest_prefix',entry_kind:'definition',normalize:{lowercase:true,nfc:true}});
const nodes=new Map([['/',new Set<string>()],['/terms',new Set<string>()],['/terms/demo',new Set<string>()],['/terms/demo/SSL',new Set<string>()],['/terms/demo/SSL/set',new Set(['definition'])]]);
test('declared normalization folds both tree segments and literals and returns canonical paths',()=>{
  assert.equal(resolveLiteral(rule,'DEMO ssl SET HostName',nodes).target,'/terms/demo/SSL/set');
  assert.deepEqual(resolveLiteral(rule,'DEMO ssl SET HostName',nodes).remainder,['HostName']);
  assert.equal(resolveLiteral({...rule,match:'exact'},'demo ssl set',nodes).target,'/terms/demo/SSL/set');
  const collision=new Map<string,ReadonlySet<string>>(nodes);collision.set('/terms/demo/ssl/set',new Set(['definition']));
  assert.equal(resolveLiteral(rule,'demo ssl set',collision).target,'/terms/demo/SSL/set');
  assert.equal(resolveLiteral(rule,'demo ssl set',new Map([...collision].reverse())).target,'/terms/demo/SSL/set');
});
test('drift equivalence groups retain all written spellings and occurrence counts',()=>{
  const sources=['DEMO gone','demo gone'].map((literal,index)=>({path:'/notes',entry:String(index+1).repeat(64),content:{kind:'behaviour' as const,statement:'Synthetic note',data:{mentions:[literal]},applicability:null}}));
  const facts=relationFacts('a'.repeat(64),[rule],nodes,sources);
  assert.equal(facts.drift.length,1);assert.equal(facts.drift[0].total,2);
  assert.deepEqual(facts.drift[0].spellings,['DEMO gone','demo gone']);
});
test('producer filters prevent a source definition from satisfying its own target namespace',()=>{
  const scoped=LinkDeclaration.parse({...rule,target_producers:['definitions'],source_producers:['notes']});
  const owned=(kind:string,producer:string)=>Object.assign(new Set([kind]),{producersByKind:new Map([[kind,new Set([producer])]])});
  const graph=new Map<string,ReadonlySet<string>>([['/',new Set()],['/terms',new Set()],['/terms/demo',owned('definition','notes')],['/terms/demo/real',owned('definition','definitions')]]);
  assert.equal(resolveLiteral(scoped,'demo missing',graph).target,null);
  assert.equal(resolveLiteral(scoped,'demo real Arg',graph).target,'/terms/demo/real');
  const source=(producer:string,value:unknown,index:number)=>({path:'/notes',entry:String(index).repeat(64),producers:[producer],content:{kind:'behaviour' as const,statement:'Synthetic note',data:{mentions:value},applicability:null}});
  const facts=relationFacts('a'.repeat(64),[scoped],graph,[source('foreign',17,1),source('notes',17,2),source('notes',['demo real Arg'],3)]);
  assert.equal(facts.links.length,1);assert.equal(facts.diagnostics.length,1);
  assert.equal(facts.diagnostics[0].reference.includes('2'.repeat(64)),true);
  assert.equal(facts.diagnostics[0].reason,'no_check');assert.match(facts.diagnostics[0].next_action,/重新生产/);
});

test('alternative groups prefer an exact primary definition then check each expanded alternative',()=>{
  const grouped=LinkDeclaration.parse({id:'groups',alternatives_field:'groups',namespace:'/terms',match:'exact',entry_kind:'definition'});
  const source=(primary:string,alternatives:string[])=>({path:'/notes',entry:'b'.repeat(64),content:{kind:'behaviour' as const,statement:'Synthetic grouped literals',data:{groups:[{primary,alternatives}]},applicability:null}});
  const graph=new Map<string,ReadonlySet<string>>([['/terms',new Set()],['/terms/mode',new Set(['definition'])],['/terms/health',new Set()],['/terms/health/tcp',new Set(['definition'])]]);
  const primary=relationFacts('a'.repeat(64),[grouped],graph,[source('mode',['mode rr','mode lc','mode hash'])]);
  assert.deepEqual(primary.links.map(edge=>edge.literal),['mode']);assert.deepEqual(primary.drift,[]);
  const expanded=relationFacts('a'.repeat(64),[grouped],graph,[source('health',['health tcp','health udp'])]);
  assert.deepEqual(expanded.links.map(edge=>edge.literal),['health tcp']);assert.deepEqual(expanded.drift.map(group=>group.literal),['health udp']);
  for(const bad of [{...grouped,field:'ordinary'},{...grouped,match:'longest_prefix'},{...grouped,alternatives_field:undefined}])assert.equal(LinkDeclaration.safeParse(bad).success,false);
  const malformed=relationFacts('a'.repeat(64),[grouped],graph,[source('mode',[])]) ;assert.equal(malformed.diagnostics.length,1);
});

test('unavailable target namespaces diagnose each rule once and count literals as unchecked',()=>{
  const scoped=LinkDeclaration.parse({...rule,target_producers:['tree']});
  const source={path:'/notes',entry:'b'.repeat(64),producers:['notes'],content:{kind:'behaviour' as const,statement:'Synthetic mentions',data:{mentions:['demo gone','demo other']},applicability:null}};
  for(const graph of [new Map<string,ReadonlySet<string>>([['/',new Set()]]),new Map<string,ReadonlySet<string>>([['/terms',new Set()],['/terms/demo',new Set(['definition'])]])]){
    const facts=relationFacts('a'.repeat(64),[scoped],graph,[source]);
    assert.deepEqual(facts.drift,[]);assert.deepEqual(facts.links,[]);
    assert.equal(facts.rule_diagnostics.length,1);assert.equal(facts.unchecked.reduce((n,item)=>n+item.literals,0),2);
    assert.match(facts.rule_diagnostics[0].next_action,/有效.*来源.*重新生产/);
  }
});
