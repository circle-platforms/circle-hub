import assert from 'node:assert/strict';
import project from '../../test-bed/functions/project.ts';

export function testBedProjection(args: Record<string, unknown>) {
  assert.equal(args.pack, 'test-bed');
  const { inventory } = args.inputs as { inventory: { external: string } };
  assert.ok(['doc:doc:bed-topology', 'doc:doc:other-topology'].includes(inventory.external));
  const parameters = args.parameters as { booking: string; action: string };
  assert.equal(args.predecessor, parameters.booking);
  const model = { schema: 'test-bed-manifest@1', beds: [{
    name: 'bed-a', devices: [{ name: 'dev0', type: 'load-balancer', ipv4: ['192.0.2.10/26'], ipv6: [] }], services: [], reserved: [],
  }] };
  const output = project({
    inputs: [{ slot: 'inventory', external: inventory.external, parser: 'json@1', sha256: 'a'.repeat(64), model }],
    parameters, context: { leases: { now: '2026-10-22T02:00:00.000Z', entries: [{ key: 'bed/bed-a/dev0', until: null, mine: true }] } },
  });
  assert.ok(!('error' in output), JSON.stringify(output));
  assert.deepEqual(output.items.map(row => row.fields.action), [parameters.action]);
  return output;
}
