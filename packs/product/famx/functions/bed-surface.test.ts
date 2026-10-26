import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { judgeBedSurface, parseBedSurface } from '../../../workflow/test-bed/api.ts';

const declaration = JSON.parse(readFileSync(new URL('../tables/bed-surface.json', import.meta.url), 'utf8')) as unknown;
const bed = { name: 'bed-a', devices: [{ ipv4: ['192.0.2.1/24'], ipv6: [] }], baseline: [] };

test('the product bed declaration is the synthetic probe and cleanup table', () => {
  const parsed = parseBedSurface(declaration);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.declaration.probes.map((probe) => probe.cleanups.map((cleanup) => cleanup.command)), [['synthetic-clear-row'], ['synthetic-confirm-clear']]);
  const clean = judgeBedSurface(declaration, bed, [
    { id: 'addresses', value: { header: ['address'], rows: [] } },
    { id: 'sessions', value: { header: ['name'], rows: [] } },
  ]);
  assert.equal(clean.ok && clean.residues.length, 0);
  const residue = judgeBedSurface(declaration, bed, [
    { id: 'addresses', value: { header: ['address'], rows: [{ address: '192.0.2.9/24' }] } },
    { id: 'sessions', value: { header: ['name'], rows: [] } },
  ]);
  assert.equal(residue.ok && residue.automatic, true);
  const blocked = judgeBedSurface(declaration, bed, [
    { id: 'addresses', value: { header: ['address'], rows: [] } },
    { id: 'sessions', value: { header: ['name'], rows: [{ name: 'left' }] } },
  ]);
  assert.equal(blocked.ok && blocked.automatic, false);
  if (blocked.ok) assert.equal(blocked.cleanup, null);
});
