import { MINDMAP_CONTRACT_VERSION, MINDMAP_MAPPING_VERSION, MINDMAP_PACK_VERSION, MAX_SOURCE_BYTES,
  canonicalHash, canonicalJson, newId, requireCondition, sha256, type AuthContext, type Task } from '../../contracts/src/index.ts';
import type { Store, Transaction } from '../../storage/src/index.ts';
import type { Auth } from '../../tasks/src/auth.ts';
import type { ObjectStore } from './objects.ts';

export class Knowledge {
  store: Store; auth: Auth; objects: ObjectStore;
  constructor(store: Store, auth: Auth, objects: ObjectStore) { this.store = store; this.auth = auth; this.objects = objects; }
  sourceReference(row: Record<string, any>): any { return { sourceRevisionId: row.source_revision_id, sha256: row.sha256,
    size: Number(row.size), fileName: row.file_name, scopeId: row.scope_id }; }
  artifactReference(row: Record<string, any>): any { return { artifactId: row.artifact_id, sha256: row.sha256,
    size: Number(row.size), fileName: row.file_name, mediaType: row.media_type, downloadPath: `/v1/artifacts/${row.artifact_id}/content` }; }
  async upload(ctx: AuthContext, scopeId: string, fileName: string, bytes: Buffer): Promise<any> {
    requireCondition(bytes.length > 0,'INVALID_PAYLOAD','Source must be nonempty');
    requireCondition(bytes.length <= MAX_SOURCE_BYTES,'BODY_TOO_LARGE','Source must be at most 16 MiB');
    requireCondition(fileName.length > 0 && fileName.length <= 240 && !/[\x00-\x1f/\\]/.test(fileName), 'INVALID_PAYLOAD', 'Use a safe source basename');
    return this.store.transaction(async tx => {
      const policy = await this.auth.check(ctx, 'sources.write', scopeId, tx);
      const digest = sha256(bytes); await this.objects.putObject({ Bucket: 'evidence', Key: digest, Body: bytes });
      const row = (await tx.query(`INSERT INTO sources(source_revision_id,tenant_id,scope_id,principal_id,sha256,size,object_key,file_name)
        VALUES($1,$2,$3,$4,$5,$6,$5,$7) ON CONFLICT(tenant_id,scope_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING *`,
        [newId('src'), policy.tenantId, scopeId, policy.principalId, digest, bytes.length, fileName])).rows[0];
      await this.auth.audit(ctx, 'sources.upload', { sourceRevisionId: row.source_revision_id, sha256: digest, size: bytes.length }, scopeId, tx);
      return this.sourceReference(row);
    });
  }
  async source(ctx: AuthContext, id: string, scopeId?: string, tx?: Transaction): Promise<any> {
    const row = (await (tx ?? this.store.pool).query('SELECT * FROM sources WHERE source_revision_id=$1', [id])).rows[0];
    requireCondition(row, 'TARGET_NOT_FOUND', 'Source revision not found');
    const policy = await this.auth.check(ctx, 'sources.read', row.scope_id, tx);
    requireCondition(policy.tenantId === row.tenant_id && (!scopeId || row.scope_id === scopeId), 'FORBIDDEN_SCOPE', 'Source is outside the task partition');
    return this.sourceReference(row);
  }
  async sourceBytes(ctx: AuthContext, id: string, scopeId?: string, tx?: Transaction): Promise<{ reference: any; bytes: Buffer }> {
    const reference = await this.source(ctx, id, scopeId, tx);
    const bytes = await this.objects.getObject({ Bucket: 'evidence', Key: reference.sha256 });
    requireCondition(bytes.length === reference.size, 'SOURCE_HASH_MISMATCH', 'Source size differs'); return { reference, bytes };
  }
  async evidence(tx: Transaction, task: Task, operationId: string, kind: string, content: unknown, metadata: unknown = {}): Promise<any> {
    const bytes = Buffer.from(canonicalJson(content)); const digest = sha256(bytes);
    await this.objects.putObject({ Bucket: 'evidence', Key: digest, Body: bytes });
    const row = (await tx.query(`INSERT INTO evidence(evidence_id,tenant_id,scope_id,task_id,input_revision_id,operation_id,kind,sha256,size,object_key,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$10) ON CONFLICT(operation_id,kind) DO NOTHING RETURNING *`,
      [newId('evd'), task.tenantId, task.scopeId, task.taskId, task.inputRevisionId, operationId, kind, digest, bytes.length, JSON.stringify(metadata)])).rows[0]
      ?? (await tx.query('SELECT * FROM evidence WHERE operation_id=$1 AND kind=$2', [operationId, kind])).rows[0];
    return { evidenceId: row.evidence_id, kind: row.kind, sha256: row.sha256, size: Number(row.size), downloadPath: `/v1/evidence/${row.evidence_id}/content` };
  }
  async artifact(tx: Transaction, task: Task, sourceRevisionId: string, bytes: Buffer, metadata: Record<string, unknown>): Promise<any> {
    const source = await this.source({ principalId: task.principalId, tenantId: task.tenantId, kind: 'user' }, sourceRevisionId, task.scopeId, tx);
    const key = canonicalHash({ sourceSha256: source.sha256, packVersion: MINDMAP_PACK_VERSION,
      contractVersion: MINDMAP_CONTRACT_VERSION, mappingRulesVersion: MINDMAP_MAPPING_VERSION });
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([task.tenantId,task.scopeId,key])]);
    let row = (await tx.query('SELECT * FROM artifacts WHERE tenant_id=$1 AND scope_id=$2 AND compilation_key=$3', [task.tenantId, task.scopeId, key])).rows[0];
    if (!row) {
      const digest = sha256(bytes); await this.objects.putObject({ Bucket: 'evidence', Key: digest, Body: bytes });
      const fileName = `${source.fileName.replace(/\.(json|xmind)$/i, '')}.xlsx`;
      row = (await tx.query(`INSERT INTO artifacts(artifact_id,tenant_id,scope_id,source_revision_id,compilation_key,sha256,size,object_key,file_name,media_type,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$6,$8,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$9) RETURNING *`,
        [newId('art'),task.tenantId,task.scopeId,sourceRevisionId,key,digest,bytes.length,fileName,JSON.stringify(metadata)])).rows[0];
    }
    await tx.query('INSERT INTO artifact_bindings(task_id,input_revision_id,artifact_id,role) VALUES($1,$2,$3,\'workbook\') ON CONFLICT DO NOTHING',
      [task.taskId,task.inputRevisionId,row.artifact_id]);
    return this.artifactReference(row);
  }
  async content(ctx: AuthContext, kind: 'artifact' | 'evidence', id: string): Promise<{ reference: any; bytes: Buffer }> {
    const table = kind === 'artifact' ? 'artifacts' : 'evidence'; const column = kind === 'artifact' ? 'artifact_id' : 'evidence_id';
    const row = (await this.store.pool.query(`SELECT * FROM ${table} WHERE ${column}=$1`, [id])).rows[0];
    requireCondition(row, 'TARGET_NOT_FOUND', 'Object reference not found');
    const policy = await this.auth.check(ctx, 'evidence.read', row.scope_id);
    requireCondition(policy.tenantId === row.tenant_id, 'FORBIDDEN_SCOPE', 'Object belongs to a different tenant');
    const bytes = await this.objects.getObject({ Bucket: 'evidence', Key: row.object_key });
    return { reference: kind === 'artifact' ? this.artifactReference(row) : { sha256: row.sha256, size: Number(row.size), mediaType: 'application/json', fileName: `${id}.json` }, bytes };
  }
}
