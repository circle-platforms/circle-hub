// The inputs that accept the type of a source a run read (decision 113): `system:kind` of the external object compared by
// exact equality with each input's accepts, over the packs the reader may use. Synthetic packs only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PackSummary } from '../../contracts/src/run.ts';
import type { Principal } from '../records/api.ts';
import { acceptedBy } from './tools.ts';

const pack = (id: string, inputs: Array<{ slot: string; role: PackSummary['inputs'][number]['role']; accepts: string[] }>): PackSummary => ({
  pack: `${id}@1.0.0`, id, version: '1.0.0', kind: 'workflow', title: id, description: '合成', products: [], parameters: [], requirements: [],
  inputs: inputs.map((input) => ({ ...input, description: '合成', required: false, many: false })),
});
const packs = [
  pack('toy-read', [{ slot: 'bug', role: 'subject', accepts: ['toy:bug'] }]),
  pack('toy-cases', [{ slot: 'bugs', role: 'expected', accepts: ['toy:bug', 'toy:bug-list'] }, { slot: 'map', role: 'subject', accepts: ['application/json'] }]),
  pack('toy-other', [{ slot: 'story', role: 'expected', accepts: ['toy:story'] }]),
];
const deps = { workflows: { summaries: async () => packs } } as unknown as Parameters<typeof acceptedBy>[0];
const answer = (externals: Array<string | null>) => ({ call_result: 'ok', errors: [], run: { sources: externals.map((external) => ({ external })) } }) as unknown as Parameters<typeof acceptedBy>[2];

test('every input of the reader’s packs whose accepts names the source type exactly', async () => {
  assert.deepEqual(await acceptedBy(deps, {} as Principal, answer(['toy:bug:4545', 'toy:bug:4646@3', null])), [
    { type: 'toy:bug', inputs: [{ pack: 'toy-read@1.0.0', slot: 'bug', role: 'subject' }, { pack: 'toy-cases@1.0.0', slot: 'bugs', role: 'expected' }] },
  ]);
  assert.deepEqual(await acceptedBy(deps, {} as Principal, answer(['toy:bugs:1', 'toy:mindmap:7'])), [], 'no prefix or similar-name match');
  assert.deepEqual(await acceptedBy(deps, {} as Principal, answer([])), []);
});
