// The run context list_task_packs shows (decision 113): the lease view of every declared prefix, without who holds a key
// (R02 R[3]), and the newest device observations, for the listed packs that declare them. Synthetic keys and builds only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceObservation } from '../../../contracts/src/pack.ts';
import type { Principal } from '../../records/api.ts';
import type { EngineContext } from './deps.ts';
import { packContext } from './pack-context.ts';

const me = { id: 'usr_me', role: 'user' } as unknown as Principal;
const observation: DeviceObservation = { inventory: 'a'.repeat(64), device: '/beds/0/devices/1', label: 'r1/dev-a', build: 'Toy_1_0_7', base: 'Toy_1_0_7', values: ['Toy_1_0_7'], observed_at: '2026-01-02T00:00:00.000Z', run: 'run_booking', job: null, reference: `src:${'b'.repeat(64)}` };

function contextWith(asked: string[]): EngineContext {
  return {
    deps: {
      leases: {
        registrations: async (prefix: string) => { asked.push(`registrations ${prefix}`); return [{ prefix: 'rig/r1/', owner: 'usr_me' }, { prefix: 'rig/r2/', owner: 'usr_other' }]; },
        view: async (prefix: string) => { asked.push(`view ${prefix}`); return { entries: [{ key: 'rig/r2/dev-a', since: '2026-01-01T00:00:00.000Z', until: null, run: 'run_other', user: 'usr_other' }, { key: 'rig/r1/dev-b', since: '2026-01-01T00:00:00.000Z', until: null, run: 'run_mine', user: 'usr_me' }] }; },
      },
      leaseJobs: async (keys: readonly string[]) => keys.includes('rig/r2/dev-a') ? [{ key: 'rig/r2/dev-a', job: 'job-1' }] : [],
      observations: { latest: async () => [observation], observe: async () => ({ observed: [], missing: null }) },
    },
  } as unknown as EngineContext;
}

test('the declared prefixes and observations of the listed packs, never the holder', async () => {
  const asked: string[] = [];
  const view = await packContext(contextWith(asked), me, [
    { pack: 'toy-book@1.0.0', run_context: { parts: ['leases', 'observations'], lease_prefix: 'rig/' } },
    { pack: 'toy-compile@2.0.0', run_context: { parts: ['leases'], lease_prefix: 'rig/' } },
    { pack: 'toy-review@1.0.0' },
  ]);
  assert.deepEqual(asked, ['registrations rig/', 'view rig/'], 'one read per prefix');
  assert.deepEqual(view, {
    leases: [{
      prefix: 'rig/',
      packs: ['toy-book@1.0.0', 'toy-compile@2.0.0'],
      registrations: [{ prefix: 'rig/r1/', mine: true }, { prefix: 'rig/r2/', mine: false }],
      held: [
        { key: 'rig/r2/dev-a', since: '2026-01-01T00:00:00.000Z', until: null, run: 'run_other', jobs: ['job-1'], mine: false },
        { key: 'rig/r1/dev-b', since: '2026-01-01T00:00:00.000Z', until: null, run: 'run_mine', jobs: [], mine: true },
      ],
    }],
    observations: [{ label: 'r1/dev-a', build: 'Toy_1_0_7', base: 'Toy_1_0_7', observed_at: '2026-01-02T00:00:00.000Z', packs: ['toy-book@1.0.0'] }],
  });
  assert.doesNotMatch(JSON.stringify(view), /usr_other|src:/, 'neither the holder nor the probe output');
});

test('no view when no listed pack declares a lease or observation context', async () => {
  const asked: string[] = [];
  assert.equal(await packContext(contextWith(asked), me, [{ pack: 'toy-review@1.0.0' }, { pack: 'toy-plan@1.0.0', run_context: { parts: ['builds'] } }]), null);
  assert.deepEqual(asked, []);
});
