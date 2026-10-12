import assert from 'node:assert/strict';
import {test} from 'node:test';
import {executeTool,toolPackages} from '../../packages/connectors/src/tool-packages.ts';
import {publicationLayout} from '../fixtures/publication-layout.ts';

test('Version pages: thousands of builds return bounded compact rows with explicit pagination and complete source receipts',async t=>{
  const fixture=await publicationLayout(t);fixture.state.extraBuilds=250;const profile={origin:fixture.origin,index:'/builds/',requestIntervalMs:0,buildSite:fixture.policy},call=(args:any)=>executeTool('build-site','build.versions',args,profile);
  const first=await call({versionLine:'10.8'});assert.equal(first.result.builds.length,20);assert.equal(first.result.total,508);assert.equal(first.result.page,1);assert.equal(first.result.limit,20);assert.equal(first.result.nextPage,2);assert.equal(first.result.hasMore,true);assert.equal(first.result.totalPages,26);
  const fields=['buildId','commandTreeAvailable','current','formal','name','platform','releasedOn'];for(const build of first.result.builds)assert.deepEqual(Object.keys(build).sort(),fields);
  assert.ok(Buffer.byteLength(JSON.stringify(first.result))<12_000,'Default result must fit an ordinary tool response');assert.ok(first.raw.some(raw=>raw.bytes.includes(Buffer.from('Rel_PHOTON_10_8_1_1249'))),'Full original pages remain in the evidence path');
  const second=await call({versionLine:'10.8',page:2,limit:20});assert.equal(second.result.revision,first.result.revision);assert.equal(second.result.builds.length,20);assert.ok(!second.result.builds.some((build:any)=>first.result.builds.some((prior:any)=>prior.buildId===build.buildId)));
  const selected=await call({versionLine:'10.8',formal:true,platform:null,current:true,commandTreeAvailable:true,limit:1});assert.equal(selected.result.builds.length,1);assert.equal(selected.result.total,252);assert.equal(selected.result.builds[0].releasedOn,'2026-05-01');assert.equal(selected.result.builds[0].platform,null);
  const last=await call({page:26,limit:20});assert.equal(last.result.builds.length,8);assert.equal(last.result.nextPage,null);assert.equal(last.result.hasMore,false);assert.ok(!fixture.requests.some(path=>/command_tree|Bugs_Fixed/.test(path)));
  const schema=toolPackages.find(pack=>pack.id==='build-site')!.tools.find(tool=>tool.suffix==='versions')!.schema;
  for(const args of [{page:0},{limit:0},{limit:101},{page:1.5}])assert.equal(schema.safeParse(args).success,false);
});

test('Version pages: compact warnings retain total counts without nesting entire conflicting and superseded records',async t=>{
  const fixture=await publicationLayout(t);fixture.state.conflicts=true;
  const returned=await executeTool('build-site','build.versions',{limit:1},{origin:fixture.origin,index:'/builds/',requestIntervalMs:0,buildSite:fixture.policy});assert.equal(returned.result.builds.length,1);assert.equal(returned.result.coverage.counts.conflicts,2);assert.equal(returned.result.coverage.complete,false);assert.ok(returned.result.coverage.conflicts.every((item:any)=>!item.revisions&&!item.files));
});
