import assert from 'node:assert/strict';import {test} from 'node:test';
import {skillWasLoaded} from '../../packages/skillpacks/src/loader-observation.ts';
test('Skill compatibility requires a preceding uniquely identified successful load of this package rather than another skill or unmatched result',()=>{
 const call={type:'assistant',tool_calls:[{id:'call-one',name:'skill',args:{name:'bound-skill'}}]},result={type:'tool_result',id:'call-one',name:'skill',status:'success'};
 assert.equal(skillWasLoaded([call,result],'bound-skill'),true);assert.equal(skillWasLoaded([call,result],'other-skill'),false);assert.equal(skillWasLoaded([result,call],'bound-skill'),false);assert.equal(skillWasLoaded([call,{...result,status:'error'}],'bound-skill'),false);assert.equal(skillWasLoaded([call,{...result,id:'other-call'}],'bound-skill'),false);assert.equal(skillWasLoaded([call,{...call,tool_calls:[{...call.tool_calls[0],args:{name:'other-skill'}}]},result],'bound-skill'),false);
});
