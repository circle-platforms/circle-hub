// tools/list stands in front of every new client session: Circle waits for it before it stores the first message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Principal } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { listTools } from './tools.ts';

const principal: Principal = { id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a', name: '合成', role: 'user' };

test('tools/list lists the caller\'s packs once for both annotations', async () => {
  let listings = 0;
  const deps = { workflows: { summaries: async () => { listings += 1; return []; }, forUser: async () => null } } as unknown as ServerDeps;
  assert.equal((await listTools(deps, principal)).length, 6);
  assert.equal(listings, 1);
});
