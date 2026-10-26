import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { factsFields } from './conclude.ts';
import { bedOutcomes } from './check-bed.ts';
import { parseManifest } from './manifest.ts';
import project from './project.ts';
import { judgeBedSurface, parseBedSurface } from './surface.ts';

const declaration = JSON.parse(readFileSync(new URL('../../../product/famx/tables/bed-surface.json', import.meta.url), 'utf8')) as unknown;
const bed = {
  name: 'bed-a',
  devices: [{ name: 'node0', type: 'router', ipv4: ['192.0.2.1/24', '192.0.2.2/24'], ipv6: [] }],
  baseline: [],
};
const emptyAddress = { output: 'Interface       IP Address        Status\n', note: 'synthetic-clear-row' };
const emptySession = { output: 'Session-ID      Source                  Destination\n', note: '无配置' };
const dirtyAddress = { output: 'Interface       IP Address        Status\neth0            192.0.2.9/24      Up\n', note: '空' };
const dirtySession = { output: 'Session-ID      Source                  Destination\nleft            192.0.2.1               192.0.2.2\n', note: 'synthetic-confirm-clear' };

describe('bed surface declaration', () => {
  it('parses the product declaration and rejects an interactive cleanup with no exit', () => {
    const parsed = parseBedSurface(declaration);
    assert.equal(parsed.ok, true);
    const broken = structuredClone(declaration) as { probes: Array<{ cleanups: Array<Record<string, unknown>> }> };
    delete broken.probes[1].cleanups[0].exit;
    const refused = parseBedSurface(broken);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.problems.map((item) => item.message).join('\n'), /必须给出口/);
  });

  it('an empty header is not residue, even when neighbouring text names a cleanup', () => {
    const judged = judgeBedSurface(declaration, bed, [
      { id: 'addresses', value: emptyAddress },
      { id: 'sessions', value: emptySession },
    ]);
    assert.equal(judged.ok, true);
    if (!judged.ok) return;
    assert.equal(judged.occupancy, 'empty');
    assert.deepEqual(judged.residues, []);
    assert.equal(judged.cleanup, null);
  });

  it('a parsed extra row is residue and names the declared cleanup without running it', () => {
    const judged = judgeBedSurface(declaration, bed, [
      { id: 'addresses', value: dirtyAddress },
      { id: 'sessions', value: emptySession },
    ]);
    assert.equal(judged.ok, true);
    if (!judged.ok) return;
    assert.equal(judged.automatic, true);
    assert.deepEqual(judged.residues, [{ probe: 'addresses', field: 'address', identity: '192.0.2.9/24' }]);
    assert.deepEqual(judged.cleanup, [{ probe: 'addresses', seat: 'synthetic-0', command: 'synthetic-clear-row', granularity: 'row', identities: ['192.0.2.9/24'] }]);
  });

  it('interactive confirmation on a single-shot channel is not automatic and keeps the declared exit', () => {
    const judged = judgeBedSurface(declaration, bed, [
      { id: 'addresses', value: emptyAddress },
      { id: 'sessions', value: dirtySession },
    ]);
    assert.equal(judged.ok, true);
    if (!judged.ok) return;
    assert.equal(judged.automatic, false);
    assert.equal(judged.cleanup, null);
    assert.equal(judged.exits[0]?.owner, '合成管理员');
    assert.match(judged.exits[0]?.action ?? '', /确认/);
    assert.equal(judged.exits[0]?.deadline, '重新派发之前');
  });
});

describe('facts recompute the declaration', () => {
  const manifest = { schema: 'test-bed-manifest@1', beds: [{ ...bed, services: [], reserved: [] }] };

  it('supports a frozen judgment and refutes one that calls an empty header residue', () => {
    const input = {
      inputs: [{ slot: 'inventory', external: 'doc:doc:bed-topology', sha256: 'a'.repeat(64), media_type: 'application/json', parser: 'json@1', model: manifest, meta: null }],
      parameters: { action: 'facts' },
      context: {
        product: null, names: [], line: null, build: null, root: null,
        parameters: { action: 'facts' },
        groups: [],
        leases: { now: '2026-10-22T02:00:00.000Z', entries: [], registrations: [] },
        surface: declaration,
        probes: { addresses: emptyAddress, sessions: emptySession },
      },
    };
    const projected = project(input) as { items: Array<{ id: string; location: { selector: string }; fields: Record<string, unknown> }>; groups: Array<Record<string, unknown>> };
    const subject = {
      items: projected.items.map((item) => ({ id: item.id, location: `src:${'b'.repeat(64)}/json@1/${item.location.selector}`, fields: item.fields })),
      context: { groups: projected.groups },
    };
    assert.equal(bedOutcomes(subject)[0]?.verdict, 'support');
    const parsed = parseManifest(manifest);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(factsFields(parsed.beds, undefined, { declaration, probes: {} })[0]?.surface?.occupancy, 'unknown');
    const lied = structuredClone(subject) as { items: Array<{ fields: Record<string, unknown> }> };
    (lied.items[0].fields.surface as { occupancy: string }).occupancy = 'occupied';
    assert.equal(bedOutcomes(lied)[0]?.code, 'test-bed.facts_mismatch');
  });
});
