// After the move the synthetic product pack produces the same knowledge trees from the same directory fixtures: the
// tree root digest, the composition's entry digests and the bound sources equal those frozen before the move.
// Real Hub knowledge transactions on a temporary PostgreSQL; the producer runs in the pack sandbox with
// requireOsIsolation: false (synthetic data), as the product pack's own production tests do.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../../../../hub/testing/postgres.ts';
import {addAdocSources} from '../../../product/famx/functions/adoc/deployment.ts';
import {MIGRATION_TEST,frozenTrees} from '../testing/baseline.ts';
import {PRODUCTION_FIXTURES,produceFixture} from '../testing/production.ts';

let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});
after(()=>postgres?.stop());

test(MIGRATION_TEST+': produced trees keep their frozen root digests',{timeout:300000},async()=>{
 const frozen=await frozenTrees();
 assert.deepEqual(Object.keys(frozen),PRODUCTION_FIXTURES.map(fixture=>fixture.name));
 for(const fixture of PRODUCTION_FIXTURES){
  const produced=await produceFixture(postgres,fixture,addAdocSources as never);
  assert.equal(produced.root,frozen[fixture.name].root,`${fixture.name}: tree root digest`);
  assert.deepEqual(produced.entries,frozen[fixture.name].entries,`${fixture.name}: entry digests`);
  assert.deepEqual(produced.sources,frozen[fixture.name].sources,`${fixture.name}: bound sources`);
 }
 // The three-component line directory resolved: the second fixture's sources sit under it.
 assert.ok(frozen[PRODUCTION_FIXTURES[1].name].sources.some(source=>source.external==='svn:directory:'+encodeURIComponent('manual/10_7_0')));
});
