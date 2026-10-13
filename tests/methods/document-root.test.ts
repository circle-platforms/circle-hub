import assert from 'node:assert/strict';
import {test} from 'node:test';
import {executeTool} from '../../packages/connectors/src/tool-packages.ts';
test('Document get and section cannot read outside the registered root even on the same origin',async()=>{
  for(const handler of ['document.get','document.section'])await assert.rejects(executeTool('documents',handler,{file:'/private/not-in-root.md',line:1,window:20},{origin:'http://127.0.0.1:1',root:'/webdav/'} as any), (error:any)=>error.code==='SOURCE_FORBIDDEN');
});
