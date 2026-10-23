// Synthetic child-process harness; credentials and database locations arrive over stdin, never argv or stdout.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRecords } from '../../records/index.ts';
import { FileKeyProvider } from '../../records/api.ts';
import { Database, createPool } from '../../records/db.ts';
import { LeaseService } from '../../leases/api.ts';
import { DispatchService } from '../api.ts';
import type { RunDetail, LoadedWorkflow } from '../../ports.ts';
const input = JSON.parse(readFileSync(0, 'utf8'));
const now = () => new Date(input.now);
const kit = await openRecords(input.config, { migrate: false, keyProvider: new FileKeyProvider(join(input.config.dataDir, 'test-vault.key')), now });
const db = new Database(createPool(input.config.database, 2));
try {
  const detail = input.detail as RunDetail;
  const service = new DispatchService({ records: kit, leases: new LeaseService(db, { now: async () => now() }),
    runs: { getRun: async (_by, id) => id === detail.run.run ? detail : id === detail.run.predecessor ? { ...detail, run: { ...detail.run, run: id, predecessor: undefined } } : null },
    workflows: { byDigest: async () => ({ pack: { id: 'synthetic-workflow', version: '1.0.0', digest: detail.run.pack_digest }, requirements: [{ key: 'workbook_verified', required: true, target: 'item', accepted_producer: 'fact' }] } as unknown as LoadedWorkflow) }, now });
  if (process.send) { process.send({ ready: true }); await new Promise(resolve => process.once('message', resolve)); }
  const result = await service.dispatch(input.admin, detail.run.run, input.executor);
  process.stdout.write(JSON.stringify({ job: result.job, outcome: result.outcome, frozen: result.frozen }));
  process.exitCode = result.outcome === 'effective' ? 0 : 1;
} catch { process.stdout.write(JSON.stringify({ stopped: true })); process.exitCode = 1; }
finally { await db.end(); await kit.close(); process.disconnect?.(); }
