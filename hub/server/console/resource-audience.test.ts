import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceAudienceText } from './connections.ts';
import type { PageContext } from './context.ts';

function ctx(of: { teams: Array<{ name: string }>; all: boolean }): PageContext {
  return {
    admin: true,
    principal: { id: 'usr_01adminzzzzzzzzzzzzzzzzzz', name: 'admin', role: 'admin' },
    deps: {
      records: {
        authorizations: {
          teamsOf: async () => of,
        },
      },
    },
  } as unknown as PageContext;
}

test('resource audience names teams and 全体 without internal ids', async () => {
  assert.equal(await resourceAudienceText(ctx({ all: true, teams: [{ name: 'team-a' }] }), 'res_x'), '全体、团队 team-a');
  assert.equal(await resourceAudienceText(ctx({ all: false, teams: [] }), 'res_x'), '尚未分配');
});
