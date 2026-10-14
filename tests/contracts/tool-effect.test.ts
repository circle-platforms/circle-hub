import assert from 'node:assert/strict';
import {test} from 'node:test';
import {z} from 'zod';
import {defineTool,toolPackages} from '../../packages/connectors/src/tool-packages.ts';
test('Tool registration requires an explicit read or write effect and every catalog definition carries it',()=>{
  assert.throws(()=>defineTool('unsafe','Unsafe fixture',z.object({}),'tools.read','fixture',undefined as any));
  for(const pack of toolPackages)for(const tool of pack.tools)assert.ok(['read','write'].includes(tool.effect));
});
