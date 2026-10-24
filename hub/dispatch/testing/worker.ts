import {effectsDocument} from './effects.ts';
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
  const proof=detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any;
  const parameters={target:proof.bed.id,manifest_sha256:proof.bed.manifest_sha256,build:proof.build,sha256:proof.sha256,items:proof.autoids,generator:proof.generator};
  const document=effectsDocument(parameters);
  if(typeof input.repetition==='number')(document.effects[0] as {repetition?:number}).repetition=input.repetition;
  const service = new DispatchService({ beforeRound:typeof input.haltBeforeRound==='number'?async round=>{if(round>=input.haltBeforeRound)process.exit(86);}:undefined,recheckChecks:async({checks})=>Object.fromEntries(checks.map(id=>[id,[{verdict:'support',statement:'合成政策支持',grounds:[],tier:'blocking'}]])),records: kit, leases: new LeaseService(db, { now: async () => now() }),
    runs: { getRun: async (_by, id) => id === detail.run.run ? detail : id === detail.run.predecessor ? { ...detail, run: { ...detail.run, run: id, predecessor: undefined } } : null },
    workflows: { byDigest: async () => ({ pack: { id: 'synthetic-workflow', version: '1.0.0', digest: detail.run.pack_digest }, requirements: [{ key: 'workbook_verified', required: true, target: 'item', accepted_producer: 'fact' }],readJson:async()=>document } as unknown as LoadedWorkflow) }, now });
  if (process.send) { process.send({ ready: true }); await new Promise(resolve => process.once('message', resolve)); }
  const result = await service.dispatch(input.admin, detail.run.run, input.executor);
  process.stdout.write(JSON.stringify({ job: result.job, outcome: result.outcome, frozen: result.frozen }));
  process.exitCode = result.outcome === 'effective' ? 0 : 1;
} catch { process.stdout.write(JSON.stringify({ stopped: true })); process.exitCode = 1; }
finally { await db.end(); await kit.close(); process.disconnect?.(); }
