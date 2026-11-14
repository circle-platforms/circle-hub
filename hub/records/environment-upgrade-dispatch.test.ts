// A real temporary PostgreSQL and a loopback executor. Compilation/results are scripted; no model or business device is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createPackRegistry, createWorkflowStore } from '../runs/api.ts';
import { workflowPack, writePack, temporaryDirectory } from '../runs/packs/testing/builder.ts';
import { DispatchService } from '../dispatch/service.ts';
import { setupOwned } from '../dispatch/testing/owned.ts';
import { grantLeases } from '../runs/engine/start.ts';
import type { EngineContext } from '../runs/engine/deps.ts';
import { newId } from './ids.ts';
import { previewEnvironmentAssignmentUpgrade, applyEnvironmentAssignmentUpgrade, requireEnvironmentAssignmentActivation } from './environment-assignment-upgrade.ts';
import { environmentAssignmentUpgradeSources } from '../server/environment-assignment-upgrade-sources.ts';

function refuseNoAssignment(error: unknown): boolean {
  return error instanceof Error && 'errors' in error && Array.isArray(error.errors)
    && error.errors[0]?.code === 'SOURCE_NOT_PERMITTED' && /没有分配/.test(error.errors[0]?.message ?? '');
}

test('a compilation already booked before upgrade renews and reaches the executor after preservation; later revocation rejects the next booking', { timeout: 180000 }, async t => {
  const c = await setupOwned();
  await c.service.close();
  c.service = new DispatchService(Object.assign({}, c.service.options, { enforceEnvironmentAssignments: true }));
  let packDirectory: Awaited<ReturnType<typeof temporaryDirectory>> | undefined;
  t.after(async () => {
    try { await c.service.close(); }
    finally { try { await packDirectory?.remove(); } finally { await c.close(); } }
  });
  packDirectory = await temporaryDirectory('circle-hub-upgrade-booking-');
  // Place the synthetic old instance at its actual current clock before taking its pre-upgrade booking.
  c.clock.ms = Date.now();
  c.detail.run.started_at = c.now().toISOString();
  const bookingRun = c.detail.run.predecessor;
  assert.ok(bookingRun);
  const definition = (await c.registry.readSource(c.executor.id))!.source;
  const keys = [...definition.resources];
  const booked = await c.leases.acquire({ keys, prefix: 'synthetic/', ttlSeconds: 900, maxTtlSeconds: 3600, holder: { user: c.owner.id, run: bookingRun } });
  assert.ok(booked.ok, JSON.stringify(booked));

  const registry = createPackRegistry({ records: c.kit, extractDir: join(packDirectory.path, 'extracted'), sandbox: { requireOsIsolation: false } });
  await c.kit.authorizations.grantPublishRight(c.admin, c.admin.id);
  const spec = workflowPack({ id: 'synthetic-existing-booking-method', product: { catalogs: [] } });
  spec.files['workflow.json'] = { ...spec.files['workflow.json'] as Record<string, unknown>, context: ['leases'], leases: { prefix: 'synthetic/', max_ttl_seconds: 3600 } };
  const written = await writePack(join(packDirectory.path, 'source'), spec);
  const published = await registry.publish(c.admin, written.dir);
  assert.ok(published.ok, JSON.stringify(published));
  await registry.assign(c.admin, c.owner.id, spec.id);
  const workflow = await createWorkflowStore(registry).forUser(c.owner, spec.id);
  assert.ok(workflow);

  // The shared dispatch fixture seeds a post-N2 team grant. Remove only that seed to represent the legacy policy.
  await c.kit.authorizations.unassignResource(c.admin, c.executor.id, c.environmentTeam.id);
  assert.equal(await c.environmentAccess.canUse(c.owner, c.executor.id), false);
  // Recreate exactly the known previous receipt set in this isolated fixture, not in production.
  await c.db.transaction(async tx => {
    await c.db.query('DROP TABLE public.environment_assignment_completion,public.environment_assignment_snapshot,public.environment_assignment_cutover,public.hub_migration_compatibility', [], tx);
    await c.db.query('DELETE FROM public.schema_migrations WHERE version=2', [], tx);
  });
  const before = (await c.db.query('SELECT * FROM public.leases ORDER BY key')).rows;
  const acceptedCompilation = c.detail.latest;
  assert.ok(acceptedCompilation);
  c.detail.latest = null;
  assert.equal(c.calls.includes('send_blob'), false, 'compilation has not dispatched anything before the upgrade');
  const config = { database: c.kit.database, dataDir: c.kit.dataDir, limits: c.kit.config.limits };
  const sources = environmentAssignmentUpgradeSources();
  const preview = await previewEnvironmentAssignmentUpgrade(config, c.admin, sources);
  assert.equal(preview.canApply, true, preview.problems.join(';'));
  assert.deepEqual(preview.payload?.plan.grants.map(row => [row.user, row.executor]), [[c.owner.id, c.executor.id]]);
  assert.deepEqual(preview.payload?.plan.grants[0].holdingRuns, [], 'legacy workflow entitlement is sufficient; no executor ownership is guessed for the booking');
  assert.equal((await applyEnvironmentAssignmentUpgrade(config, c.admin, sources, preview)).grants, 1);
  await requireEnvironmentAssignmentActivation(c.db, c.kit.store);
  assert.deepEqual((await c.db.query('SELECT * FROM public.leases ORDER BY key')).rows, before, 'upgrade changes neither old lease bytes nor its expiry');
  assert.equal(await c.environmentAccess.authorizeKeys(c.owner, keys), null);
  assert.ok((await c.leases.extend({ keys, holder: { user: c.owner.id, run: bookingRun }, ttlSeconds: 1800, maxTtlSeconds: 3600 })).ok);

  c.detail.latest = acceptedCompilation;
  const dispatched = await c.service.dispatchAccepted(c.run);
  assert.equal(dispatched.started, true, JSON.stringify(dispatched));
  assert.equal(dispatched.executor, c.executor.id);
  assert.equal(dispatched.status?.outcome, 'effective', JSON.stringify(dispatched));
  assert.equal(c.calls.filter(call => call === 'send_blob').length, 1);
  assert.ok(dispatched.status?.result, 'the real loopback executor result is retained');
  const result = await c.report(dispatched.status!.result!);
  assert.equal(result.rows[0]?.dynamic_terminal, 'pass', JSON.stringify(result));

  await c.kit.authorizations.unassignResource(c.admin, c.executor.id, c.owner.id);
  const afterDispatch = (await c.db.query('SELECT * FROM public.leases ORDER BY key')).rows;
  const admission = { now: c.now, deps: { enforceEnvironmentAssignments: true, leases: c.leases, environmentAccess: c.environmentAccess } } as EngineContext;
  await assert.rejects(grantLeases(admission, c.owner, workflow, [{ keys, ttl_seconds: 60 }], newId('run'), undefined), refuseNoAssignment);
  assert.deepEqual((await c.db.query('SELECT * FROM public.leases ORDER BY key')).rows, afterDispatch, 'the rejected new booking does not mutate the held lease');
  assert.equal((await applyEnvironmentAssignmentUpgrade(config, c.admin, sources, preview)).alreadyCompleted, true);
  assert.equal(await c.environmentAccess.canUse(c.owner, c.executor.id), false);
  assert.equal(c.calls.filter(call => call === 'send_blob').length, 1, 'revocation or startup replay cannot redispatch the old compilation');
});
