import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {BuildSite} from '../../packages/connectors/src/build-site.ts';
import {HttpSource} from '../../packages/connectors/src/readonly-sdk.ts';
import {SourceCache} from '../../packages/connectors/src/source-cache.ts';
import {executeTool} from '../../packages/connectors/src/tool-packages.ts';
import {publicationLayout} from '../fixtures/publication-layout.ts';

test('Publication follow-up A: rebuilt identities select the latest build time and disclose superseded segments without losing the page',async t=>{
  const fixture=await publicationLayout(t);fixture.state.rebuilds=true;const site=new BuildSite(new HttpSource(fixture.origin)),listing:any=await site.listing('/builds/rel_photon_10_8.html');
  assert.equal(listing.result.length,4);assert.equal(listing.result[0].imageSha256,'d'.repeat(64));assert.equal(listing.result[0].buildTime,'2026-04-01 01:02:03');assert.equal(listing.result[0].superseded.length,1);assert.equal(listing.result[0].superseded[0].imageSha256,'c'.repeat(64));assert.equal(listing.coverage.superseded.length,1);
  fixture.state.conflicts=true;fixture.state.rebuilds=false;const profile={origin:fixture.origin,index:'/builds/',requestIntervalMs:0,buildSite:fixture.policy},versions=await executeTool('build-site','build.versions',{},profile);assert.equal(versions.result.builds.length,8);assert.equal(versions.result.coverage.conflicts.length,2);assert.equal(versions.result.coverage.complete,false);
  const good=versions.result.builds.find((build:any)=>build.name===fixture.builds[1].name&&build.platform===null);assert.equal((await executeTool('build-site','build.check',{build:good.buildId,commands:['service mode active']},profile)).result.commands[0].violations.length,0);
  const bad=versions.result.builds.find((build:any)=>build.name===fixture.builds[0].name&&build.platform===null);await assert.rejects(executeTool('build-site','build.tree',{build:bad.buildId},profile),(error:any)=>error.details.reason==='build_revision_conflict');
  await assert.rejects(site.commandTree(bad),(error:any)=>error.details.reason==='build_revision_conflict');const partial=await site.releasesFor('401',[bad,good]);assert.equal(partial.status,'published');assert.equal(partial.all.length,1);assert.equal(partial.coverage.missing.length,1);
});

test('Publication follow-up C: build ids and names locate one fresh page across worker restarts even when another line fails',async t=>{
  const fixture=await publicationLayout(t),directory=await mkdtemp(`${tmpdir()}/circle-server-locators-`);t.after(()=>rm(directory,{recursive:true,force:true}));
  const profile={origin:fixture.origin,index:'/builds/',requestIntervalMs:0,buildSite:fixture.policy},options={cache:new SourceCache(directory),cacheNamespace:'owner-one'},versions=await executeTool('build-site','build.versions',{},profile,undefined,options),build=versions.result.builds.find((build:any)=>build.name===fixture.builds[1].name&&build.platform===null);
  fixture.state.brokenOtherLine=true;fixture.requests.length=0;
  const call=(handler:string,args:any)=>executeTool('build-site',handler,args,profile,undefined,{...options,cache:new SourceCache(directory)});
  await call('build.heads',{build:build.buildId,prefix:'service'});assert.deepEqual(fixture.requests.filter(path=>!path.includes('command_tree')),['/builds/rel_photon_10_8.html']);
  fixture.requests.length=0;await call('build.parameters',{build:build.name,platform:null,head:'service mode'});assert.deepEqual(fixture.requests,['/builds/rel_photon_10_8.html']);
  fixture.requests.length=0;await call('build.fixed',{issueSystem:'zentao',issueId:'51',builds:[build.buildId]});assert.deepEqual(fixture.requests.filter(path=>!path.includes('Bugs_Fixed')),['/builds/rel_photon_10_8.html']);
  fixture.requests.length=0;const partial=await call('build.versions',{});assert.equal(partial.result.builds.length,8);assert.equal(partial.result.coverage.missing.length,1);assert.equal(partial.result.coverage.complete,false);
  fixture.state.brokenOtherLine=false;fixture.state.rebuilds=true;fixture.requests.length=0;await call('build.tree',{build:versions.result.builds.find((item:any)=>item.name===fixture.builds[0].name&&item.platform===null).buildId});assert.equal(fixture.requests.filter(path=>path.includes('command_tree')).length,1,'A rebuild changes the segment and must refresh its XML');
});

test('Publication follow-up D and E: platform aliases ignore case and new hyphenated variants disclose absent trees',async t=>{
  const fixture=await publicationLayout(t);fixture.state.mixedCase=true;fixture.state.extraVariants=true;
  const profile={origin:fixture.origin,index:'/builds/',requestIntervalMs:0,buildSite:fixture.policy},versions=await executeTool('build-site','build.versions',{},profile);
  assert.equal(versions.result.builds.length,9);assert.ok(versions.result.builds.filter((build:any)=>build.listingPath.includes('syntheticOS')).every((build:any)=>build.platform==='synthetic-os'));
  const variant=versions.result.builds.find((build:any)=>build.name.includes('PHOTON-CHIP-U'));assert.ok(variant);assert.equal(variant.platform,'chip_os');assert.equal(variant.commandTreeAvailable,false);assert.ok(variant.files.image.endsWith('.click'));
  await assert.rejects(executeTool('build-site','build.tree',{build:variant.buildId},profile),(error:any)=>error.code==='SOURCE_ABSENT');assert.ok(!fixture.requests.some(path=>path.includes('command_tree-')&&path.includes('CHIP')));
});
