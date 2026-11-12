import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SourceAttributionBody,SpaceSourceBody,SpaceEntryBody,SpaceEntryInput} from './spaces.ts';
import {UploadFileInput} from './tools.ts';
import {uiLabelOf} from '../generated/vocabulary.ts';
const owner='usr_'+'1'.repeat(26),hash='a'.repeat(64),at='2026-11-03T00:00:00.000Z';
const declaration={space:owner,source:hash,artifact:hash,sha256:hash,by:owner,at,audience:'team'};
test('the strict attribution pins registration, exact capture, bytes, uploader and team audience',()=>{
 assert.ok(SourceAttributionBody.safeParse(declaration).success);
 for(const change of [{space:'team'},{by:'usr_'+'2'.repeat(26)},{audience:'member'},{source:'src:'+hash},{author:'合成作者'},{original:'合成原文'},{path:'/私人路径'}])assert.equal(SourceAttributionBody.safeParse({...declaration,...change}).success,false,JSON.stringify(change));
 assert.equal(uiLabelOf('source_attribution_status','unsigned'),'未确认');assert.equal(uiLabelOf('source_attribution_status','attributed'),'已确认为团队来源');
});
test('only team associations and bounded unique team entry attestations carry attribution metadata',()=>{
 const source={space:'team',path:'/',sha256:hash,artifact:hash,size:3,by:owner,at};assert.ok(SpaceSourceBody.safeParse({...source,attribution:hash}).success);assert.ok(SpaceSourceBody.safeParse({...source,space:owner}).success);assert.equal(SpaceSourceBody.safeParse({...source,space:owner,attribution:hash}).success,false);
 const entry={space:'team',entry:hash,content:{kind:'observation',statement:'合成声明'},grounds:[],status:'verified',by:owner,at,session:null,replaces:null};
 assert.ok(SpaceEntryBody.safeParse(entry).success);assert.ok(SpaceEntryBody.safeParse({...entry,source_attributions:[hash]}).success);
 for(const change of [{source_attributions:[hash,hash]},{source_attributions:Array.from({length:101},(_,n)=>n.toString(16).padStart(64,'0'))},{space:owner,source_attributions:[hash]}])assert.equal(SpaceEntryBody.safeParse({...entry,...change}).success,false);
 assert.equal(SpaceEntryInput.safeParse({kind:'observation',statement:'合成',source_attributions:[hash]}).success,false);assert.equal(UploadFileInput.safeParse({source_attribution:declaration}).success,false,'no new MCP signing mode');
});
