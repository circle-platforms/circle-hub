import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceAssignmentSubject, TeamAssignmentSubject } from './common.ts';

test('environment assignment adds accounts while the team subject stays closed', () => {
  const user = 'usr_0' + 'a'.repeat(25), team = 'tm_0' + 'b'.repeat(25);
  for (const subject of ['*', team, user]) assert.equal(ResourceAssignmentSubject.parse(subject), subject);
  assert.equal(TeamAssignmentSubject.safeParse(user).success, false);
  for (const subject of ['exe_0'+'a'.repeat(25), 'usr_8'+'a'.repeat(25), 'all', '', {user}]) assert.equal(ResourceAssignmentSubject.safeParse(subject).success, false);
});
