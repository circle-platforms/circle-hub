// Reuses the dispatch package's existing decision over exactly indexed, integrity-checked old journal events.
import { holdsPhysicalTarget } from '../../dispatch/api.ts';
import { recordDigest } from '../../records/api.ts';
import type { SqlSession } from '../sql.ts';
import { canonicalOldBody, fields, type UpgradeIssue } from './state.ts';

type Event = Parameters<typeof holdsPhysicalTarget>[0][number];
export async function remoteUpgradeIssues(source: SqlSession): Promise<UpgradeIssue[]> {
  const rows = await source.query(`SELECT i.value AS indexed_job,r.seq::text,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
    FROM record_index i JOIN hub_read_records() r ON r.digest=i.digest
    WHERE i.key='dispatch.job' ORDER BY r.seq`);
  const grouped = new Map<string, Event[]>(), issues: UpgradeIssue[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      const body = fields(canonicalOldBody(String(row.body)));
      const detail = fields(body.detail);
      if (row.kind !== 'action' || row.schema !== 'action@1' || body.component !== 'dispatch@1' || typeof row.indexed_job !== 'string' || detail.job !== row.indexed_job || typeof detail.phase !== 'string') throw new Error();
      const envelope = { kind: String(row.kind), schema: String(row.schema), provenance: String(row.provenance), created_at: (row.created_at as Date).toISOString(), body };
      if (recordDigest(envelope) !== row.digest) throw new Error();
      const events = grouped.get(row.indexed_job) ?? [];
      events.push({ ...envelope, id: String(row.id), digest: String(row.digest) } as Event);
      grouped.set(row.indexed_job, events);
    } catch { issues.push({ table: 'dispatch_journal', row: index + 1, reason: '作业索引、模式或完整性不符，远端状态未知' }); }
  }
  let ordinal = 0;
  for (const events of grouped.values()) {
    ordinal++;
    if (holdsPhysicalTarget(events)) issues.push({ table: 'dispatch_journal', row: ordinal, reason: '远端作业仍占用或效果未知，停止本地服务不能证明远端已停' });
  }
  return issues;
}
