// A pure page test: a frozen synthetic run and injected read-only ports, no database or external client.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRecord} from '../../contracts/src/fixtures.ts';
import type {ServerDeps} from './api.ts';
import {runPage,type PageContext} from './console/pages.ts';

test('run pages retain complete projected string fields as escaped read-only text',async()=>{
  const run=structuredClone(runRecord);
  const long='合成字段\n'+'甲'.repeat(3000)+'结束标记';
  Object.assign(run.items[0].fields,{plain:long,markup:'<script src="//192.0.2.1/x">原样</script>',number:7,object:{hidden:'NOT_A_STRING_VALUE'}});
  run.version='10.6.1';run.build='Rel_WIDGET_10_6_1_1';
  const deps={
    runs:{getRun:async()=>({run,latest:null,production:null,submissions:[]})},
    records:{callLog:{query:async()=>({items:[],next:null})}},
  } as unknown as ServerDeps;
  const context:PageContext={deps,principal:{id:run.runner,name:'合成读者',role:'user'},admin:false,url:new URL('http://127.0.0.1/console/runs/'+run.run),
    userName:async()=> '合成读者',chrome:title=>({title,user:{name:'合成读者',role:'用户',admin:false},csrf:null})};
  const response=await runPage(context,run.run),body=String(response.body);
  assert.equal(response.status,200);assert.match(body,/投影字符串字段/);assert.ok(body.includes(long));
  assert.match(body,/&lt;script src=&quot;\/\/192\.0\.2\.1\/x&quot;&gt;原样&lt;\/script&gt;/);
  assert.doesNotMatch(body,/<script\b|NOT_A_STRING_VALUE/);assert.match(body,/<details/);
  assert.ok(!body.includes('review_tables'),'the renderer names no workflow-specific field');
});
