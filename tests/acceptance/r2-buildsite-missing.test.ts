import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BuildSite} from '../../packages/connectors/src/build-site.ts';
import {HttpSource} from '../../packages/connectors/src/readonly-sdk.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';

test('Missing fixed links and confirmed 404 pages preserve readable release matches and disclose incomplete coverage',async t=>{
  const stub=await readonlySources(t),site=new BuildSite(new HttpSource(stub.origin));const builds=(await site.listing('/builds/PHOTON_10_5.html')).result;
  const first=builds[0],second={...builds[1],files:{...builds[1].files,fixed:undefined}},third={...builds[2],files:{...builds[2].files,fixed:'/builds/missing-fixed.html'}};
  const result=await site.releasesFor('401',[first,second,third]);assert.equal(result.status,'published');assert.equal(result.earliestFormal.name,first.name);assert.equal(result.all.length,1);
  assert.deepEqual(result.coverage.missing,[{build:second.name,code:'SOURCE_ABSENT'},{build:third.name,code:'SOURCE_ABSENT'}]);assert.equal(result.coverage.completeSite,false);assert.equal(result.evidence.length,1);
  const none=await site.releasesFor('401',[second,third]);assert.equal(none.status,'unknown');assert.equal(none.earliestFormal,null);assert.equal(none.coverage.missing.length,2);
});
