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
