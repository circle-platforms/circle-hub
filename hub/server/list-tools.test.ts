// tools/list stands in front of every new client session: Circle waits for it before it stores the first message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Principal } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { listTools, startRunReadsExternal, submitDispatchesJobs } from './tools.ts';

const principal: Principal = { id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a', name: '合成', role: 'user' };

test('tools/list lists the caller\'s packs once for both annotations', async () => {
  let listings = 0;
  const deps = { workflows: { summaries: async (_user: unknown, _options: { includeAdminDefault: boolean }) => { assert.deepEqual(_options, { includeAdminDefault: false }); listings += 1; return []; }, forUser: async () => null } } as unknown as ServerDeps;
  assert.equal((await listTools(deps, principal)).length, 6);
  assert.equal(listings, 1);
});


test('standalone annotation helpers explicitly exclude the administrator default projection', async () => {
  let reads = 0;
  const deps = { workflows: { summaries: async (_user: unknown, options: { includeAdminDefault: boolean }) => {
    assert.deepEqual(options, { includeAdminDefault: false }); reads++; return [];
  } } } as unknown as ServerDeps;
  assert.equal(await startRunReadsExternal(deps, principal), false);
  assert.equal(await submitDispatchesJobs(deps, principal), false);
  assert.equal(reads, 2);
});
