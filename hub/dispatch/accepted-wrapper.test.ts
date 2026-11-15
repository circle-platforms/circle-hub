import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedDispatch } from './accepted.ts';
import type { DispatchService } from './service.ts';
import type { RecordsKit } from '../records/api.ts';

const run = 'run_' + '0'.repeat(26);
const admin = { id: 'usr_' + '1'.repeat(26), role: 'admin' as const, name: '合成管理员' };
const member = { id: 'usr_' + '2'.repeat(26), role: 'user' as const, name: '合成成员' };

test('a settled handler without job status stays missing run evidence instead of a confirmed admission refusal', async () => {
  const records = {
    principals: { list: async () => [admin, member], get: async (id: string) => id === member.id ? member : admin },
    store: { find: async () => ({ items: [], next: null }) },
  } as unknown as Pick<RecordsKit, 'store' | 'principals'>;
  const service = {
    options: { runs: { getRun: async () => ({ run: { run } }) } },
    dispatchAccepted: async () => ({ started: false, job_status_unavailable: true }),
  } as unknown as DispatchService;
  const [note] = await acceptedDispatch(records, service, run, true, 20, member);
  assert.deepEqual(note.run_facts?.scope, { run });
  assert.equal(note.run_facts?.worker_settled, true);
  assert.equal(note.run_facts?.admission_error, undefined);
  assert.match(note.run_facts?.missing_facts?.[0].fact ?? '', /未取得可核对的作业记录/);
  assert.match(note.text, /作业事实尚未确认/);
  assert.doesNotMatch(note.text, /准入核对未通过/);
  assert.equal(note.job_facts, undefined);
  assert.equal(note.dispatch_attempt, undefined);
  assert.equal(Object.hasOwn(note, 'outcome'), false);
});
