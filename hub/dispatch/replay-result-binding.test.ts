import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';
import type { EffectCheckReplay } from '../ports.ts';

test('dispatch replays policy against its selected accepted validation record', async t => {
  const c=await setup();t.after(()=>c.close());
  c.detail.latest!.result.submission='b'.repeat(64);
  const expected=c.detail.latest!.record,original=c.service.options.recheckChecks!;
  const calls:Array<Parameters<EffectCheckReplay>[0]>=[];
  c.service.options.recheckChecks=async input=>{calls.push(input);return original(input);};
  const status=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(status.outcome,'effective');assert.ok(calls.length>0);
  for(const call of calls){assert.equal(call.submission,'b'.repeat(64));assert.equal(call.result,expected);}
});
