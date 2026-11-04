// tools/list stands in front of every new client session: Circle waits for it before it stores the first message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Principal } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { absentOptionalInputs, listTools } from './tools.ts';

const principal: Principal = { id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a', name: '合成', role: 'user' };

test('tools/list lists the caller\'s packs once for both annotations', async () => {
  let listings = 0;
  const deps = { workflows: { summaries: async () => { listings += 1; return []; }, forUser: async () => null } } as unknown as ServerDeps;
  assert.equal((await listTools(deps, principal)).length, 6);
  assert.equal(listings, 1);
});

test('a source that has no such object for an optional input is an answer, not a failed tool; a required input stays an error', async () => {
  const inputs = [{ slot: 'defect', required: false }, { slot: 'profile', required: true }];
  const deps = { workflows: { forUser: async () => ({ workflow: { inputs } }) } } as unknown as ServerDeps;
  const absent = (path: string) => ({ code: 'SOURCE_ABSENT', message: '不在', path }) as never;
  const check = (errors: never[], name = 'start_run', args: Record<string, unknown> = { pack: 'demo@1.0.0' }) => absentOptionalInputs(deps, { principal }, name, args, errors);
  assert.equal(await check([absent('/inputs/defect')]), true);
  assert.equal(await check([absent('/inputs/profile')]), false);
  assert.equal(await check([absent('/inputs/defect'), absent('/inputs/profile')]), false);
  assert.equal(await check([absent('/pack')]), false, 'a pack the Hub does not have stays an error');
  assert.equal(await check([{ code: 'SOURCE_UNAVAILABLE', message: '读不到', path: '/inputs/defect' } as never]), false);
  assert.equal(await check([absent('/inputs/defect')], 'get_nodes'), false);
  assert.equal(await check([]), false);
});
